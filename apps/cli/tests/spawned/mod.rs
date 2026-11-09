//! A child process a test starts on a loopback port, and a wait for it that
//! notices when the child has exited.
//!
//! [`free_port`] finds a port by binding port 0 and letting it go, so another
//! process can take the port before the child binds it. A child that cannot
//! bind exits at once (the daemon binds TCP before it creates its socket), and
//! a wait that only polls for readiness then runs out its whole deadline and
//! reports a timeout with no cause. [`Process::wait_for`] checks the child on
//! every poll instead. [`start`] fails the test at once with the child's log
//! when it exits, unless the address was in use, which it tries again on a
//! fresh port.
#![allow(dead_code)]

use std::fmt;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// How long a child has to become ready.
const DEADLINE: Duration = Duration::from_mins(1);
/// How many ports [`start`] tries when each one turns out to be taken.
const ATTEMPTS: usize = 3;
/// How the OS describes `EADDRINUSE`, in the error a child prints on exit.
const ADDRESS_IN_USE: &str = "Address already in use";

/// A loopback port nothing was listening on a moment ago.
pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("address")
        .port()
}

/// A child process that is killed when the test ends, however it ends.
pub struct Process {
    child: Child,
    log: PathBuf,
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A child that exited before it was ready.
pub struct Exited {
    pub status: ExitStatus,
    pub log: String,
}

impl Exited {
    /// The child exited because another process held its address.
    pub fn address_in_use(&self) -> bool {
        self.log.contains(ADDRESS_IN_USE)
    }
}

impl fmt::Display for Exited {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "exited with {} before it was ready; its log:\n{}",
            self.status, self.log
        )
    }
}

impl Process {
    /// Start `command` with its stdout and stderr in `log`.
    pub fn spawn(command: &mut Command, log: &Path) -> Self {
        let out = File::create(log).expect("log file");
        let err = out.try_clone().expect("log handle");
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()
            .expect("spawn the child");
        Self {
            child,
            log: log.to_path_buf(),
        }
    }

    /// What the child has written so far.
    pub fn log(&self) -> String {
        String::from_utf8_lossy(&std::fs::read(&self.log).unwrap_or_default()).into_owned()
    }

    /// Poll `ready` until it holds. `Err` as soon as the child has exited;
    /// a panic carrying the child's log when the deadline passes first.
    pub fn wait_for(&mut self, what: &str, mut ready: impl FnMut() -> bool) -> Result<(), Exited> {
        let deadline = Instant::now() + DEADLINE;
        loop {
            if let Some(status) = self.child.try_wait().expect("poll the child") {
                return Err(Exited {
                    status,
                    log: self.log(),
                });
            }
            if ready() {
                return Ok(());
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; its log:\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// Start the child `command` builds for a free loopback port and wait until
/// `ready` holds for that port. See [`start_on`].
pub fn start(
    what: &str,
    log: &Path,
    command: impl FnMut(u16) -> Command,
    ready: impl FnMut(u16) -> bool,
) -> (Process, u16) {
    start_on(std::iter::repeat_with(free_port), what, log, command, ready)
}

/// [`start`] on the ports `ports` yields, in order. A child that exits on a
/// taken address is started again on the next port, up to [`ATTEMPTS`]
/// times; any other exit fails the test at once with the child's log.
pub fn start_on(
    mut ports: impl Iterator<Item = u16>,
    what: &str,
    log: &Path,
    mut command: impl FnMut(u16) -> Command,
    mut ready: impl FnMut(u16) -> bool,
) -> (Process, u16) {
    let mut attempt = 1;
    loop {
        let port = ports.next().expect("a port to try");
        let mut process = Process::spawn(&mut command(port), log);
        match process.wait_for(what, || ready(port)) {
            Ok(()) => return (process, port),
            Err(exited) if exited.address_in_use() && attempt < ATTEMPTS => {
                eprintln!(
                    "{what}: port {port} was taken before the child bound it; \
                     trying another. The child {exited}"
                );
                attempt += 1;
            }
            Err(exited) => panic!("{what} on port {port}: the child {exited}"),
        }
    }
}
