//! The X focus guardian: input focus must never point at nothing.
//!
//! # The failure this exists for
//!
//! Wine decides whether a game is the foreground window from X focus, and a
//! Windows game that believes it is backgrounded ignores the controller
//! entirely. During window churn (a launcher spawning and killing windows, a
//! session reconnecting), the X server's input focus can end up on the void:
//! `GetInputFocus` returns `None`, no window anywhere is focused, and the
//! compositor's own bookkeeping still names a focused window it believes is
//! fine. Caught live, twice: the game dead to a working controller, and one
//! manual `SetInputFocus` bringing it back instantly.
//!
//! # Why a separate X connection
//!
//! Smithay's WM only issues `SetInputFocus` from the keyboard *enter*
//! handler, and offers no way to ask the server what focus currently is. A
//! tiny client connection of our own can ask and repair directly, which is
//! precisely what the manual fix did.
//!
//! # What it will never do
//!
//! Fight a real window. The guardian repairs only the two void states
//! (`None` and `PointerRoot`); a menu, a popup, or any actual window holding
//! focus is left alone.

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt as _, InputFocus};
use x11rb::rust_connection::RustConnection;

/// `GetInputFocus` special values: nothing and pointer-root.
const FOCUS_NONE: u32 = 0;
const FOCUS_POINTER_ROOT: u32 = 1;

pub struct Guardian {
    display: String,
    conn: Option<RustConnection>,
}

impl Guardian {
    pub fn new(display_number: u32) -> Self {
        Self {
            display: format!(":{display_number}"),
            conn: None,
        }
    }

    fn conn(&mut self) -> Option<&RustConnection> {
        if self.conn.is_none() {
            match RustConnection::connect(Some(&self.display)) {
                Ok((conn, _)) => self.conn = Some(conn),
                Err(err) => {
                    tracing::debug!("focus guardian cannot reach {}: {err}", self.display);
                    return None;
                }
            }
        }
        self.conn.as_ref()
    }

    /// Point the input focus at `expected` if it currently points at nothing.
    pub fn ensure(&mut self, expected: u32) {
        let Some(conn) = self.conn() else { return };

        let focus = conn
            .get_input_focus()
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.focus);
        let Some(focus) = focus else {
            // A dead connection (Xwayland restarted); rebuilt next tick.
            self.conn = None;
            return;
        };
        if focus != FOCUS_NONE && focus != FOCUS_POINTER_ROOT {
            return;
        }

        let repaired = conn
            .set_input_focus(InputFocus::PARENT, expected, x11rb::CURRENT_TIME)
            .is_ok()
            && conn.flush().is_ok();
        if repaired {
            tracing::info!("X input focus was on nothing; repaired to 0x{expected:x}");
        } else {
            self.conn = None;
        }
    }
}
