//! A virtual game controller, so the on-screen pad is a real controller.
//!
//! # Why this exists
//!
//! The on-screen pad used to send keystrokes: A was Space, L2 was Shift, and a
//! stick was four arrow keys. That drives an emulator or an old Linux game
//! perfectly well and is invisible to anything looking for a *controller*, so
//! a Steam game simply found no gamepad at all. It also threw away the one
//! thing a touch stick is good at: a real analog position. Four on-off keys
//! cannot express walking slowly or steering gently.
//!
//! So the engine creates a controller. `uinput` is a kernel interface for
//! exactly this: a userspace process describes a device, and the kernel makes
//! an ordinary `/dev/input/event*` out of it that every program on the machine
//! reads like hardware.
//!
//! # Why it claims to be an Xbox controller
//!
//! Because SDL and Steam identify controllers by their USB vendor and product
//! ids and look up the button layout in a database keyed on those. A device
//! with invented ids is a stack of unnamed buttons that every game asks you to
//! configure by hand. Reporting Microsoft's Xbox One ids means the mapping is
//! already known, everywhere, with no per-game setup. This is the same choice
//! Sunshine makes for game streaming, for the same reason.
//!
//! It is not a claim of provenance: the device name says lwfa, and anything
//! that looks will see a virtual device.
//!
//! The `version` we report does not have to match Microsoft's. SDL builds its
//! lookup key from bus, vendor, product, version and a checksum of the name,
//! but `SDL_PrivateGetControllerMappingForGUID` tries the exact key first and
//! then retries with the version zeroed, and a built-in mapping that carries no
//! checksum matches any name. So the Xbox layout is found regardless. Worth
//! knowing before anyone "corrects" the version below to make it match a
//! database string by eye.
//!
//! # Scope, and what it costs
//!
//! The device is visible to the **whole machine**, not only to lwfa, because
//! that is precisely what makes Steam find it. So it exists only while a
//! client is actually using the pad, and goes away when they stop. An idle
//! session advertising a controller nobody is holding would confuse games about
//! how many players are present.
//!
//! Force feedback is not implemented. Rumble travels the other way, from game
//! to device, which means reading from the uinput handle and a protocol
//! message back to the browser; worth doing, not needed to make a game
//! playable.

use std::fs::File;
use std::cell::Cell;
use std::io;

use input_linux::sys::{input_event, timeval};
use input_linux::{
    AbsoluteAxis, AbsoluteInfo, AbsoluteInfoSetup, EventKind, InputId, Key, UInputHandle,
};
use lwfa_proto::{GamepadAxis, GamepadButton};

/// Microsoft, Xbox One controller. See the header for why these and not ours.
const VENDOR: u16 = 0x045e;
const PRODUCT: u16 = 0x02ea;
const BUS_USB: u16 = 0x03;

/// Range for the thumbsticks, matching what a real Xbox pad reports.
const STICK_RANGE: i32 = 32767;

/// Range for the analog triggers.
const TRIGGER_RANGE: i32 = 1023;

/// A dead zone the *kernel* applies, so a resting stick reads as exactly zero.
///
/// The shell already has its own dead zone for the touch surface. This is the
/// second half of the same idea and belongs here too: `flat` is what joydev
/// uses to decide a value is rest, and without it a game can see a stick that
/// never quite centres.
const STICK_FLAT: i32 = 512;

/// The D-pad is a *hat*, not four buttons, and that is not cosmetic.
///
/// This device claims to be an Xbox One pad so that SDL finds a layout for it
/// without per-game setup (see the header). The consequence is that SDL uses
/// its built-in mapping for `045e:02ea`, and that mapping reads the D-pad from
/// hat 0: `dpup:h0.1`, `dpdown:h0.4`, and so on. It never looks at
/// `BTN_DPAD_UP`.
///
/// So a device that advertises the Xbox ids and reports its D-pad as buttons
/// has a D-pad that no SDL game can see, while every face button works
/// perfectly, which is exactly how it presented: A started Assassin's Creed
/// Odyssey from its title screen and no direction ever moved its menu.
///
/// `BTN_DPAD_*` are still emitted alongside, for anything reading evdev
/// directly rather than through a mapping. SDL ignores them here, because the
/// built-in mapping names the hat.
const HAT_RANGE: i32 = 1;

/// Which bit of [`VirtualPad::dpad`] a direction owns.
fn dpad_bit(button: GamepadButton) -> Option<u8> {
    match button {
        GamepadButton::DpadUp => Some(1),
        GamepadButton::DpadDown => Some(2),
        GamepadButton::DpadLeft => Some(4),
        GamepadButton::DpadRight => Some(8),
        _ => None,
    }
}

/// The buttons this device advertises, in W3C mapping order.
///
/// `BTN_SOUTH` and friends are the modern gamepad names for what used to be
/// `BTN_A`; they are the codes SDL expects from an Xbox-style pad.
fn key_for(button: GamepadButton) -> Key {
    match button {
        GamepadButton::South => Key::ButtonSouth,
        GamepadButton::East => Key::ButtonEast,
        GamepadButton::West => Key::ButtonWest,
        GamepadButton::North => Key::ButtonNorth,
        GamepadButton::LeftShoulder => Key::ButtonTL,
        GamepadButton::RightShoulder => Key::ButtonTR,
        // The triggers are analog axes as well; the button is what a game
        // reads when it only wants "pulled or not".
        GamepadButton::LeftTrigger => Key::ButtonTL2,
        GamepadButton::RightTrigger => Key::ButtonTR2,
        GamepadButton::Select => Key::ButtonSelect,
        GamepadButton::Start => Key::ButtonStart,
        GamepadButton::LeftStick => Key::ButtonThumbl,
        GamepadButton::RightStick => Key::ButtonThumbr,
        GamepadButton::DpadUp => Key::ButtonDpadUp,
        GamepadButton::DpadDown => Key::ButtonDpadDown,
        GamepadButton::DpadLeft => Key::ButtonDpadLeft,
        GamepadButton::DpadRight => Key::ButtonDpadRight,
        GamepadButton::Guide => Key::ButtonMode,
    }
}

const ALL_BUTTONS: [GamepadButton; 17] = [
    GamepadButton::South,
    GamepadButton::East,
    GamepadButton::West,
    GamepadButton::North,
    GamepadButton::LeftShoulder,
    GamepadButton::RightShoulder,
    GamepadButton::LeftTrigger,
    GamepadButton::RightTrigger,
    GamepadButton::Select,
    GamepadButton::Start,
    GamepadButton::LeftStick,
    GamepadButton::RightStick,
    GamepadButton::DpadUp,
    GamepadButton::DpadDown,
    GamepadButton::DpadLeft,
    GamepadButton::DpadRight,
    GamepadButton::Guide,
];

fn axis_for(axis: GamepadAxis) -> AbsoluteAxis {
    match axis {
        GamepadAxis::LeftX => AbsoluteAxis::X,
        GamepadAxis::LeftY => AbsoluteAxis::Y,
        GamepadAxis::RightX => AbsoluteAxis::RX,
        GamepadAxis::RightY => AbsoluteAxis::RY,
        GamepadAxis::LeftTrigger => AbsoluteAxis::Z,
        GamepadAxis::RightTrigger => AbsoluteAxis::RZ,
    }
}

/// A live virtual controller. Dropping it removes the device.
pub struct VirtualPad {
    handle: UInputHandle<File>,
    /// Which D-pad directions are currently held, as [`dpad_bit`] flags.
    ///
    /// A hat is one value per axis, so "left released" cannot be sent on its
    /// own: the axis has to be recomputed from everything still held, or
    /// releasing one direction while another is down would centre both.
    dpad: Cell<u8>,
}

impl VirtualPad {
    /// Create the device, or explain why not.
    ///
    /// The common failure is permission: `/dev/uinput` is owned by the `input`
    /// group, so a user outside it cannot create devices. That is reported
    /// rather than swallowed, because "the gamepad does nothing" with no
    /// explanation is exactly the experience this module exists to end.
    pub fn open() -> io::Result<Self> {
        let file = File::options().write(true).open("/dev/uinput").map_err(|err| {
            io::Error::new(
                err.kind(),
                format!(
                    "could not open /dev/uinput ({err}). A virtual controller needs write \
                     access to it, which usually means being in the `input` group."
                ),
            )
        })?;
        let handle = UInputHandle::new(file);

        handle.set_evbit(EventKind::Key)?;
        for button in ALL_BUTTONS {
            handle.set_keybit(key_for(button))?;
        }

        handle.set_evbit(EventKind::Absolute)?;
        let mut axes = Vec::new();
        for axis in [
            GamepadAxis::LeftX,
            GamepadAxis::LeftY,
            GamepadAxis::RightX,
            GamepadAxis::RightY,
            GamepadAxis::LeftTrigger,
            GamepadAxis::RightTrigger,
        ] {
            let kernel = axis_for(axis);
            handle.set_absbit(kernel)?;
            let trigger = matches!(
                axis,
                GamepadAxis::LeftTrigger | GamepadAxis::RightTrigger
            );
            axes.push(AbsoluteInfoSetup {
                axis: kernel,
                info: AbsoluteInfo {
                    value: 0,
                    minimum: if trigger { 0 } else { -STICK_RANGE },
                    maximum: if trigger { TRIGGER_RANGE } else { STICK_RANGE },
                    fuzz: 0,
                    flat: if trigger { 0 } else { STICK_FLAT },
                    resolution: 0,
                },
            });
        }

        // The D-pad, as a hat. See [`HAT_RANGE`].
        for hat in [AbsoluteAxis::Hat0X, AbsoluteAxis::Hat0Y] {
            handle.set_absbit(hat)?;
            axes.push(AbsoluteInfoSetup {
                axis: hat,
                info: AbsoluteInfo {
                    value: 0,
                    minimum: -HAT_RANGE,
                    maximum: HAT_RANGE,
                    fuzz: 0,
                    // A hat is already discrete; a dead zone here would eat
                    // the only three values it has.
                    flat: 0,
                    resolution: 0,
                },
            });
        }

        handle.create(
            &InputId {
                bustype: BUS_USB,
                vendor: VENDOR,
                product: PRODUCT,
                version: 0x0110,
            },
            b"lwfa virtual controller",
            0,
            &axes,
        )?;

        tracing::info!(
            "virtual controller attached at {}",
            handle
                .evdev_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "an unknown device".into())
        );
        Ok(Self {
            handle,
            dpad: Cell::new(0),
        })
    }

    /// Release every button and centre every axis.
    ///
    /// Called when a session flaps and its pad is parked (see the session
    /// grace in `state.rs`): a disconnect mid-press must not leave a game
    /// holding a button or a stick pushed for the length of the outage.
    pub fn neutral(&self) {
        for index in 0..17u8 {
            if let Some(button) = GamepadButton::from_index(index) {
                self.button(button, false);
            }
        }
        for axis in [
            GamepadAxis::LeftX,
            GamepadAxis::LeftY,
            GamepadAxis::RightX,
            GamepadAxis::RightY,
        ] {
            self.axis(axis, 0.0);
        }
        for axis in [GamepadAxis::LeftTrigger, GamepadAxis::RightTrigger] {
            self.axis(axis, 0.0);
        }
    }

    /// Press or release a button.
    pub fn button(&self, button: GamepadButton, pressed: bool) {
        let key = key_for(button);
        let mut events = vec![event(EventKind::Key, key as u16, i32::from(pressed))];

        // A direction is also a hat movement, which is the only form of it
        // an SDL game will see. See [`HAT_RANGE`].
        if let Some(bit) = dpad_bit(button) {
            let held = if pressed {
                self.dpad.get() | bit
            } else {
                self.dpad.get() & !bit
            };
            self.dpad.set(held);
            events.push(event(
                EventKind::Absolute,
                AbsoluteAxis::Hat0X as u16,
                i32::from(held & 8 != 0) - i32::from(held & 4 != 0),
            ));
            events.push(event(
                EventKind::Absolute,
                AbsoluteAxis::Hat0Y as u16,
                i32::from(held & 2 != 0) - i32::from(held & 1 != 0),
            ));
        }

        events.push(SYNC);
        self.emit(&events);
    }

    /// Move an axis. Sticks take -1 to 1, triggers 0 to 1.
    pub fn axis(&self, axis: GamepadAxis, value: f64) {
        let trigger = matches!(axis, GamepadAxis::LeftTrigger | GamepadAxis::RightTrigger);
        let scaled = if trigger {
            (value.clamp(0.0, 1.0) * TRIGGER_RANGE as f64).round() as i32
        } else {
            (value.clamp(-1.0, 1.0) * STICK_RANGE as f64).round() as i32
        };
        self.emit(&[
            event(EventKind::Absolute, axis_for(axis) as u16, scaled),
            SYNC,
        ]);
    }

    /// Let go of everything.
    ///
    /// Sent before the device disappears, because a game that saw a button go
    /// down and never come up keeps it held: a character that runs into a wall
    /// forever after the browser tab closed.
    pub fn release_all(&self) {
        let mut events: Vec<input_event> = ALL_BUTTONS
            .iter()
            .map(|button| event(EventKind::Key, key_for(*button) as u16, 0))
            .collect();
        for axis in [
            GamepadAxis::LeftX,
            GamepadAxis::LeftY,
            GamepadAxis::RightX,
            GamepadAxis::RightY,
            GamepadAxis::LeftTrigger,
            GamepadAxis::RightTrigger,
        ] {
            events.push(event(EventKind::Absolute, axis_for(axis) as u16, 0));
        }
        // The hat centres with everything else, or a game keeps walking in
        // the direction the browser tab was closed in.
        self.dpad.set(0);
        events.push(event(EventKind::Absolute, AbsoluteAxis::Hat0X as u16, 0));
        events.push(event(EventKind::Absolute, AbsoluteAxis::Hat0Y as u16, 0));
        events.push(SYNC);
        self.emit(&events);
    }

    fn emit(&self, events: &[input_event]) {
        if let Err(err) = self.handle.write(events) {
            tracing::warn!("could not write to the virtual controller: {err}");
        }
    }
}

impl Drop for VirtualPad {
    fn drop(&mut self) {
        self.release_all();
        tracing::info!("virtual controller detached");
    }
}

/// The event that says "that is one complete update".
///
/// Without it the kernel holds what it has been told: evdev batches until a
/// sync, so a press with no sync is a press nothing ever sees. Same shape of
/// mistake as a missing `wl_pointer.frame`.
const SYNC: input_event = input_event {
    time: timeval {
        tv_sec: 0,
        tv_usec: 0,
    },
    type_: EventKind::Synchronize as u16,
    code: 0, // SYN_REPORT
    value: 0,
};

fn event(kind: EventKind, code: u16, value: i32) -> input_event {
    input_event {
        // Zero, because the kernel timestamps events on arrival. Supplying our
        // own would mean the compositor's clock, which is not the one evdev
        // consumers compare against.
        time: timeval {
            tv_sec: 0,
            tv_usec: 0,
        },
        type_: kind as u16,
        code,
        value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two tests below both create a device and both look at a list that
    /// is global to the machine, so they cannot run at the same time. Cargo
    /// runs tests in parallel by default, and without this each one sees the
    /// other's controller and fails for the wrong reason.
    static UINPUT: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn every_w3c_button_maps_to_a_distinct_kernel_key() {
        // Two buttons sharing a code would make one of them dead, silently.
        let mut codes: Vec<u16> = ALL_BUTTONS.iter().map(|b| key_for(*b) as u16).collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total, "two buttons map to the same key");
    }

    #[test]
    fn the_stick_clicks_are_present() {
        // L3 and R3 were the buttons the keyboard layout never bound, and
        // every shooter uses them for sprint and melee.
        assert_eq!(key_for(GamepadButton::LeftStick), Key::ButtonThumbl);
        assert_eq!(key_for(GamepadButton::RightStick), Key::ButtonThumbr);
    }

    /// The one test that proves any of this works.
    ///
    /// Everything above checks my own tables against themselves, which would
    /// pass just as happily if the kernel rejected the device outright. This
    /// creates a real controller and asks the kernel whether it exists, whether
    /// it is a joystick, and whether it goes away again.
    ///
    /// Ignored by default because it needs write access to `/dev/uinput`, which
    /// a CI container will not have. Run it with:
    ///
    /// ```text
    /// cargo test -p lwfa-engine -- --ignored the_kernel
    /// ```
    #[test]
    #[ignore = "needs write access to /dev/uinput"]
    fn the_kernel_accepts_the_device_as_a_controller() {
        use std::time::{Duration, Instant};
        let _serial = UINPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let listed = || std::fs::read_to_string("/proc/bus/input/devices").unwrap_or_default();
        assert!(
            !listed().contains("lwfa virtual controller"),
            "one is already attached; a previous run leaked it"
        );

        let pad = VirtualPad::open().expect("create the device");

        // udev is asynchronous, so the node appears shortly after `create`
        // returns rather than during it.
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut devices = listed();
        while !devices.contains("lwfa virtual controller") && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            devices = listed();
        }

        let entry = devices
            .split("\n\n")
            .find(|block| block.contains("lwfa virtual controller"))
            .expect("the kernel never published the device");

        // The ids SDL and Steam look the button layout up by. Wrong ones mean
        // an unnamed stack of buttons in every game.
        assert!(
            entry.contains("Vendor=045e") && entry.contains("Product=02ea"),
            "wrong usb ids, so no game will know the layout:\n{entry}"
        );
        // `js0` is joydev claiming it. Without this it is an input device that
        // happens to have buttons, not a joystick.
        assert!(
            entry.contains("js"),
            "joydev did not claim it as a joystick:\n{entry}"
        );

        // And it must not outlive the session holding it.
        drop(pad);
        let deadline = Instant::now() + Duration::from_secs(2);
        while listed().contains("lwfa virtual controller") && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !listed().contains("lwfa virtual controller"),
            "the device outlived the client holding it"
        );
    }

    /// Proof that a press actually reaches a reader, not just that a device
    /// exists.
    ///
    /// This is the test that would have caught a missing `SYN_REPORT`: the
    /// device would still be listed, still be a joystick, and still deliver
    /// nothing at all. Same shape of mistake as a missing `wl_pointer.frame`,
    /// and it took a day to find the last time I made it.
    #[test]
    #[ignore = "needs write access to /dev/uinput"]
    fn a_press_and_a_stick_come_back_out_of_the_kernel() {
        use input_linux::EvdevHandle;
        use std::time::{Duration, Instant};
        let _serial = UINPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let pad = VirtualPad::open().expect("create the device");

        // Open the reader *before* emitting anything. evdev has no backlog for
        // a reader that was not there yet, so the other order loses the events
        // and the test fails for a reason that has nothing to do with the code.
        // Retried, because both halves of this are races. `evdev_path` needs
        // the node to exist, and opening it needs udev to have finished
        // relabelling it: a fresh node is root-only for a few milliseconds
        // before the rules make it group `input`, so the first open is
        // routinely denied for no lasting reason.
        let deadline = Instant::now() + Duration::from_secs(2);
        let reader = loop {
            let opened = pad
                .handle
                .evdev_path()
                .and_then(|path| File::options().read(true).open(path));
            match opened {
                Ok(file) => break EvdevHandle::new(file),
                Err(err) => {
                    assert!(
                        Instant::now() < deadline,
                        "could not read back our own device: {err}"
                    );
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        };

        pad.button(GamepadButton::South, true);
        pad.axis(GamepadAxis::LeftX, -1.0);
        pad.axis(GamepadAxis::RightTrigger, 0.5);

        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && seen.len() < 6 {
            let mut buffer = [event(EventKind::Key, 0, 0); 16];
            match reader.read(&mut buffer) {
                Ok(count) => seen.extend_from_slice(&buffer[..count]),
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }

        let found = |kind: EventKind, code: u16| {
            seen.iter()
                .find(|e| e.type_ == kind as u16 && e.code == code)
                .map(|e| e.value)
        };

        assert_eq!(
            found(EventKind::Key, Key::ButtonSouth as u16),
            Some(1),
            "the A button never arrived: {seen:?}"
        );
        assert_eq!(
            found(EventKind::Absolute, AbsoluteAxis::X as u16),
            Some(-STICK_RANGE),
            "the stick never arrived at full deflection"
        );
        assert_eq!(
            found(EventKind::Absolute, AbsoluteAxis::RZ as u16),
            // Rounded, not truncated: 1023 has no exact half.
            Some(512),
            "a half-pulled trigger should be half of its range, not half of a stick's"
        );
        assert!(
            found(EventKind::Synchronize, 0).is_some(),
            "no SYN_REPORT, so nothing would ever be acted on"
        );
    }

    #[test]
    fn axis_indices_survive_the_round_trip() {
        for index in 0..6u8 {
            let axis = GamepadAxis::from_index(index).expect("a known axis");
            assert_eq!(axis as u8, index);
        }
        assert!(GamepadAxis::from_index(6).is_none());
    }

    #[test]
    fn button_indices_survive_the_round_trip() {
        for index in 0..17u8 {
            let button = GamepadButton::from_index(index).expect("a known button");
            assert_eq!(button as u8, index);
        }
        assert!(GamepadButton::from_index(17).is_none());
    }
}
