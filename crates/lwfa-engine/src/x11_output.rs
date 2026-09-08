//! Shared output announcements use Smithay for native Wayland and Xwayland.
use crate::state::Lwfa;
use smithay::wayland::output::OutputHandler;

impl OutputHandler for Lwfa {}
smithay::delegate_output!(Lwfa);
