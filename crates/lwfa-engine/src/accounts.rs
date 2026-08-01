//! Who may connect, and what they are allowed to do.
//!
//! # Why there is a database at all
//!
//! Until now the engine had one shared password and everyone who knew it could
//! do everything: inject keystrokes, spawn processes, close windows. That is
//! fine for one person on their own LAN and wrong for anything else. Handing
//! somebody a link so they can *watch* should not also let them run commands.
//!
//! So: named accounts, each with a mode and a list of applications it may
//! launch. SQLite because this is a handful of rows that must survive a restart
//! and be editable while the compositor runs; anything larger would be a
//! service to keep alive, and a flat file would need its own locking the first
//! time two requests arrived together.
//!
//! # Per engine, not central
//!
//! Each machine owns its own accounts. There is no control plane to enrol with,
//! nothing to be offline from, and a machine that is switched off simply cannot
//! be connected to. The browser remembers *which machines* it knows about; that
//! list is per device and lives in the browser, because it is a bookmark rather
//! than a permission.
//!
//! # Passwords
//!
//! Argon2id, with a per-user salt, through the `password-hash` crate's standard
//! encoding. Not because the threat model demands it here, but because the one
//! thing a database of passwords must never be is a database of passwords.
//!
//! `AUTH_PASS` still works and still means "the owner": it is the bootstrap
//! credential, so a fresh install is usable before any account exists, and the
//! account that locks itself out has a way back in.

use std::path::{Path, PathBuf};

use argon2::Argon2;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rusqlite::{Connection, OptionalExtension, params};

use lwfa_proto::{Permissions, SessionMode};

/// A row from `users`, minus the hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub permissions: Permissions,
}

pub struct Accounts {
    db: Connection,
}

/// What a connection turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    /// Authenticated with `AUTH_PASS`. Everything is permitted.
    Owner,
    /// Matched a named account.
    User(Account),
}

impl Identity {
    pub fn permissions(&self) -> Permissions {
        match self {
            Self::Owner => Permissions::owner(),
            Self::User(account) => account.permissions.clone(),
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Owner => "owner",
            Self::User(account) => &account.name,
        }
    }
}

impl Accounts {
    /// Open, or create, the database beside the config.
    pub fn open() -> rusqlite::Result<Self> {
        let path = database_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let db = Connection::open(&path)?;
        Self::from_connection(db)
    }

    fn from_connection(db: Connection) -> rusqlite::Result<Self> {
        // WAL so a read while the compositor is writing does not block the
        // render loop, and foreign keys because they are off by default in
        // SQLite and silently do nothing if you forget.
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.execute_batch(SCHEMA)?;
        Ok(Self { db })
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    /// Every account, oldest first.
    pub fn list(&self) -> rusqlite::Result<Vec<Account>> {
        let mut statement = self
            .db
            .prepare("SELECT id, name, mode, allowed_apps FROM users ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                name: row.get(1)?,
                permissions: permissions_from(
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ),
            })
        })?;
        rows.collect()
    }

    /// Create an account. Fails if the name is taken.
    pub fn create(
        &self,
        name: &str,
        password: &str,
        permissions: &Permissions,
    ) -> Result<Account, AccountError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AccountError::EmptyName);
        }
        if password.is_empty() {
            return Err(AccountError::EmptyPassword);
        }
        let hash = hash_password(password)?;
        let (mode, apps) = permissions_to(permissions);

        self.db
            .execute(
                "INSERT INTO users (name, hash, mode, allowed_apps) VALUES (?1, ?2, ?3, ?4)",
                params![name, hash, mode, apps],
            )
            .map_err(|err| match err {
                rusqlite::Error::SqliteFailure(e, _) if e.extended_code == 2067 => {
                    AccountError::NameTaken
                }
                other => AccountError::Db(other),
            })?;

        Ok(Account {
            id: self.db.last_insert_rowid(),
            name: name.to_string(),
            permissions: permissions.clone(),
        })
    }

    pub fn set_permissions(&self, id: i64, permissions: &Permissions) -> rusqlite::Result<()> {
        let (mode, apps) = permissions_to(permissions);
        self.db.execute(
            "UPDATE users SET mode = ?1, allowed_apps = ?2 WHERE id = ?3",
            params![mode, apps, id],
        )?;
        Ok(())
    }

    pub fn set_password(&self, id: i64, password: &str) -> Result<(), AccountError> {
        if password.is_empty() {
            return Err(AccountError::EmptyPassword);
        }
        let hash = hash_password(password)?;
        self.db.execute(
            "UPDATE users SET hash = ?1 WHERE id = ?2",
            params![hash, id],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: i64) -> rusqlite::Result<()> {
        self.db
            .execute("DELETE FROM users WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Find the account a password belongs to, if any.
    ///
    /// Every account is tried, because the password is all the browser sends:
    /// there is no username field on a bookmarked URL. That makes login cost
    /// one Argon2 verification per account, which is the point of Argon2 and is
    /// irrelevant at the scale of a household.
    pub fn authenticate(&self, password: &str) -> Option<Account> {
        let accounts = self.list().ok()?;
        for account in accounts {
            let hash: Option<String> = self
                .db
                .query_row(
                    "SELECT hash FROM users WHERE id = ?1",
                    params![account.id],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten();
            let Some(hash) = hash else { continue };
            if verify(password, &hash) {
                return Some(account);
            }
        }
        None
    }

    pub fn count(&self) -> rusqlite::Result<i64> {
        self.db
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    hash          TEXT NOT NULL,
    -- 'view' or 'interact'. Stored as text so a dump is readable and an added
    -- mode does not silently renumber the existing rows.
    mode          TEXT NOT NULL,
    -- NULL means every application. A JSON array of desktop ids otherwise.
    allowed_apps  TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
";

#[derive(Debug)]
pub enum AccountError {
    EmptyName,
    EmptyPassword,
    NameTaken,
    Hash(argon2::password_hash::Error),
    Db(rusqlite::Error),
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyName => write!(f, "a name is required"),
            Self::EmptyPassword => write!(f, "a password is required"),
            Self::NameTaken => write!(f, "that name is already taken"),
            Self::Hash(err) => write!(f, "could not hash the password: {err}"),
            Self::Db(err) => write!(f, "database error: {err}"),
        }
    }
}

impl std::error::Error for AccountError {}

impl From<rusqlite::Error> for AccountError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Db(err)
    }
}

fn hash_password(password: &str) -> Result<String, AccountError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(AccountError::Hash)
}

fn verify(password: &str, encoded: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(encoded) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

fn permissions_from(mode: String, apps: Option<String>) -> Permissions {
    Permissions {
        mode: if mode == "interact" {
            SessionMode::Interact
        } else {
            SessionMode::View
        },
        // A malformed list means "no applications", not "all of them". Failing
        // closed is the only safe direction for a permission.
        allowed_apps: apps.map(|json| serde_json::from_str(&json).unwrap_or_default()),
    }
}

fn permissions_to(permissions: &Permissions) -> (String, Option<String>) {
    let mode = match permissions.mode {
        SessionMode::Interact => "interact",
        SessionMode::View => "view",
    };
    let apps = permissions
        .allowed_apps
        .as_ref()
        .map(|list| serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string()));
    (mode.to_string(), apps)
}

/// Where the database lives. `LWFA_DB` overrides it, which is what the tests
/// and a packaged install would use.
fn database_path() -> PathBuf {
    if let Some(explicit) = std::env::var_os("LWFA_DB") {
        return PathBuf::from(explicit);
    }
    if let Some(dir) = std::env::var_os("XDG_STATE_HOME") {
        return Path::new(&dir).join("lwfa/accounts.db");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Path::new(&home).join(".local/state/lwfa/accounts.db");
    }
    PathBuf::from("lwfa-accounts.db")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view_only() -> Permissions {
        Permissions {
            mode: SessionMode::View,
            allowed_apps: Some(vec![]),
        }
    }

    #[test]
    fn a_created_account_can_authenticate() {
        let accounts = Accounts::in_memory().unwrap();
        accounts.create("guest", "hunter2", &view_only()).unwrap();

        let found = accounts.authenticate("hunter2").expect("should match");
        assert_eq!(found.name, "guest");
        assert_eq!(found.permissions.mode, SessionMode::View);
        assert!(accounts.authenticate("hunter3").is_none());
    }

    #[test]
    fn the_password_is_not_stored() {
        // The single property this module exists to guarantee.
        let accounts = Accounts::in_memory().unwrap();
        accounts.create("guest", "hunter2", &view_only()).unwrap();
        let hash: String = accounts
            .db
            .query_row("SELECT hash FROM users", [], |row| row.get(0))
            .unwrap();
        assert!(
            !hash.contains("hunter2"),
            "the plaintext must not be in the row"
        );
        assert!(
            hash.starts_with("$argon2"),
            "expected an argon2 hash, got {hash}"
        );
    }

    #[test]
    fn two_accounts_with_the_same_password_get_different_hashes() {
        // i.e. the salt is per user, so one cracked hash does not reveal that
        // another account shares the password.
        let accounts = Accounts::in_memory().unwrap();
        accounts.create("a", "same", &view_only()).unwrap();
        accounts.create("b", "same", &view_only()).unwrap();
        let mut statement = accounts.db.prepare("SELECT hash FROM users").unwrap();
        let hashes: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_ne!(hashes[0], hashes[1]);
    }

    #[test]
    fn names_are_unique() {
        let accounts = Accounts::in_memory().unwrap();
        accounts.create("guest", "a", &view_only()).unwrap();
        assert!(matches!(
            accounts.create("guest", "b", &view_only()),
            Err(AccountError::NameTaken)
        ));
    }

    #[test]
    fn permissions_survive_a_round_trip() {
        let accounts = Accounts::in_memory().unwrap();
        let permissions = Permissions {
            mode: SessionMode::Interact,
            allowed_apps: Some(vec!["firefox".into(), "org.gnome.Nautilus".into()]),
        };
        let made = accounts.create("dev", "pw", &permissions).unwrap();
        let read = accounts.list().unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].permissions, permissions);

        accounts.set_permissions(made.id, &view_only()).unwrap();
        assert_eq!(accounts.list().unwrap()[0].permissions, view_only());
    }

    #[test]
    fn none_means_every_application() {
        let accounts = Accounts::in_memory().unwrap();
        let all = Permissions {
            mode: SessionMode::Interact,
            allowed_apps: None,
        };
        accounts.create("full", "pw", &all).unwrap();
        assert_eq!(accounts.list().unwrap()[0].permissions.allowed_apps, None);
    }

    #[test]
    fn a_corrupt_app_list_permits_nothing() {
        // Failing closed: a permission that cannot be read must not become
        // "allow everything".
        let accounts = Accounts::in_memory().unwrap();
        accounts.create("x", "pw", &view_only()).unwrap();
        accounts
            .db
            .execute("UPDATE users SET allowed_apps = 'not json'", [])
            .unwrap();
        assert_eq!(
            accounts.list().unwrap()[0].permissions.allowed_apps,
            Some(vec![]),
        );
    }

    #[test]
    fn empty_credentials_are_refused() {
        let accounts = Accounts::in_memory().unwrap();
        assert!(matches!(
            accounts.create("  ", "pw", &view_only()),
            Err(AccountError::EmptyName)
        ));
        assert!(matches!(
            accounts.create("name", "", &view_only()),
            Err(AccountError::EmptyPassword)
        ));
    }
}
