//! Pipe-captured mutations must never disclose secrets by default.
use opensesame_sealed_store::{init_store, init_store_key, unlock_store_key, Entry, StoreRoot};
use std::io::Write;
use std::process::{Command, Output, Stdio};

mod cli_app_integration_mock;

const PASSWORD: &str = "mutation-test-store-passphrase";
const OLD: &str = "old-secret-never-disclose-3mk8";
const TRAILER: &str = "private-trailer-never-disclose-7hg4\n";
const NEW: &str = "provided-new-secret-never-disclose-8pf6";

struct Fixture {
    _dir: tempfile::TempDir,
    store: std::path::PathBuf,
    witness: std::path::PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    let witness = dir.path().join("witness");
    init_store(&store, &[]).unwrap();
    let root = StoreRoot::open_with_test_witness_root(&store, &witness).unwrap();
    let key = init_store_key(&store, PASSWORD.as_bytes()).unwrap();
    for name in ["first", "second"] {
        root.insert(
            name,
            &Entry {
                secret: OLD.to_owned(),
                trailer: TRAILER.to_owned(),
                otp: None,
            },
            &key,
        )
        .unwrap();
    }
    Fixture {
        _dir: dir,
        store,
        witness,
    }
}

fn read(fixture: &Fixture, name: &str) -> Entry {
    let key = unlock_store_key(&fixture.store, PASSWORD.as_bytes()).unwrap();
    StoreRoot::open_with_test_witness_root(&fixture.store, &fixture.witness)
        .unwrap()
        .show(name, &key)
        .unwrap()
}

fn run(fixture: &Fixture, args: &[&str], input: &str) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .args(["vault", "pass"])
        .args(args)
        .arg("--path")
        .arg(&fixture.store)
        .env("OPENSESAME_STORE_PASSWORD", PASSWORD)
        .env("OPENSESAME_TEST_ROLLBACK_WITNESS_DIR", &fixture.witness)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cli_app_integration_mock::apply_journey_daemon_env(&mut command);
    let mut child = command.spawn().unwrap();
    // A rejected reveal can close stdin before reading its provided secret.
    let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
    child.wait_with_output().unwrap()
}

fn assert_private(output: &Output, secrets: &[&str]) {
    for stream in [&output.stdout, &output.stderr] {
        let text = String::from_utf8_lossy(stream);
        for secret in secrets {
            assert!(!text.contains(secret), "secret appeared in captured output");
        }
    }
}

#[test]
fn generated_password_is_stored_without_disclosure() {
    let fixture = fixture();
    let output = run(
        &fixture,
        &["generate", "fresh", "--length", "41", "--no-symbols"],
        "",
    );
    assert!(output.status.success(), "{output:?}");
    let next = read(&fixture, "fresh");
    assert_eq!(next.secret.len(), 41);
    assert!(next.secret.chars().all(|c| c.is_ascii_alphanumeric()));
    assert_private(&output, &[OLD, TRAILER.trim(), &next.secret]);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "generated fresh"
    );
}

#[test]
fn generated_and_provided_updates_change_the_store_without_disclosure() {
    for provided in [false, true] {
        let fixture = fixture();
        let mut args = vec![
            "update",
            "first",
            "--force",
            "--length",
            "43",
            "--no-symbols",
        ];
        if provided {
            args.push("--provide");
        }
        let input = format!("{NEW}\n{NEW}\n");
        let output = run(&fixture, &args, &input);
        assert!(output.status.success(), "{output:?}");
        let next = read(&fixture, "first");
        assert_ne!(next.secret, OLD);
        assert_eq!(next.trailer, TRAILER);
        if provided {
            assert_eq!(next.secret, NEW);
        } else {
            assert_eq!(next.secret.len(), 43);
        }
        assert_private(&output, &[OLD, TRAILER.trim(), NEW, &next.secret]);
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "updated first"
        );
    }
}

#[test]
fn piped_reveal_is_refused_before_any_mutation() {
    let fixture = fixture();
    let output = run(&fixture, &["generate", "fresh", "--reveal"], "");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("interactive terminals"));
    assert!(
        StoreRoot::open_with_test_witness_root(&fixture.store, &fixture.witness)
            .unwrap()
            .ls("fresh")
            .unwrap()
            .is_empty()
    );
    assert_private(&output, &[OLD, TRAILER.trim(), NEW]);
    for provided in [false, true] {
        let mut args = vec!["update", "first", "second", "--force", "--reveal"];
        if provided {
            args.push("--provide");
        }
        let output = run(&fixture, &args, &format!("{NEW}\n{NEW}\n"));
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("interactive terminals"));
        assert_private(&output, &[OLD, TRAILER.trim(), NEW]);
        for name in ["first", "second"] {
            let unchanged = read(&fixture, name);
            assert_eq!(unchanged.secret, OLD);
            assert_eq!(unchanged.trailer, TRAILER);
        }
    }
}

#[test]
fn declining_an_update_never_discloses_the_existing_entry() {
    let fixture = fixture();
    let output = run(&fixture, &["update", "first"], "n\n");
    assert!(output.status.success(), "{output:?}");
    assert_private(&output, &[OLD, TRAILER.trim()]);
    assert_eq!(read(&fixture, "first").secret, OLD);
}
