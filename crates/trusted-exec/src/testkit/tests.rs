use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::process::Command;
use std::sync::Barrier;
use std::thread;

use super::Fixture;

const THREADS: usize = 8;
const ROUNDS: usize = 40;

#[test]
fn fixtures_are_isolated_private_and_owned_by_the_executing_user() {
    let first = Fixture::new("first");
    let second = Fixture::new("second");
    assert_ne!(first.root, second.root);

    let metadata = std::fs::metadata(&first.root).expect("fixture metadata");
    // SAFETY: these calls take no arguments and cannot fail.
    let (euid, egid) = unsafe { (libc::geteuid(), libc::getegid()) };
    assert_eq!(metadata.uid(), euid);
    assert_eq!(metadata.gid(), egid);
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
}

/// Writes a stub and runs it at once, `ROUNDS` times.
fn write_and_run(barrier: &Barrier) {
    barrier.wait();
    for round in 0..ROUNDS {
        let fixture = Fixture::new("stub");
        let stub = fixture.trusted.join("stub");
        fixture.stub_recorder_saying(&stub, "ran");
        let output = Command::new(&stub)
            .output()
            .unwrap_or_else(|why| panic!("round {round}: {why}"));
        assert_eq!(output.stdout, b"ran", "round {round}");
    }
}

/// A stub run the moment it is written starts, while other threads of the
/// same test binary are starting programs of their own.
#[test]
fn a_stub_runs_the_moment_it_is_written_while_other_threads_start_programs() {
    let barrier = Barrier::new(THREADS);
    thread::scope(|scope| {
        for _ in 0..THREADS {
            scope.spawn(|| write_and_run(&barrier));
        }
    });
}
