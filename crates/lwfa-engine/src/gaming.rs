//! Component downloads and profile storage run outside the compositor thread.
use crate::state::Lwfa;
use lwfa_proto::{GamingAction, SessionId, ToShell};
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

static BUSY: AtomicBool = AtomicBool::new(false);
const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

fn helper() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(prefix) = exe.parent().and_then(|p| p.parent()) {
        let installed = prefix.join("share/lwfa/compat/gaming/manage.py");
        if installed.is_file() {
            return Ok(installed);
        }
    }
    let development =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../compat/gaming/manage.py");
    if development.is_file() {
        return Ok(development);
    }
    Err("The gaming component manager is missing from this installation.".into())
}

fn drain(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut block = [0u8; 8192];
    loop {
        let count = stream.read(&mut block)?;
        if count == 0 {
            break;
        }
        let keep = count.min((OUTPUT_LIMIT + 1).saturating_sub(output.len()));
        output.extend_from_slice(&block[..keep]);
    }
    Ok(output)
}

fn run(payload: serde_json::Value, timeout: Duration) -> Result<serde_json::Value, String> {
    let mut command = Command::new("python3");
    command.arg(helper()?).arg("rpc");
    run_command(command, payload, timeout)
}

fn run_command(
    mut command: Command,
    payload: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::childsig::unblock_signals(&mut command);
    // Each job gets a process group so a timeout also stops a downloader child.
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start gaming manager: {e}"))?;
    let input = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    if let Err(error) = child.stdin.take().unwrap().write_all(&input) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || drain(stdout));
    let err = std::thread::spawn(move || drain(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            other => {
                // This group contains only the manager and its child jobs.
                if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
                    let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
                }
                let _ = child.wait();
                break Err(match other {
                    Err(e) => e.to_string(),
                    _ => "Gaming operation timed out. Refresh its status before retrying.".into(),
                });
            }
        }
    };
    let stdout = out
        .join()
        .map_err(|_| "Gaming output reader stopped")?
        .map_err(|e| e.to_string())?;
    let stderr = err
        .join()
        .map_err(|_| "Gaming error reader stopped")?
        .map_err(|e| e.to_string())?;
    let status = status?;
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr)
            .trim()
            .chars()
            .take(1200)
            .collect());
    }
    if stdout.len() > OUTPUT_LIMIT {
        return Err("Gaming inventory exceeded the response limit.".into());
    }
    serde_json::from_slice(&stdout).map_err(|e| format!("Invalid gaming manager reply: {e}"))
}

pub fn request(
    state: &mut Lwfa,
    session: SessionId,
    request: u32,
    action: GamingAction,
    payload: serde_json::Value,
) {
    let fail = |state: &Lwfa, message: String| {
        state.send_to_session(
            session,
            ToShell::Gaming {
                request,
                data: serde_json::Value::Null,
                error: Some(message),
            },
        )
    };
    if payload.to_string().len() > 16384 {
        fail(state, "Gaming settings exceed the request limit.".into());
        return;
    }
    if BUSY.swap(true, Ordering::AcqRel) {
        fail(
            state,
            "Another gaming operation is running. Refresh after it finishes.".into(),
        );
        return;
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let timer = state.loop_handle.insert_source(
        Timer::from_duration(Duration::from_millis(100)),
        move |_, _, state| match rx.try_recv() {
            Ok(result) => {
                let (data, error) = match result {
                    Ok(data) => (data, None),
                    Err(error) => (serde_json::Value::Null, Some(error)),
                };
                state.send_to_session(
                    session,
                    ToShell::Gaming {
                        request,
                        data,
                        error,
                    },
                );
                TimeoutAction::Drop
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                state.send_to_session(
                    session,
                    ToShell::Gaming {
                        request,
                        data: serde_json::Value::Null,
                        error: Some("Gaming worker stopped. Refresh to check its status.".into()),
                    },
                );
                TimeoutAction::Drop
            }
            Err(mpsc::TryRecvError::Empty) => TimeoutAction::ToDuration(Duration::from_millis(100)),
        },
    );
    if let Err(error) = timer {
        BUSY.store(false, Ordering::Release);
        fail(state, error.to_string());
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("lwfa-gaming".into())
        .spawn(move || {
            struct Pending;
            impl Drop for Pending {
                fn drop(&mut self) {
                    BUSY.store(false, Ordering::Release);
                }
            }
            let _pending = Pending;
            let timeout = Duration::from_secs(if action == GamingAction::Install {
                1800
            } else {
                30
            });
            let _ = tx.send(run(payload, timeout));
        })
    {
        BUSY.store(false, Ordering::Release);
        tracing::warn!("could not start gaming worker: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_is_bounded_but_pipe_is_drained() {
        let input = vec![42; OUTPUT_LIMIT * 2];
        let mut cursor = std::io::Cursor::new(&input);
        assert_eq!(drain(&mut cursor).unwrap().len(), OUTPUT_LIMIT + 1);
        assert_eq!(cursor.position(), input.len() as u64);
    }

    #[test]
    fn noisy_worker_does_not_fill_a_pipe_and_deadlock() {
        let mut command = Command::new("python3");
        command.args([
            "-c",
            "import sys; sys.stdin.read(); sys.stderr.write('x'*3000000); print('{\"ok\":true}')",
        ]);
        assert_eq!(
            run_command(command, serde_json::json!({}), Duration::from_secs(5)).unwrap(),
            serde_json::json!({"ok": true})
        );
    }

    #[test]
    fn hung_worker_is_stopped_and_reports_timeout() {
        let mut command = Command::new("python3");
        command.args(["-c", "import sys,time; sys.stdin.read(); time.sleep(60)"]);
        let start = Instant::now();
        let error =
            run_command(command, serde_json::json!({}), Duration::from_millis(100)).unwrap_err();
        assert!(error.contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
