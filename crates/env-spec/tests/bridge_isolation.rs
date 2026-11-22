//! The Node bridge that reads a schema is started with a `node` this crate
//! found itself and with a minimal environment: the process that runs
//! `parse_schema_file` may hold the store passphrase, and the bridge is not
//! who it is kept from only when it never sees it.
//!
//! `parse_schema_file` reads the process it runs in (`PATH`, the working
//! directory, the environment), so each test starts this very test binary
//! again as a subject (`subject` below) with exactly the process state it
//! wants, and reads what the subject printed and what the `node` it started
//! left behind. The harness copies the machine's real Node into its private
//! executable-adjacent root and names that copy explicitly; pure PATH trust
//! decisions are covered in the crate's in-process tests.
#![cfg(unix)]

mod support;

use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt as _;

use opensesame_trusted_exec::Caller;
use support::{names, Sandbox, EMPTY_DOCUMENT, OPERATOR_NODE, PASSPHRASE};

/// The subject the other tests start this binary as.
#[test]
fn subject() {
    support::subject_body();
}

/// A `node` is planted where a bare `node` lookup would find it, ahead of the
/// only trusted one; it must never run, and the bridge must still parse.
fn explicit_node_wins(path_template: &str, planted_in: &str) {
    let sandbox = Sandbox::new();
    sandbox.plant("operator", "trusted");
    sandbox.plant(planted_in, "planted");
    let path = path_template.replace("{safe}", &sandbox.path("safe").display().to_string());
    let path = path.replace("{unsafe}", &sandbox.path("unsafe").display().to_string());
    let chosen = sandbox.path("operator/node").display().to_string();
    let said = sandbox.subject_with(&path, &[(OPERATOR_NODE, chosen)]);
    if let Some(seen) = sandbox.recorded("planted") {
        panic!(
            "a node planted in `{planted_in}` ran with PATH={path}, and saw:\n{seen}\n(subject: {said})"
        );
    }
    assert_eq!(said, "ok items=0", "PATH={path}");
    assert!(
        sandbox.recorded("trusted").is_some(),
        "the trusted node did not run (PATH={path})"
    );
}

#[test]
fn an_explicit_node_wins_over_an_empty_path_entry() {
    explicit_node_wins(":{safe}", "work");
}

#[test]
fn an_explicit_node_wins_over_a_dot_path_entry() {
    explicit_node_wins(".:{safe}", "work");
}

#[test]
fn an_explicit_node_wins_over_a_relative_path_entry() {
    explicit_node_wins("./bin:{safe}", "work/bin");
}

#[test]
fn an_explicit_node_wins_over_a_world_writable_path_entry() {
    explicit_node_wins("{unsafe}:{safe}", "unsafe");
}

/// An explicit caller-owned Node remains usable with only empty and relative
/// PATH entries; the bridge is not given that untrusted PATH.
#[test]
fn an_explicit_node_runs_with_only_untrusted_path_entries() {
    let sandbox = Sandbox::new();
    sandbox.plant("operator", "trusted");
    sandbox.plant("work", "planted");
    let path = ":./bin:.:/nonexistent:";
    let chosen = sandbox.path("operator/node").display().to_string();
    let said = sandbox.subject_with(path, &[(OPERATOR_NODE, chosen)]);
    assert_eq!(said, "ok items=0", "PATH={path}");
    assert!(
        sandbox.recorded("trusted").is_some(),
        "the explicit node did not run"
    );
    assert!(sandbox.recorded("planted").is_none());
}

#[test]
fn with_no_trusted_node_the_error_says_so_and_nothing_is_run() {
    let sandbox = Sandbox::new();
    sandbox.plant("work", "cwd");
    sandbox.plant("work/bin", "relative");
    sandbox.plant("unsafe", "unsafe");
    let path = format!(":./bin:.:{}:", sandbox.path("unsafe").display());
    let said = sandbox.subject(&path);
    for label in ["cwd", "relative", "unsafe"] {
        if let Some(seen) = sandbox.recorded(label) {
            panic!("the `{label}` node ran with PATH={path}, and saw:\n{seen}\n(subject: {said})");
        }
    }
    assert!(said.starts_with("err "), "expected an error, got: {said}");
    assert!(said.contains("no usable `node`"), "{said}");
}

#[test]
fn a_no_override_absolute_node_respects_the_real_root_owner_partition() {
    let sandbox = Sandbox::new();
    sandbox.plant("safe", "candidate");
    let path = sandbox.path("safe").display().to_string();
    let said = sandbox.subject(&path);
    let root_uid = std::fs::metadata("/").unwrap().uid();
    let euid = Caller::current().euid;
    if root_uid == 0 || root_uid == euid {
        assert_eq!(said, "ok items=0", "{said}");
        assert!(sandbox.recorded("candidate").is_some());
    } else {
        assert!(said.starts_with("err "), "{said}");
        assert!(said.contains("no usable `node`"), "{said}");
        let reason = format!("is under \"/\", owned by uid {root_uid}");
        assert!(said.contains(&reason), "{reason:?} not in: {said}");
        assert!(sandbox.recorded("candidate").is_none());
    }
}

#[test]
fn the_bridge_sees_only_the_allowlisted_environment() {
    let sandbox = Sandbox::new();
    sandbox.plant("operator", "trusted");
    let chosen = sandbox.path("operator/node").display().to_string();
    let said = sandbox.subject_with(":./bin:.:/nonexistent:", &[(OPERATOR_NODE, chosen)]);
    assert_eq!(said, "ok items=0");
    let seen = sandbox.recorded("trusted").expect("the trusted node ran");
    let expected: BTreeSet<String> = ["HOME", "LANG", "LC_ALL", "TMPDIR"]
        .map(String::from)
        .into();
    assert_eq!(names(&seen), expected, "the bridge was handed:\n{seen}");
    // Values too: the passphrase appears nowhere, and an untrusted PATH is not
    // passed to the bridge at all.
    for secret in [PASSPHRASE, "operator-token-for-tests", "dummy-proxy-pass"] {
        assert!(!seen.contains(secret), "the bridge saw {secret}:\n{seen}");
    }
    assert!(
        !seen.lines().any(|line| line.starts_with("PATH=")),
        "{seen}"
    );
}

#[test]
fn a_real_node_still_parses_under_the_reduced_environment() {
    let sandbox = Sandbox::new();
    sandbox.plant("operator", "real");
    let dump = sandbox.path("out/real-node-env.json");
    std::fs::write(
        sandbox.path("work/parse.mjs"),
        format!(
            "import {{ writeFileSync }} from 'node:fs';\n\
             writeFileSync({dump:?}, JSON.stringify(Object.keys(process.env)));\n\
             process.stdout.write({EMPTY_DOCUMENT:?});\n",
            dump = dump.display().to_string()
        ),
    )
    .unwrap();
    let chosen = sandbox.path("operator/node").display().to_string();
    let said = sandbox.subject_with(":./bin:.:/nonexistent:", &[(OPERATOR_NODE, chosen)]);
    assert_eq!(said, "ok items=0");
    let keys: BTreeSet<String> =
        serde_json::from_str::<BTreeSet<String>>(&std::fs::read_to_string(&dump).unwrap())
            .expect("the stand-in bridge wrote its environment's names")
            .into_iter()
            .collect();
    let allowed: BTreeSet<String> = ["HOME", "LANG", "LC_ALL", "TMPDIR"]
        .map(String::from)
        .into();
    assert_eq!(keys, allowed);
}
