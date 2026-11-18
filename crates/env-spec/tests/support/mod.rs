//! The harness the bridge tests share: a sandbox of directories, an owned copy
//! of the machine's real Node, and a subject process that is this very test
//! binary started again with exactly the process state a test wants.
#![allow(dead_code)] // each test file uses a subset

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};

use opensesame_env_spec::parse_schema_file;
use opensesame_trusted_exec::testkit::{copy_executable, Fixture};

/// Set in the subject process only: the schema it parses.
pub const SUBJECT_SCHEMA: &str = "OPENSESAME_TEST_SUBJECT_SCHEMA";
pub const PASSPHRASE: &str = "store-passphrase-for-tests";
/// The operator's own choice of `node`.
pub const OPERATOR_NODE: &str = "OPENSESAME_NODE";
/// Held while a script is written and while a subject is started. A process
/// forked on one thread while another has a script open for writing keeps that
/// descriptor until it execs, and running the script meanwhile fails with
/// `Text file busy`.
pub static WRITING_OR_FORKING: Mutex<()> = Mutex::new(());
pub const EMPTY_DOCUMENT: &str = r#"{"schema_path":"s","parser":"stand-in","items":[]}"#;

/// The body of every test file's `subject` test: parses the schema the parent
/// named and says how it went. A plain run of the file has no schema named and
/// does nothing.
pub fn subject_body() {
    let Some(schema) = std::env::var_os(SUBJECT_SCHEMA) else {
        return;
    };
    match parse_schema_file(Path::new(&schema)) {
        Ok(doc) => println!("SUBJECT ok items={}", doc.items.len()),
        Err(e) => println!("SUBJECT err {e}"),
    }
}

pub struct Sandbox {
    _fixture: Fixture,
    root: PathBuf,
}

impl Sandbox {
    pub fn new() -> Self {
        let fixture = Fixture::new("unused");
        let root = fixture.scratch("env-spec-sandbox");
        for (dir, mode) in [
            ("work/bin", 0o700),
            ("safe", 0o700),
            ("unsafe", 0o777),
            ("operator", 0o700),
            ("out", 0o700),
        ] {
            let path = root.join(dir);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        std::fs::write(root.join("work/x.env.schema"), "# stand-in\n").unwrap();
        let out = serde_json::to_string(&root.join("out").display().to_string()).unwrap();
        let document = serde_json::to_string(EMPTY_DOCUMENT).unwrap();
        let parser = format!(
            r#"import {{ dirname, join }} from "node:path";
import {{ readFileSync, writeFileSync }} from "node:fs";
const label = readFileSync(join(dirname(process.execPath), "label"), "utf8");
const env = Object.entries(process.env)
  .map(([name, value]) => `${{name}}=${{value}}`)
  .join("\n") + "\n";
writeFileSync(join({out}, `${{label}}.env`), env);
writeFileSync(join({out}, `${{label}}.args`), process.argv.slice(1).join("\n") + "\n");
process.stdout.write({document});
"#
        );
        std::fs::write(root.join("work/parse.mjs"), parser).unwrap();
        Self {
            _fixture: fixture,
            root,
        }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// An owned exact copy of the machine's `node`, labelled so the parser
    /// records its environment and arguments before answering.
    pub fn plant(&self, dir: &str, label: &str) {
        let node = self.path(dir).join("node");
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let source = std::env::var_os(OPERATOR_NODE)
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("PATH").and_then(|path| {
                    std::env::split_paths(&path)
                        .map(|entry| entry.join("node"))
                        .find(|candidate| candidate.is_file())
                })
            })
            .expect("these tests need node on PATH or OPENSESAME_NODE");
        copy_executable(&source, &node);
        std::fs::write(self.path(dir).join("label"), label).unwrap();
    }

    /// What `label`'s `node` recorded, or `None` when it never ran.
    pub fn recorded(&self, label: &str) -> Option<String> {
        std::fs::read_to_string(self.path("out").join(format!("{label}.env"))).ok()
    }

    /// Starts the subject in `work/`, holding the passphrase and a spread of
    /// other variables, with `path` as its `PATH`. Returns what it printed.
    pub fn subject(&self, path: &str) -> String {
        self.subject_with(path, &[])
    }

    /// The arguments `label`'s `node` was started with, or `None` when it
    /// never ran.
    pub fn arguments(&self, label: &str) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(self.path("out").join(format!("{label}.args"))).ok()?;
        Some(text.lines().map(str::to_owned).collect())
    }

    /// [`Sandbox::subject`] with more variables in the subject's environment.
    pub fn subject_with(&self, path: &str, extra: &[(&str, String)]) -> String {
        let parse = (
            "OPENSESAME_ENV_PARSE",
            self.path("work/parse.mjs").display().to_string(),
        );
        let extra: Vec<_> = std::iter::once(parse)
            .chain(extra.iter().cloned())
            .collect();
        self.subject_at(&std::env::current_exe().unwrap(), path, &extra)
    }

    /// Starts `exe`, a copy of this test binary, as the subject: in `work/`,
    /// with `path` as its `PATH`, the passphrase and the other variables
    /// below, and `extra`. `OPENSESAME_ENV_PARSE` is set only if `extra` sets
    /// it. Returns what it printed.
    pub fn subject_at(&self, exe: &Path, path: &str, extra: &[(&str, String)]) -> String {
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let output = Command::new(exe)
            .args(["--exact", "subject", "--nocapture", "--test-threads=1"])
            .env_clear()
            .current_dir(self.path("work"))
            .env("PATH", path)
            .env("HOME", "/home/dummy")
            .env("TMPDIR", "/tmp")
            .env("LANG", "C.UTF-8")
            .env("LC_ALL", "C")
            .env(SUBJECT_SCHEMA, self.path("work/x.env.schema"))
            .env("OPENSESAME_STORE_PASSWORD", PASSPHRASE)
            .env("OPENSESAME_OPERATOR_TOKEN", "operator-token-for-tests")
            .env("NODE_PATH", "/nonexistent/modules")
            .env("NODE_OPTIONS", "--no-warnings")
            .env("npm_config_registry", "https://registry.invalid")
            .env("GITHUB_TOKEN", "ghp_dummy_marker_0123456789abcdef")
            .env("AWS_SECRET_ACCESS_KEY", "dummy-aws-secret")
            .env("DB_PASSWORD", "dummy-db-password")
            .env("SERVICE_API_KEY", "dummy-api-key")
            .env(
                "HTTPS_PROXY",
                "http://user:dummy-proxy-pass@proxy.invalid:3128",
            )
            .envs(extra.iter().map(|(name, value)| (name, value)))
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        // libtest prints `test subject ... ` ahead of what the test printed.
        let said = stdout.lines().find_map(|line| {
            line.split_once("SUBJECT ")
                .map(|(_, said)| said.trim().to_owned())
        });
        said.unwrap_or_else(|| {
            panic!(
                "the subject did not report: {stdout}{}",
                String::from_utf8_lossy(&output.stderr)
            )
        })
    }
}

pub fn names(recorded: &str) -> BTreeSet<String> {
    recorded
        .lines()
        .filter_map(|line| line.split_once('=').map(|(name, _)| name.to_owned()))
        .collect()
}

pub fn allowlisted() -> BTreeSet<String> {
    ["HOME", "LANG", "LC_ALL", "TMPDIR"]
        .map(String::from)
        .into()
}
