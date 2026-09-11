//! Publication of the active managed X11 toplevel.
use super::{Atoms, X11Surface};
use x11rb::{
    errors::ReplyError,
    protocol::xproto::{
        AtomEnum, ChangeWindowAttributesAux, ConnectionExt as _, EventMask, PropMode, Window,
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};

pub(super) fn watch(conn: &RustConnection, window: Window) -> Result<(), x11rb::errors::ConnectionError> {
    // Root focus events alone miss transitions between sibling clients.
    conn.change_window_attributes(
        window,
        &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE | EventMask::FOCUS_CHANGE),
    )?;
    Ok(())
}

pub(super) fn update(
    conn: &RustConnection,
    root: Window,
    atoms: &Atoms,
    windows: &[X11Surface],
) -> Result<(), ReplyError> {
    // Events can name ancestors, or refer to a focus owner that has already
    // changed again. Query the server instead of publishing the event window.
    // This never changes keyboard focus and is independent of layout policy.
    let focus = conn.get_input_focus()?.reply()?.focus;
    let active = toplevel(conn, root, windows, focus)?;
    let property = conn
        .get_property(false, root, atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW, 0, 1)?
        .reply()?;
    if property.value32().and_then(|mut values| values.next()) != Some(active) {
        conn.change_property32(
            PropMode::REPLACE,
            root,
            atoms._NET_ACTIVE_WINDOW,
            AtomEnum::WINDOW,
            &[active],
        )?
        .check()?;
    }
    Ok(())
}

fn toplevel(
    conn: &RustConnection,
    root: Window,
    windows: &[X11Surface],
    mut focus: Window,
) -> Result<Window, ReplyError> {
    // Bound both parent traversal and malformed transient cycles. Resolve
    // children to their managed toplevel and OR menus to their transient owner.
    let mut visited = Vec::new();
    while focus > 1 && focus != root && visited.len() < 64 && !visited.contains(&focus) {
        visited.push(focus);
        if let Some(surface) = windows.iter().find(|surface| surface.window_id() == focus) {
            if !surface.is_override_redirect() {
                return Ok(focus);
            }
            if let Some(owner) = surface.is_transient_for() {
                focus = owner;
                continue;
            }
        }
        // A focus target can disappear between GetInputFocus and QueryTree.
        // Leave publication to the subsequent server event on query failure.
        focus = conn.query_tree(focus)?.reply()?.parent;
    }
    Ok(x11rb::NONE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        sync::Arc,
    };
    use x11rb::{
        connection::Connection,
        protocol::xproto::{ConnectionExt as _, CreateWindowAux, EventMask, InputFocus, WindowClass},
    };
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    #[ignore = "run scripts/test-xwm-focus.mjs; requires isolated Xvfb"]
    fn publishes_actual_toplevel_without_changing_focus() {
        for name in ["mnt", "net"] {
            let parent = std::env::var(format!("LWFA_TEST_PARENT_{}", name.to_uppercase()))
                .expect("use the sandbox runner");
            assert_ne!(
                std::fs::read_link(format!("/proc/self/ns/{name}")).unwrap(),
                std::path::PathBuf::from(parent)
            );
        }
        let mut server = Server(
            Command::new("/run/Xvfb")
                .args([
                    "-displayfd",
                    "1",
                    "-screen",
                    "0",
                    "320x240x24",
                    "-nolisten",
                    "tcp",
                    "-extension",
                    "GLX",
                ])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut display = String::new();
        BufReader::new(server.0.stdout.take().unwrap())
            .read_line(&mut display)
            .unwrap();
        let (conn, screen) = RustConnection::connect(Some(&format!(":{}", display.trim()))).unwrap();
        let conn = Arc::new(conn);
        let root = conn.setup().roots[screen].root;
        let atoms = Atoms::new(&conn).unwrap().reply().unwrap();
        let create = |parent, or: bool| {
            let id = conn.generate_id().unwrap();
            conn.create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                id,
                parent,
                0,
                0,
                100,
                100,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new().override_redirect(u32::from(or)),
            )
            .unwrap()
            .check()
            .unwrap();
            watch(&conn, id).unwrap();
            conn.map_window(id).unwrap().check().unwrap();
            id
        };
        let game = create(root, false);
        let steam = create(root, false);
        let child = create(game, false);
        let popup = create(root, true);
        let surface = |id, or| {
            X11Surface::new(
                None,
                id,
                or,
                Arc::downgrade(&conn),
                atoms,
                crate::utils::Rectangle::from_size((100, 100).into()),
            )
        };
        let windows = vec![surface(game, false), surface(steam, false), surface(popup, true)];
        let active = || {
            conn.get_property(false, root, atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW, 0, 1)
                .unwrap()
                .reply()
                .unwrap()
                .value32()
                .unwrap()
                .next()
                .unwrap()
        };
        conn.change_window_attributes(
            root,
            &x11rb::protocol::xproto::ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .unwrap()
        .check()
        .unwrap();
        let focus = |id| {
            conn.set_input_focus(InputFocus::NONE, id, x11rb::CURRENT_TIME)
                .unwrap()
                .check()
                .unwrap()
        };
        focus(game);
        // Root ancestor events and queued FocusOut from Steam must never
        // publish either the desktop or the old window over the game.
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(
            active(),
            game,
            "root ancestor event incorrectly deactivates the game"
        );
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(active(), game);
        focus(child);
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(active(), game);
        focus(steam);
        // The same subscription used by CreateNotify must deliver client
        // events even when focus changes between siblings beneath the root.
        conn.get_input_focus().unwrap().reply().unwrap();
        let mut saw_steam_focus = false;
        while let Some(event) = conn.poll_for_event().unwrap() {
            if let x11rb::protocol::Event::FocusIn(event) = event {
                saw_steam_focus |= event.event == steam;
            }
        }
        assert!(saw_steam_focus, "missing client FocusIn subscription");
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(active(), steam);
        // A keyboard grab redirects events temporarily but must not make
        // the grab window the active managed application.
        focus(game);
        let result = conn
            .grab_keyboard(
                false,
                popup,
                x11rb::CURRENT_TIME,
                x11rb::protocol::xproto::GrabMode::ASYNC,
                x11rb::protocol::xproto::GrabMode::ASYNC,
            )
            .unwrap()
            .reply()
            .unwrap();
        assert_eq!(result.status, x11rb::protocol::xproto::GrabStatus::SUCCESS);
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(active(), game);
        conn.ungrab_keyboard(x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(active(), game);
        // A transient popup retains its owner's activation without moving
        // the keyboard focus that belongs to the popup.
        conn.change_property32(
            PropMode::REPLACE,
            popup,
            AtomEnum::WM_TRANSIENT_FOR,
            AtomEnum::WINDOW,
            &[game],
        )
        .unwrap()
        .check()
        .unwrap();
        windows[2].update_properties().unwrap();
        focus(popup);
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(active(), game);
        assert_eq!(conn.get_input_focus().unwrap().reply().unwrap().focus, popup);
        for empty in [x11rb::NONE, u32::from(InputFocus::POINTER_ROOT), root] {
            focus(empty);
            update(&conn, root, &atoms, &windows).unwrap();
            assert_eq!(active(), x11rb::NONE);
        }
        focus(game);
        update(&conn, root, &atoms, &windows).unwrap();
        while conn.poll_for_event().unwrap().is_some() {}
        for _ in 0..10 {
            update(&conn, root, &atoms, &windows).unwrap();
        }
        assert!(
            conn.poll_for_event().unwrap().is_none(),
            "publication must not bounce keyboard focus"
        );
        conn.destroy_window(game).unwrap().check().unwrap();
        update(&conn, root, &atoms, &windows).unwrap();
        assert_eq!(active(), x11rb::NONE);
    }
}
