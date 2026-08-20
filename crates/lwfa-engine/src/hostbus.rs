//! Making the host's D-Bus services reachable from inside the session.
//!
//! # Why this exists
//!
//! lwfa runs applications against a private session bus, because it runs its
//! own `xdg-desktop-portal` frontend and that frontend has to own
//! `org.freedesktop.portal.Desktop`, a name the host's frontend already owns.
//! See [`crate::portal`].
//!
//! The cost is everything else on the host's bus. The worst of it is the
//! keyring. `org.freedesktop.secrets` is *activatable* on the private bus,
//! because the private bus reads the same service files as any other, and its
//! activation line is
//!
//! ```text
//! Exec=/usr/bin/gnome-keyring-daemon --start --foreground --components=secrets
//! ```
//!
//! `--start` does not start a daemon. It finds the one already running through
//! `$XDG_RUNTIME_DIR/keyring`, asks it to bring up its secrets component, and
//! exits. That daemon is connected to the *host's* bus, so it claims the name
//! there, where it already had it. Nothing ever claims it on the private bus,
//! and the caller blocks until D-Bus gives up on the activation.
//!
//! Measured on this machine: the same call answers in 0.002s on the host bus
//! and had not returned after 15 seconds on the private one. Every application
//! that asks for a password stalls like that: Chromium, Chrome, VS Code, and
//! anything else built on libsecret.
//!
//! # What this does
//!
//! Owns the name on the private bus and forwards. An application inside the
//! session addresses the keyring exactly as it would anywhere else; the calls
//! come out on the host's bus, against the real daemon, unlocked by PAM at
//! login like it always was. No second daemon, no second copy of the keyring
//! files, no prompt on a screen nobody is looking at.
//!
//! # How the forwarding works
//!
//! Two connections and two threads. One reads the private bus and re-sends
//! anything addressed to a relayed name onto the host bus under a serial of
//! this module's choosing; the other reads the host bus and turns each reply
//! back into a reply to the call that caused it. The original message is what
//! is parked in between, because `Message::method_return` builds the reply's
//! destination and reply-serial from the header of the call it answers, so
//! keeping it removes a whole class of bookkeeping mistake.
//!
//! Bodies are copied as raw bytes with their signature rather than being
//! deserialised. This has no business knowing the Secret Service API, and a
//! relay that has to be taught each new method is a relay that breaks the
//! first time one is added.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use zbus::blocking::{Connection, MessageIterator};
use zbus::message::{Message, Type};

/// The names taken from the host rather than served here.
///
/// Deliberately short. Every name added is a decision that the host's copy is
/// the right one for an application inside the session, which is true of the
/// keyring, whose whole value is being the same store the rest of the desktop
/// uses, and false of the portal, whose whole value is being different.
pub const RELAYED: &[&str] = &[
    // The Secret Service, which is what libsecret and Chromium's password
    // store talk to.
    "org.freedesktop.secrets",
];

/// Serials for forwarded calls.
///
/// Started high so it cannot collide with the serials zbus assigns to messages
/// this process sends on the same connection, which begin at one. The two
/// counters are independent and only their values have to stay apart.
static NEXT_SERIAL: AtomicU32 = AtomicU32::new(0x4000_0000);

fn next_serial() -> NonZeroU32 {
    let value = NEXT_SERIAL.fetch_add(1, Ordering::Relaxed);
    // Wrapping past the top lands back in the reserved range rather than on
    // zero, which is not a legal serial.
    NonZeroU32::new(value).unwrap_or(NonZeroU32::new(0x4000_0000).unwrap())
}

/// Calls sent to the host and not yet answered, by the serial they went out on.
type Pending = Arc<Mutex<HashMap<u32, Message>>>;

/// Start relaying `names` from the host's bus onto the private one.
///
/// Returns once both connections are up and the names are owned, so a client
/// that connects afterwards finds the name already there rather than racing
/// the relay. The threads run until the process ends.
pub fn start(private_address: &str, host_address: &str, names: &[&str]) -> Result<(), String> {
    let private = connect(private_address, "the private bus")?;
    let host = connect(host_address, "the host bus")?;

    for name in names {
        private
            .request_name(*name)
            .map_err(|err| format!("could not take {name} on the private bus: {err}"))?;
    }

    // Signals are not delivered to a connection that has not asked for them,
    // and the relayed services use them: unlocking a collection finishes with
    // one. Without these rules a lookup that needs an unlock hangs.
    for name in names {
        let rule = format!("type='signal',sender='{name}'");
        if let Err(err) = host.call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "AddMatch",
            &(rule.as_str()),
        ) {
            tracing::warn!("could not watch {name} for signals: {err}");
        }
    }

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    spawn("lwfa-hostbus-out", {
        let (private, host, pending) = (private.clone(), host.clone(), Arc::clone(&pending));
        let names: Vec<String> = names.iter().map(|n| (*n).to_string()).collect();
        move || outbound(&private, &host, &pending, &names)
    })?;
    spawn("lwfa-hostbus-in", {
        let (private, host, pending) = (private.clone(), host.clone(), Arc::clone(&pending));
        move || inbound(&private, &host, &pending)
    })?;

    tracing::info!(
        "relaying {} from the host's bus into the session",
        names.join(", ")
    );
    Ok(())
}

fn connect(address: &str, what: &str) -> Result<Connection, String> {
    let address: zbus::Address = address
        .parse()
        .map_err(|err| format!("unusable address for {what}: {err}"))?;
    zbus::blocking::connection::Builder::address(address)
        .and_then(|builder| builder.build())
        .map_err(|err| format!("could not reach {what}: {err}"))
}

fn spawn<F>(name: &str, body: F) -> Result<(), String>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(body)
        .map(|_| ())
        .map_err(|err| format!("could not start {name}: {err}"))
}

/// Private bus to host bus: calls going out.
fn outbound(private: &Connection, host: &Connection, pending: &Pending, names: &[String]) {
    // A client that has resolved the well-known name to its current owner
    // addresses that owner instead, and the owner is this relay. Both forms
    // have to be recognised or such a client waits forever for a reply nobody
    // is listening for.
    let mine = private.unique_name().map(|name| name.to_string());
    for message in MessageIterator::from(private.clone()) {
        let Ok(message) = message else { continue };
        let header = message.header();
        if header.message_type() != Type::MethodCall {
            continue;
        }
        let Some(destination) = header.destination() else {
            continue;
        };
        let addressed = names.iter().any(|name| name == destination.as_str())
            || mine.as_deref() == Some(destination.as_str());
        if !addressed {
            continue;
        }
        // Sent on to the well-known name, never to whatever the client used:
        // the host has its own owner for it and this relay's unique name means
        // nothing over there.
        let target = names
            .iter()
            .find(|name| *name == destination.as_str())
            .cloned()
            .unwrap_or_else(|| names[0].clone());

        let serial = next_serial();
        match forward(&message, &target, serial) {
            Ok(out) => {
                pending.lock().map(|mut map| map.insert(serial.get(), message)).ok();
                if let Err(err) = host.send(&out) {
                    tracing::debug!("could not forward a call to the host bus: {err}");
                    pending.lock().map(|mut map| map.remove(&serial.get())).ok();
                }
            }
            Err(err) => tracing::debug!("could not rebuild a call for the host bus: {err}"),
        }
    }
}

/// Rebuild a call so it can go out on the other connection.
#[allow(unsafe_code)]
fn forward(message: &Message, destination: &str, serial: NonZeroU32) -> Result<Message, String> {
    let header = message.header();
    let path = header.path().ok_or("a method call with no path")?;
    let member = header.member().ok_or("a method call with no member")?;

    let mut builder = Message::method_call(path.clone(), member.clone())
        .and_then(|builder| builder.destination(destination))
        .map_err(|err| format!("{err}"))?
        .serial(serial);
    if let Some(interface) = header.interface() {
        builder = builder
            .interface(interface.clone())
            .map_err(|err| format!("{err}"))?;
    }

    let body = message.body();
    // SAFETY: the bytes and the signature come from a message this bus already
    // accepted, so they agree with each other by construction. No file
    // descriptors: nothing relayed here passes any, and one that did would be
    // dropped here rather than silently mismatched.
    unsafe { builder.build_raw_body(body.data(), body.signature().clone(), Vec::new()) }
        .map_err(|err| format!("{err}"))
}

/// Host bus to private bus: replies coming back.
fn inbound(private: &Connection, host: &Connection, pending: &Pending) {
    for message in MessageIterator::from(host.clone()) {
        let Ok(message) = message else { continue };
        let header = message.header();
        let kind = header.message_type();
        if kind == Type::Signal {
            // A signal has no call to answer, so it is re-emitted rather than
            // replied to. Clients wait on these: unlocking a collection is a
            // `Prompt` that finishes by signal, and a lookup that never sees it
            // simply hangs, which is exactly what the first version of this did.
            match reemit(&message) {
                Ok(signal) => {
                    if let Err(err) = private.send(&signal) {
                        tracing::debug!("could not relay a signal: {err}");
                    }
                }
                Err(err) => tracing::debug!("could not rebuild a relayed signal: {err}"),
            }
            continue;
        }
        if kind != Type::MethodReturn && kind != Type::Error {
            continue;
        }
        let Some(reply_serial) = header.reply_serial() else {
            continue;
        };
        let Some(call) = pending
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&reply_serial.get()))
        else {
            continue;
        };

        match answer(&call, &message) {
            Ok(reply) => {
                if let Err(err) = private.send(&reply) {
                    tracing::debug!("could not deliver a relayed reply: {err}");
                }
            }
            Err(err) => tracing::debug!("could not rebuild a relayed reply: {err}"),
        }
    }
}

/// Re-emit a host signal on the private bus.
///
/// Broadcast, with no destination, exactly as it arrived. The sender becomes
/// this relay's unique name, which is what a client's match rule on the
/// well-known name resolves to on this bus, so the two still line up.
#[allow(unsafe_code)]
fn reemit(signal: &Message) -> Result<Message, String> {
    let header = signal.header();
    let path = header.path().ok_or("a signal with no path")?;
    let interface = header.interface().ok_or("a signal with no interface")?;
    let member = header.member().ok_or("a signal with no member")?;
    let builder = Message::signal(path.clone(), interface.clone(), member.clone())
        .map_err(|err| format!("{err}"))?;
    let body = signal.body();
    // SAFETY: as in `forward`, bytes and signature came off the wire together.
    unsafe { builder.build_raw_body(body.data(), body.signature().clone(), Vec::new()) }
        .map_err(|err| format!("{err}"))
}

/// Turn the host's reply into a reply to the call that caused it.
#[allow(unsafe_code)]
fn answer(call: &Message, reply: &Message) -> Result<Message, String> {
    let call_header = call.header();
    let reply_header = reply.header();
    let body = reply.body();

    let builder = if reply_header.message_type() == Type::Error {
        let name = reply_header
            .error_name()
            .ok_or("an error reply with no error name")?;
        Message::error(&call_header, name.clone()).map_err(|err| format!("{err}"))?
    } else {
        Message::method_return(&call_header).map_err(|err| format!("{err}"))?
    };

    // SAFETY: as in `forward`, the bytes and signature came off the wire
    // together.
    unsafe { builder.build_raw_body(body.data(), body.signature().clone(), Vec::new()) }
        .map_err(|err| format!("{err}"))
}
