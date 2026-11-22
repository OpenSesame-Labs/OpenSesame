//! `opensesame dev run` reads the schema through the Node bridge, in the
//! process that may hold the store passphrase. The bridge gets a `node` that
//! only absolute, trusted `PATH` entries can supply and a minimal environment;
//! the child that finally runs gets what it always got.
//!
//! The test copies the machine's exact `node` executable into its private
//! executable-adjacent fixture and uses a tiny parser module that records the
//! environment and answers with a one-item document.
#![cfg(unix)]

use std::collections::BTreeSet;
use std::io::{Read as _, Seek as _};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Mutex, PoisonError};

use opensesame_trusted_exec::testkit::Fixture;

const BIN: &str = env!("CARGO_BIN_EXE_opensesame");
const PASSPHRASE: &str = "store-passphrase-for-tests";
const DOCUMENT: &str = r#"{"schema_path":"s","parser":"stand-in","items":[{"key":"API_URL","sensitive":false,"required":false,"public":true,"value":"http://localhost:3000","resolver":null,"decorators":[]}]}"#;

/// Held while a script is written and while a run is started: a process forked
/// on one thread while another has a script open for writing keeps that
/// descriptor until it execs, and running the script meanwhile fails with
/// `Text file busy`.
static WRITING_OR_FORKING: Mutex<()> = Mutex::new(());

fn fixture_github_token() -> String {
    "T".repeat(33)
}

struct Sandbox {
    _fixture: Fixture,
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let fixture = Fixture::new("unused");
        let root = fixture.scratch("bridge-sandbox");
        for (name, mode) in [
            ("work/bin", 0o700),
            ("trusted", 0o700),
            ("shim", 0o700),
            ("open", 0o777),
            ("out", 0o700),
        ] {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        std::fs::write(root.join("work/x.env.schema"), "# stand-in\n").unwrap();
        let out = serde_json::to_string(&root.join("out").display().to_string()).unwrap();
        let document = serde_json::to_string(DOCUMENT).unwrap();
        let parser = format!(
            r#"import {{ dirname, join }} from "node:path";
import {{ readFileSync, writeFileSync }} from "node:fs";
const label = readFileSync(join(dirname(process.execPath), "label"), "utf8");
const body = Object.entries(process.env)
  .map(([name, value]) => `${{name}}=${{value}}`)
  .join("\n") + "\n";
writeFileSync(join({out}, `${{label}}.env`), body);
process.stdout.write({document});
"#
        );
        std::fs::write(root.join("work/parse.mjs"), parser).unwrap();
        Self {
            _fixture: fixture,
            root,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// An owned exact copy of the machine's `node`, labelled so the parser
    /// writes its environment to `out/<label>.env`.
    fn plant(&self, dir: &str, label: &str) -> PathBuf {
        let node = self.path(dir).join("node");
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let source = std::env::var_os("OPENSESAME_NODE")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("PATH").and_then(|path| {
                    std::env::split_paths(&path)
                        .map(|dir| dir.join("node"))
                        .find(|candidate| candidate.is_file())
                })
            })
            .expect("these tests need node on PATH or OPENSESAME_NODE")
            .canonicalize()
            .expect("canonical node executable");
        let mut source = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&source)
            .expect("open canonical node executable without following links");
        let source_meta = source.metadata().unwrap();
        assert!(source_meta.is_file());
        assert_ne!(source_meta.mode() & 0o111, 0);
        let mut prefix = [0_u8; 2];
        source.read_exact(&mut prefix).unwrap();
        assert_ne!(prefix, *b"#!", "node source must not use an interpreter");
        source.rewind().unwrap();

        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o500)
            .open(&node)
            .unwrap();
        assert_eq!(
            std::io::copy(&mut source, &mut file).unwrap(),
            source_meta.len()
        );
        file.sync_all().unwrap();
        let opened = file.metadata().unwrap();
        // SAFETY: `geteuid` takes no arguments and cannot fail.
        assert_eq!(opened.uid(), unsafe { libc::geteuid() });
        assert!(opened.is_file());
        assert_eq!(opened.nlink(), 1);
        assert_eq!(opened.mode() & 0o777, 0o500);
        assert_eq!(opened.len(), source_meta.len());
        source.rewind().unwrap();
        file.rewind().unwrap();
        let mut source_chunk = [0_u8; 64 * 1024];
        let mut copy_chunk = [0_u8; 64 * 1024];
        loop {
            let source_read = source.read(&mut source_chunk).unwrap();
            let copy_read = file.read(&mut copy_chunk).unwrap();
            assert_eq!(copy_read, source_read);
            assert_eq!(copy_chunk[..copy_read], source_chunk[..source_read]);
            if source_read == 0 {
                break;
            }
        }
        drop(file);
        let named = std::fs::symlink_metadata(&node).unwrap();
        assert_eq!((named.dev(), named.ino()), (opened.dev(), opened.ino()));
        std::fs::write(self.path(dir).join("label"), label).unwrap();
        node
    }

    fn run_with_owned_node(&self, agent: bool, path: &str) -> Output {
        let node = self.plant("shim", "bridge").display().to_string();
        self.run_with(agent, path, &[("OPENSESAME_NODE", node)])
    }

    fn recorded(&self, label: &str) -> Option<String> {
        std::fs::read_to_string(self.path("out").join(format!("{label}.env"))).ok()
    }

    /// `dev [--agent] run -- sh -c 'env > out/child.env'`, in `work/`, from a
    /// process that holds the passphrase and a spread of other secrets, with
    /// `path` as its `PATH`.
    fn run(&self, agent: bool, path: &str) -> Output {
        self.run_with(agent, path, &[])
    }

    /// [`Sandbox::run`] with more variables in the process that runs it.
    fn run_with(&self, agent: bool, path: &str, extra: &[(&str, String)]) -> Output {
        let mut command = Command::new(BIN);
        command.arg("dev");
        if agent {
            command.arg("--agent");
        }
        command
            .arg("--schema")
            .arg(self.path("work/x.env.schema"))
            .args(["run", "--", "/bin/sh", "-c", "/usr/bin/env > \"$1\"", "sh"])
            .arg(self.path("out/child.env"))
            .env_clear()
            .current_dir(self.path("work"))
            .env("PATH", path)
            .env("HOME", self.path("home"))
            .env("LANG", "C.UTF-8")
            .env("OPENSESAME_ENV_PARSE", self.path("work/parse.mjs"))
            .env("OPENSESAME_PLUGINS_FILE", self.path("plugins.json"))
            .env("OPENSESAME_STORE_PASSWORD", PASSPHRASE)
            .env("OPENSESAME_OPERATOR_TOKEN", "operator-token-for-tests")
            .env("NODE_PATH", "/nonexistent/modules")
            .env("GITHUB_TOKEN", fixture_github_token())
            .env(
                "HTTPS_PROXY",
                "http://user:dummy-proxy-pass@proxy.invalid:3128",
            );
        command.envs(extra.iter().map(|(name, value)| (name, value)));
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        command.output().unwrap()
    }
}

fn names(recorded: &str) -> BTreeSet<String> {
    recorded
        .lines()
        .filter_map(|line| line.split_once('=').map(|(name, _)| name.to_owned()))
        .collect()
}

fn said(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// The bridge's whole environment, as `names` reads it.
fn bridge_names(sandbox: &Sandbox) -> BTreeSet<String> {
    let seen = sandbox.recorded("bridge").expect("the trusted node ran");
    assert!(!seen.contains(PASSPHRASE), "the bridge saw:\n{seen}");
    names(&seen)
}

fn allowed() -> BTreeSet<String> {
    ["HOME", "LANG"].map(String::from).into()
}

#[test]
fn the_bridge_gets_a_minimal_environment_and_the_child_gets_what_it_always_got() {
    let sandbox = Sandbox::new();
    let path = ":./bin:.:/nonexistent:";
    let output = sandbox.run_with_owned_node(false, path);
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());

    let child = std::fs::read_to_string(sandbox.path("out/child.env")).unwrap();
    for line in [
        format!("PATH={path}"),
        format!("OPENSESAME_STORE_PASSWORD={PASSPHRASE}"),
        "OPENSESAME_OPERATOR_TOKEN=operator-token-for-tests".to_owned(),
        "NODE_PATH=/nonexistent/modules".to_owned(),
        format!("GITHUB_TOKEN={}", fixture_github_token()),
        "HTTPS_PROXY=http://user:dummy-proxy-pass@proxy.invalid:3128".to_owned(),
        "API_URL=http://localhost:3000".to_owned(),
    ] {
        assert!(child.lines().any(|l| l == line), "missing {line}:\n{child}");
    }
}

/// The integration harness names its caller-owned Node copy explicitly. PATH
/// trust decisions remain covered in-process with a synthetic caller.
#[test]
fn an_owned_explicit_node_runs_without_trusting_the_namespace_root() {
    let sandbox = Sandbox::new();
    let _ = sandbox.plant("work", "in-cwd");
    let path = ":./bin:.:/nonexistent:";
    let output = sandbox.run_with_owned_node(true, path);
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());
    assert!(sandbox.recorded("in-cwd").is_none());
}

/// `OPENSESAME_NODE` names the exact file, so it is used wherever it is, even
/// when no `PATH` entry could supply a `node`, and it is not forwarded to the
/// bridge.
#[test]
fn an_operator_named_node_is_used_in_a_directory_anyone_can_write() {
    let sandbox = Sandbox::new();
    let _ = sandbox.plant("open", "bridge");
    std::fs::set_permissions(
        sandbox.path("open/node"),
        std::fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let chosen = sandbox.path("open/node").display().to_string();
    let output = sandbox.run_with(
        true,
        ":./bin:.:/nonexistent:",
        &[("OPENSESAME_NODE", chosen)],
    );
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());
}

#[test]
fn an_operator_named_node_wins_over_a_relative_one_on_path() {
    let sandbox = Sandbox::new();
    let _ = sandbox.plant("work/bin", "on-path");
    let _ = sandbox.plant("open", "bridge");
    let chosen = sandbox.path("open/node").display().to_string();
    let output = sandbox.run_with(
        true,
        ":./bin:.:/nonexistent:",
        &[("OPENSESAME_NODE", chosen)],
    );
    assert!(output.status.success(), "{}", said(&output));
    assert!(sandbox.recorded("on-path").is_none(), "PATH's node ran");
    assert_eq!(bridge_names(&sandbox), allowed());
}

#[test]
fn a_bad_operator_value_stops_the_run_by_name_and_never_falls_back_to_path() {
    for value in ["", "node", "./node", "/nonexistent/node"] {
        let sandbox = Sandbox::new();
        let _ = sandbox.plant("work/bin", "on-path");
        let output = sandbox.run_with(
            true,
            ":./bin:.:/nonexistent:",
            &[("OPENSESAME_NODE", value.to_owned())],
        );
        let said = said(&output);
        assert!(!output.status.success(), "{value:?}: {said}");
        assert!(said.contains("OPENSESAME_NODE"), "{value:?}: {said}");
        assert!(
            sandbox.recorded("on-path").is_none(),
            "{value:?}: PATH's node ran after a bad OPENSESAME_NODE"
        );
        assert!(
            !sandbox.path("out/child.env").exists(),
            "{value:?}: the child ran"
        );
    }
}

#[test]
fn an_agent_child_loses_only_the_store_passphrase_as_before() {
    let sandbox = Sandbox::new();
    let output = sandbox.run_with_owned_node(true, ":./bin:.:/nonexistent:");
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());

    let child = std::fs::read_to_string(sandbox.path("out/child.env")).unwrap();
    assert!(!child.contains("OPENSESAME_STORE_PASSWORD"), "{child}");
    assert!(!child.contains(PASSPHRASE), "{child}");
    let github_line = format!("GITHUB_TOKEN={}", fixture_github_token());
    for line in [
        "OPENSESAME_OPERATOR_TOKEN=operator-token-for-tests",
        github_line.as_str(),
        "NODE_PATH=/nonexistent/modules",
        "API_URL=http://localhost:3000",
    ] {
        assert!(child.lines().any(|l| l == line), "missing {line}:\n{child}");
    }
}

#[test]
fn an_explicit_node_wins_over_nodes_at_empty_and_relative_path_entries() {
    let sandbox = Sandbox::new();
    let _ = sandbox.plant("work", "in-cwd");
    let _ = sandbox.plant("work/bin", "relative");
    let output = sandbox.run_with_owned_node(true, ":./bin:.:/nonexistent:");
    assert!(output.status.success(), "{}", said(&output));
    for label in ["in-cwd", "relative"] {
        if let Some(seen) = sandbox.recorded(label) {
            panic!("the node planted as `{label}` ran, and saw:\n{seen}");
        }
    }
    assert_eq!(bridge_names(&sandbox), allowed());
}

#[test]
fn with_no_trusted_node_the_run_stops_before_the_child_and_says_so() {
    let sandbox = Sandbox::new();
    let _ = sandbox.plant("work", "in-cwd");
    let _ = sandbox.plant("work/bin", "relative");
    let output = sandbox.run(true, ":./bin:.:/nonexistent:");
    let said = said(&output);
    assert!(!output.status.success(), "{said}");
    assert!(said.contains("env-spec parse failed"), "{said}");
    assert!(said.contains("no usable `node`"), "{said}");
    for label in ["in-cwd", "relative"] {
        if let Some(seen) = sandbox.recorded(label) {
            panic!("the node planted as `{label}` ran, and saw:\n{seen}");
        }
    }
    assert!(
        !sandbox.path("out/child.env").exists(),
        "the child ran without a schema"
    );
}
