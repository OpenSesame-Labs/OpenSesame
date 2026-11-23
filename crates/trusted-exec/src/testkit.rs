//! A planted `PATH` for the tests of code that starts a program (feature
//! `testkit`, Unix only).
//!
//! [`Fixture::new`] makes a directory anyone can write holding a `program`
//! that leaves a marker if it ever runs, followed on `PATH` by a private
//! directory holding a `program` that writes its environment and arguments
//! down and exits 0. [`Fixture::lookup`] is a parent environment with that
//! `PATH` and the secrets and loader settings no child may be handed
//! ([`HOSTILE`]); hand it to the code's `*_in` builder, run the command, and
//! read what happened.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{Read, Seek, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::{Caller, Lookup, Platform};

/// The dummy secret a parent holds that must never reach a child.
pub const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";

/// A parent environment no child may inherit any of: the Host's keys, a
/// GitHub App key, cloud credentials and git's own redirections.
pub const HOSTILE: [(&str, &str); 8] = [
    ("OPENSESAME_CONNECTION_KEY", SECRET),
    ("OPENSESAME_STORE_PASSWORD", SECRET),
    ("GITHUB_APP_PRIVATE_KEY", SECRET),
    ("AWS_SECRET_ACCESS_KEY", SECRET),
    ("GIT_CONFIG_PARAMETERS", "'core.pager'='planted'"),
    ("GIT_CONFIG_COUNT", "1"),
    ("GIT_EXEC_PATH", "/nonexistent/planted-exec-path"),
    ("GIT_DIR", "/nonexistent/planted-git-dir"),
];

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A fresh private directory beside this test executable.
///
/// The system temporary directory is not necessarily a trusted ancestor. In
/// sandboxed builds it can be a sticky directory owned by a remapped uid, and
/// production must continue to reject that ownership. Cargo's test executable
/// lives below its caller-owned target directory, so a directory created next
/// to it has the same trusted ancestry as the executable being tested.
fn private_root() -> PathBuf {
    let executable = std::env::current_exe().expect("test executable");
    let parent = executable.parent().expect("test executable directory");
    loop {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = parent.join(format!(".trusted-exec-{}-{n}", std::process::id()));
        match std::fs::DirBuilder::new().mode(0o700).create(&root) {
            Ok(()) => {
                let owner = std::fs::metadata(&root).expect("fixture directory metadata");
                // SAFETY: these calls take no arguments and cannot fail.
                let (user, group) = unsafe { (libc::geteuid(), libc::getegid()) };
                assert_eq!(owner.uid(), user, "fixture directory owner");
                assert_eq!(owner.gid(), group, "fixture directory group");
                return root;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => panic!("fixture directory: {error}"),
        }
    }
}

/// Copy exact bytes from a pinned canonical regular executable into a new
/// caller-owned 0500 file, refusing a final-component link at open.
///
/// # Panics
///
/// Panics when the source is not a readable regular executable or the copy
/// cannot be created, verified, or read back byte for byte.
pub fn copy_executable(source: &Path, destination: &Path) {
    let source = source.canonicalize().expect("canonical executable");
    let mut source = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(source)
        .expect("open canonical executable without following links");
    let source_meta = source.metadata().expect("executable metadata");
    assert!(source_meta.is_file(), "source executable is a regular file");
    assert_ne!(source_meta.mode() & 0o111, 0, "source is executable");
    let mut prefix = [0_u8; 2];
    source.read_exact(&mut prefix).expect("executable prefix");
    assert_ne!(prefix, *b"#!", "source must not use an interpreter");
    source.rewind().expect("rewind source executable");

    let mut copy = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o500)
        .open(destination)
        .expect("create executable copy");
    assert_eq!(
        std::io::copy(&mut source, &mut copy).expect("copy executable"),
        source_meta.len()
    );
    copy.sync_all().expect("sync executable copy");
    let copied = copy.metadata().expect("copied executable metadata");
    // SAFETY: `geteuid` takes no arguments and cannot fail.
    assert_eq!(copied.uid(), unsafe { libc::geteuid() });
    assert!(copied.is_file(), "copy is a regular file");
    assert_eq!(copied.nlink(), 1, "copy has one link");
    assert_eq!(copied.mode() & 0o777, 0o500, "copy mode");
    assert_eq!(copied.len(), source_meta.len(), "copy length");

    source.rewind().expect("rewind source executable");
    copy.rewind().expect("rewind executable copy");
    let mut source_chunk = vec![0_u8; 64 * 1024];
    let mut copy_chunk = vec![0_u8; 64 * 1024];
    loop {
        let source_read = source
            .read(&mut source_chunk)
            .expect("read source executable");
        let copy_read = copy.read(&mut copy_chunk).expect("read executable copy");
        assert_eq!(copy_read, source_read, "copy read length");
        assert_eq!(
            copy_chunk[..copy_read],
            source_chunk[..source_read],
            "copy bytes"
        );
        if source_read == 0 {
            break;
        }
    }
    drop(copy);
    let named = std::fs::symlink_metadata(destination).expect("named executable copy");
    assert_eq!(
        (named.dev(), named.ino()),
        (copied.dev(), copied.ino()),
        "named executable is the opened copy"
    );
}

/// Caller-owned private ancestry for cross-process tests that need an exact
/// compiled executable rather than a shebang fixture.
pub struct ExecutableFixture {
    root: PathBuf,
}

impl ExecutableFixture {
    #[must_use]
    pub fn new() -> Self {
        Self {
            root: private_root(),
        }
    }

    /// Copy `source` into this fixture under `name` and return the exact path.
    #[must_use]
    pub fn copy(&self, source: impl AsRef<Path>, name: &str) -> PathBuf {
        let destination = self.root.join(name);
        copy_executable(source.as_ref(), &destination);
        destination
    }
}

impl Default for ExecutableFixture {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ExecutableFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The two directories, what the stubs leave behind, and the stub's name.
pub struct Fixture {
    root: PathBuf,
    pub planted: PathBuf,
    pub trusted: PathBuf,
    pub marker: PathBuf,
    pub dump: PathBuf,
    pub program: String,
}

fn write_script(path: &Path, body: &str, mode: u32) {
    // A child writes the stub, never a descriptor of this process. While this
    // process holds a file open for writing, any test thread that forks to
    // start a program hands that descriptor to its child until the child
    // execs, and exec'ing the stub fails with `ETXTBSY` meanwhile; syncing
    // before close does not shorten that window. The pipe to the child is
    // close-on-exec, so no other child keeps it. `cat` is named by its path:
    // a test may have pointed this process's `PATH` at fixture directories.
    let mut writer = Command::new("/bin/sh")
        .args(["-c", "/bin/cat > \"$1\"", "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .expect("write stub");
    writer
        .stdin
        .take()
        .expect("stub writer stdin")
        .write_all(format!("#!/bin/sh\n{body}\n").as_bytes())
        .expect("write stub");
    assert!(writer.wait().expect("write stub").success(), "write stub");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod stub");
}

impl Fixture {
    /// A planted and a trusted `program`, the planted one first on `PATH`.
    ///
    /// # Panics
    ///
    /// When the temporary directories or stubs cannot be written.
    #[must_use]
    pub fn new(program: &str) -> Self {
        let root = private_root();
        let (planted, trusted) = (root.join("planted"), root.join("trusted"));
        for dir in [&planted, &trusted] {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(dir)
                .expect("fixture directory");
        }
        std::fs::set_permissions(&planted, std::fs::Permissions::from_mode(0o777)).expect("chmod");
        let fixture = Self {
            marker: root.join("planted-ran"),
            dump: root.join("dump"),
            planted,
            trusted,
            root,
            program: program.to_owned(),
        };
        fixture.stub_planted(&fixture.planted);
        fixture.stub_recorder(&fixture.trusted.join(program));
        fixture
    }

    /// A `program` in `dir` that leaves the marker if it ever runs.
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_planted(&self, dir: &Path) {
        let body = format!("echo planted > '{}'\nexit 0", self.marker.display());
        write_script(&dir.join(&self.program), &body, 0o755);
    }

    /// A program at `path` that writes its environment, then its arguments
    /// after a `--args--` line, to the dump file and exits 0.
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_recorder(&self, path: &Path) {
        self.stub_recorder_saying(path, "");
    }

    /// [`Fixture::stub_recorder`] that also prints `stdout` (a line a caller
    /// parses, such as a remote's URL).
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_recorder_saying(&self, path: &Path, stdout: &str) {
        self.stub_recorder_with(path, ":", stdout);
    }

    /// [`Fixture::stub_recorder_saying`] that first runs the shell line
    /// `first` (`/bin/cat > /dev/null` for a program fed on stdin).
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_recorder_with(&self, path: &Path, first: &str, stdout: &str) {
        let dump = self.dump.display();
        let body = format!(
            "{first}\n/usr/bin/env > '{dump}'\necho --args-- >> '{dump}'\nfor a in \"$@\"; do echo \"$a\" >> '{dump}'; done\nprintf '%s' '{stdout}'\nexit 0"
        );
        write_script(path, &body, 0o755);
    }

    /// `PATH` = planted then trusted, a `HOME`, [`HOSTILE`], then `extra`.
    ///
    /// # Panics
    ///
    /// When the two directories cannot be joined into a `PATH`.
    #[must_use]
    pub fn lookup(&self, extra: &[(&str, &str)]) -> Lookup {
        let path = std::env::join_paths([&self.planted, &self.trusted]).expect("PATH");
        let mut caller = Caller::current();
        // User-namespace sandboxes can expose their immutable filesystem root
        // as an unmapped uid (commonly 65534). The fixture itself and every
        // writable ancestor still have the executing uid checked above; this
        // test-only exception models the namespace root without weakening the
        // production caller captured by `Lookup::capture`.
        let namespace_root = std::fs::metadata("/").expect("filesystem root metadata");
        caller.trust_fixture_owner(namespace_root.uid());
        let mut vars = vec![
            (OsString::from("PATH"), path),
            (OsString::from("HOME"), self.root.clone().into_os_string()),
        ];
        for (name, value) in HOSTILE.iter().chain(extra) {
            vars.push((OsString::from(name), OsString::from(value)));
        }
        Lookup {
            vars,
            cwd: None,
            platform: Platform::Unix,
            caller,
        }
    }

    /// A new private directory `name` inside the fixture, removed with it.
    ///
    /// # Panics
    ///
    /// When it cannot be made.
    #[must_use]
    pub fn scratch(&self, name: &str) -> PathBuf {
        let dir = self.root.join(name);
        std::fs::create_dir_all(&dir).expect("scratch directory");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        dir
    }

    /// Whether the planted program ran.
    #[must_use]
    pub fn planted_ran(&self) -> bool {
        self.marker.exists()
    }

    /// The environment the recording stub was given, if it ran.
    #[must_use]
    pub fn env(&self) -> Option<BTreeMap<String, String>> {
        let text = std::fs::read_to_string(&self.dump).ok()?;
        let env = text.split("\n--args--\n").next()?;
        Some(
            env.lines()
                .filter_map(|line| line.split_once('='))
                .map(|(n, v)| (n.to_owned(), v.to_owned()))
                .collect(),
        )
    }

    /// The arguments the recording stub was given, if it ran.
    #[must_use]
    pub fn args(&self) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(&self.dump).ok()?;
        let (_, args) = text.split_once("--args--\n")?;
        Some(args.lines().map(str::to_owned).collect())
    }

    /// Fails the test when the planted program ran, the recorder did not, or
    /// any part of [`HOSTILE`] reached it; returns what it was given.
    ///
    /// # Panics
    ///
    /// On any of those.
    #[must_use]
    pub fn assert_clean(&self) -> BTreeMap<String, String> {
        assert!(!self.planted_ran(), "the planted {} ran", self.program);
        let env = self
            .env()
            .unwrap_or_else(|| panic!("the trusted {} did not run", self.program));
        for (name, _) in HOSTILE {
            assert!(!env.contains_key(name), "{name} reached {}", self.program);
        }
        assert!(
            !env.values().any(|value| value.contains(SECRET)),
            "the dummy secret reached {}",
            self.program
        );
        env
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
mod tests;
