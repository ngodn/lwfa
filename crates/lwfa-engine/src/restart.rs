//! Queue the installed user service restart without blocking the compositor.
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use smithay::reexports::calloop::channel;
use crate::state::Lwfa;

static PENDING: AtomicBool = AtomicBool::new(false);

fn run_bounded(command: &mut Command) -> std::io::Result<Output> {
    crate::childsig::unblock_signals(command);
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait()?.is_some() { return child.wait_with_output(); }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "systemctl did not answer within 5 seconds"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run_restart(mut run: impl FnMut(&mut Command) -> std::io::Result<Output>) -> Result<(), String> {
    let mut query = Command::new("systemctl");
    query.args(["--user", "show", "--property=MainPID", "--value", "lwfa.service"]);
    let owner = run(&mut query).map_err(|error| format!("Could not run systemctl: {error}"))?;
    if !owner.status.success() { return check_result(owner); }
    if String::from_utf8_lossy(&owner.stdout).trim().parse::<u32>().ok() != Some(std::process::id()) {
        return Err("This engine is not running as lwfa.service. Restart it from the host.".into());
    }
    let mut command = Command::new("systemctl");
    command.args(["--user", "--no-block", "restart", "lwfa.service"]);
    let output = run(&mut command).map_err(|error| format!("Could not run systemctl: {error}"))?;
    check_result(output)
}

fn check_result(output: Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().chars().take(400).collect::<String>();
    Err(if detail.is_empty() { format!("systemctl rejected the restart ({})", output.status) }
        else { format!("Could not restart lwfa: {detail}") })
}

pub fn request(state: &mut Lwfa, session: lwfa_proto::SessionId) {
    let fail = |state: &Lwfa, message: String| {
        tracing::warn!("session {session} could not restart lwfa: {message}");
        state.send_to_session(session, lwfa_proto::ToShell::Error { request: "restartEngine".into(), message });
    };
    if PENDING.swap(true, Ordering::AcqRel) {
        fail(state, "A restart is already pending.".into());
        return;
    }
    let (tx, rx) = channel::channel::<Result<(), String>>();
    if let Err(error) = state.loop_handle.insert_source(rx, move |event, _, state| {
        if let channel::Event::Msg(result) = event {
            match result {
                Ok(()) => {
                    use smithay::reexports::calloop::timer::{Timer, TimeoutAction};
                    tracing::info!("session {session} queued a restart of lwfa.service");
                    // Enqueuing is not completion. If this same engine still
                    // runs after the grace, permit retry and report the issue.
                    if let Err(error) = state.loop_handle.insert_source(Timer::from_duration(Duration::from_secs(25)), move |_, _, state| {
                        PENDING.store(false, Ordering::Release);
                        let message = "The restart was queued, but this engine is still running. Check lwfa.service on the host.";
                        tracing::warn!("{message}");
                        state.send_to_session(session, lwfa_proto::ToShell::Error { request: "restartEngine".into(), message: message.into() });
                        TimeoutAction::Drop
                    }) {
                        PENDING.store(false, Ordering::Release);
                        tracing::warn!("could not monitor the queued service restart: {error}");
                    }
                }
                Err(message) => {
                    PENDING.store(false, Ordering::Release);
                    tracing::warn!("session {session} could not restart lwfa: {message}");
                    state.send_to_session(session, lwfa_proto::ToShell::Error { request: "restartEngine".into(), message });
                }
            }
        }
    }) {
        PENDING.store(false, Ordering::Release);
        fail(state, format!("Could not monitor the restart request: {error}"));
        return;
    }
    tracing::info!("owner session {session} requested a restart of lwfa.service");
    if let Err(error) = std::thread::Builder::new().name("lwfa-restart".into()).spawn(move || {
        let _ = tx.send(run_restart(run_bounded));
    }) {
        PENDING.store(false, Ordering::Release);
        fail(state, format!("Could not start the restart request: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn restart_targets_only_the_named_user_service_without_waiting() {
        let mut calls = 0;
        let result = run_restart(|command| {
            calls += 1;
            assert_eq!(command.get_program(), "systemctl");
            if calls == 1 {
                assert_eq!(command.get_args().collect::<Vec<_>>(), ["--user", "show", "--property=MainPID", "--value", "lwfa.service"]);
            } else {
                assert_eq!(command.get_args().collect::<Vec<_>>(), ["--user", "--no-block", "restart", "lwfa.service"]);
            }
            Ok(Output { status: std::process::ExitStatus::from_raw(0), stdout: format!("{}\n", std::process::id()).into_bytes(), stderr: vec![] })
        });
        assert_eq!(result, Ok(()));
        assert_eq!(calls, 2);
    }

    #[test]
    fn a_standalone_engine_cannot_restart_another_service_process() {
        let mut calls = 0;
        let result = run_restart(|_| {
            calls += 1;
            Ok(Output { status: std::process::ExitStatus::from_raw(0), stdout: b"0\n".to_vec(), stderr: vec![] })
        });
        assert_eq!(calls, 1, "No restart command may run for a different MainPID");
        assert!(result.unwrap_err().starts_with("This engine is not running as lwfa.service."));
    }

    #[test]
    fn reports_a_missing_service_and_a_missing_systemctl() {
        let rejected = run_restart(|_| Ok(Output {
            status: std::process::ExitStatus::from_raw(256), stdout: vec![],
            stderr: b"Unit lwfa.service not found.\n".to_vec(),
        }));
        assert_eq!(rejected, Err("Could not restart lwfa: Unit lwfa.service not found.".into()));
        let missing = run_restart(|_| Err(std::io::Error::from(std::io::ErrorKind::NotFound)));
        assert!(missing.unwrap_err().starts_with("Could not run systemctl:"));
    }
}
