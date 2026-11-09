//! The wait in `spawned` against the real daemon, on the one failure it exists
//! for: the port `free_port` found was taken before the daemon bound it.
//!
//! The end-to-end harnesses (`aws_sts_e2e`, `helper_peer_mint`) used to poll
//! only for the daemon's socket. The daemon binds TCP before it creates the
//! socket, so a daemon whose port was taken exited at once and the harness
//! waited out its full 60 s for a socket that would never appear, then reported
//! a timeout with no cause.
#![cfg(unix)]

mod spawned;

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use spawned::{free_port, start, start_on, Process};

/// Well under the 60 s deadline: the daemon exits within a second.
const PROMPT: Duration = Duration::from_secs(20);

/// The daemon on TCP `port` and the socket `sock`, its Host refusing.
fn daemon(dir: &Path, sock: &Path, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env_clear()
        .env("HOME", dir)
        .env("OPENSESAME_ENV", "development")
        .env("NODE_ENV", "development")
        .env("OPENSESAME_ALLOW_DEV_DEFAULTS", "1")
        .env(
            "OPENSESAME_OPERATOR_TOKEN",
            "vtok_dummy_marker_operator_0123456789abcdef",
        )
        .env("OPENSESAME_HOST_API", "http://127.0.0.1:1")
        .args(["daemon", "run", "--listen", &format!("127.0.0.1:{port}")])
        .arg("--sock")
        .arg(sock);
    command
}

/// The race, forced: another process holds the daemon's port before the
/// daemon starts. The wait reports the daemon's exit at once, with its log,
/// and `start_on` brings the daemon up on the next port.
#[test]
fn a_daemon_whose_port_was_taken_is_seen_to_exit_and_starts_on_another() {
    let held = std::net::TcpListener::bind("127.0.0.1:0").expect("hold a port");
    let taken = held.local_addr().expect("address").port();
    let dir = tempfile::tempdir().expect("state dir");
    let (sock, log) = (dir.path().join("agent.sock"), dir.path().join("daemon.log"));

    let begun = Instant::now();
    let exited = Process::spawn(&mut daemon(dir.path(), &sock, taken), &log)
        .wait_for("the daemon socket", || sock.exists())
        .expect_err("a held port cannot be bound");
    let noticed = begun.elapsed();
    assert!(exited.address_in_use(), "{exited}");
    assert!(noticed < PROMPT, "noticed after {noticed:?}");

    let ports = std::iter::once(taken).chain(std::iter::repeat_with(free_port));
    let (_daemon, port) = start_on(
        ports,
        "the daemon socket",
        &log,
        |port| daemon(dir.path(), &sock, port),
        |_| sock.exists(),
    );
    assert_ne!(port, taken);
}

/// Only a taken address is tried again. A daemon that exits for any other
/// reason fails the test at once, and the failure carries the daemon's log.
#[test]
fn a_daemon_that_exits_for_another_reason_fails_the_test_at_once() {
    let dir = tempfile::tempdir().expect("state dir");
    let sock = dir.path().join("agent.sock");
    let begun = Instant::now();
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        start(
            "the daemon socket",
            &dir.path().join("daemon.log"),
            |port| {
                let mut command = daemon(dir.path(), &sock, port);
                command.arg("--no-such-flag");
                command
            },
            |_| sock.exists(),
        )
    }));
    let noticed = begun.elapsed();
    let Err(panic) = failed else {
        panic!("a daemon that exits must fail the test");
    };
    let message = panic.downcast_ref::<String>().expect("a formatted message");
    assert!(message.contains("--no-such-flag"), "{message}");
    assert!(noticed < PROMPT, "noticed after {noticed:?}");
}
