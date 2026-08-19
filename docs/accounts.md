# Accounts and permissions

The engine has one shared password (`AUTH_PASS`) and named users as well.
Everyone who knows the shared password can do everything, and handing somebody a
link so they can *watch* should not also let them run commands.

Accounts live in SQLite on the machine they authenticate for, at
`$XDG_STATE_HOME/lwfa/accounts.db`. There is no control plane to enrol with and
nothing to be offline from. Passwords are Argon2id with a per-user salt.

Each account has a **mode** (watch only, or interact) and a list of applications
it may launch. `AUTH_PASS` means **the owner**: the bootstrap credential, the
only identity that may administer accounts, and the way back in if the last
named account locks itself out. Manage them in the Access panel.

Enforcement is in the engine, at the single point every shell message passes
through. The shell greys out what it cannot use, which is a courtesy rather than
a control: anyone can open a socket and send whatever they like.

A watch-only session gets no clipboard either. It cannot paste into the machine,
and a running list of everything the owner copies is the last thing to hand
somebody lent a screen. Taking the keys back takes the clipboard with them.

## Saved connections are the opposite

Which machines *you* care about is a property of the device in your hand, so the
connection list lives in the browser. Storing it on a machine would mean that
machine being switched off loses you the list of the others.

## Next

- [Reaching lwfa from another device](remote-access.md)
- [The shell](shell.md)
