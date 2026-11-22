use clap::Parser;
use opensesame_human_vault::root_protection::ReissuedRecovery;
use opensesame_sealed_store::StoreError;

use super::super::{PassProtectCmd, PassProtectRecoveryCmd};
use super::*;

#[derive(Parser)]
struct Harness {
    #[command(subcommand)]
    cmd: PassProtectCmd,
}

fn parse(args: &[&str]) -> Result<PassProtectCmd, clap::Error> {
    Harness::try_parse_from(std::iter::once("protect").chain(args.iter().copied())).map(|h| h.cmd)
}

#[test]
fn rewrap_and_remove_rotate_unless_told_not_to() {
    let Ok(PassProtectCmd::Rewrap { no_rotate, .. }) = parse(&["rewrap", "--yes"]) else {
        panic!("rewrap parses");
    };
    assert!(!no_rotate);
    let Ok(PassProtectCmd::Remove { no_rotate, .. }) =
        parse(&["remove", "abc", "--yes", "--no-rotate"])
    else {
        panic!("remove parses");
    };
    assert!(no_rotate);
}

#[test]
fn reissuing_recovery_needs_reveal_and_a_rotation() {
    let bare = RotateArgs {
        reissue_recovery: true,
        reveal: false,
    };
    assert!(check_rotate_args(bare, false).is_err());
    let shown = RotateArgs {
        reissue_recovery: true,
        reveal: true,
    };
    assert!(check_rotate_args(shown, true).is_err());
    // Flag combination is valid. A non-terminal still refuses the reveal,
    // which is the human gate rather than a bad flag pair.
    match check_rotate_args(shown, false) {
        Ok(()) => {}
        Err(err) => {
            let message = err.to_string();
            assert!(message.contains("interactive terminals"), "{message}");
        }
    }
}

#[test]
fn a_new_passphrase_must_differ_match_and_be_nonempty() {
    assert!(check_new_passphrase("old", "old", "old").is_err());
    assert!(check_new_passphrase("old", "", "").is_err());
    assert!(check_new_passphrase("old", "new", "typo").is_err());
    assert!(check_new_passphrase("old", "new", "new").is_ok());
}

fn outcome(git_error: Option<StoreError>) -> RotationOutcome {
    RotationOutcome {
        entries: 1,
        attachments: 1,
        foreign_entries: 1,
        root_epoch: 2,
        reissued_recovery: vec![ReissuedRecovery {
            protector_id: "recovery-id".into(),
            secret: [7; 32],
            fingerprint_b64: "fingerprint".into(),
        }],
        git_error,
        git_deferred: false,
        git_notice: None,
        delivery_error: None,
    }
}

#[test]
fn git_failure_reports_the_committed_rotation_after_showing_recovery() {
    let outcome = outcome(Some(StoreError::Git("enumeration failed".into())));
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let error = report_to(
        &outcome,
        RotateArgs {
            reissue_recovery: true,
            reveal: true,
        },
        None,
        &mut stdout,
        &mut stderr,
    )
    .unwrap_err();
    let recovery = URL_SAFE_NO_PAD.encode([7; 32]);
    let stdout = String::from_utf8(stdout).unwrap();
    let stderr = String::from_utf8(stderr).unwrap();
    assert_eq!(stdout.matches(&recovery).count(), 1);
    assert!(!stderr.contains(&recovery));
    assert!(!error.to_string().contains(&recovery));
    assert!(stderr.contains("root key rotated"));
    assert!(error.to_string().contains("rotation committed"));
    assert!(error.to_string().contains("repair the repository"));
}

#[test]
fn normal_report_succeeds_and_does_not_reveal_a_recovery_key_without_reveal() {
    let outcome = outcome(None);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    report_to(
        &outcome,
        RotateArgs::default(),
        None,
        &mut stdout,
        &mut stderr,
    )
    .unwrap();
    let stdout = String::from_utf8(stdout).unwrap();
    let stderr = String::from_utf8(stderr).unwrap();
    assert!(stdout.contains("protector=recovery-id"));
    assert!(!stdout.contains(&URL_SAFE_NO_PAD.encode([7; 32])));
    assert!(stderr.contains("gpg/age entries"));
}

struct FailedWriter;

impl Write for FailedWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
    }
}

#[test]
fn failed_stderr_does_not_hide_authorized_recovery_output() {
    let outcome = outcome(None);
    let mut stdout = Vec::new();
    let error = report_to(
        &outcome,
        RotateArgs {
            reissue_recovery: true,
            reveal: true,
        },
        Some("rewrapped"),
        &mut stdout,
        &mut FailedWriter,
    )
    .unwrap_err();
    let recovery = URL_SAFE_NO_PAD.encode([7; 32]);
    assert!(String::from_utf8(stdout).unwrap().contains(&recovery));
    assert!(error.to_string().contains("rotation committed"));
    assert!(!error.to_string().contains(&recovery));
}

#[test]
fn failed_stdout_reports_committed_rotation_and_new_recovery_path_without_secret() {
    let outcome = outcome(None);
    let mut stderr = Vec::new();
    let error = report_to(
        &outcome,
        RotateArgs {
            reissue_recovery: true,
            reveal: true,
        },
        None,
        &mut FailedWriter,
        &mut stderr,
    )
    .unwrap_err();
    let message = error.to_string();
    assert!(message.contains("rotation committed"));
    assert!(message.contains("recovery output failed"));
    assert!(message.contains("recovery add --yes --reveal"));
    assert!(!message.contains("Git"));
    assert!(!message.contains(&URL_SAFE_NO_PAD.encode([7; 32])));
    let warning = String::from_utf8(stderr).unwrap();
    assert!(warning.contains("rotation committed"));
    assert!(!warning.contains(&URL_SAFE_NO_PAD.encode([7; 32])));
}

#[test]
fn failed_stdout_and_stderr_never_panic_or_change_delivery_error() {
    let outcome = outcome(None);
    let delivery = write_recovery_output(
        &outcome,
        RotateArgs {
            reissue_recovery: true,
            reveal: true,
        },
        &mut FailedWriter,
    );
    let error = warn_delivery_failure(delivery, &mut FailedWriter).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
}

#[test]
fn deferred_git_is_reported_after_recovery_keys_are_delivered() {
    let mut outcome = outcome(None);
    outcome.git_deferred = true;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let error = report_to(
        &outcome,
        RotateArgs {
            reissue_recovery: true,
            reveal: true,
        },
        None,
        &mut stdout,
        &mut stderr,
    )
    .unwrap_err();
    let recovery = URL_SAFE_NO_PAD.encode([7; 32]);
    assert!(String::from_utf8(stdout).unwrap().contains(&recovery));
    assert!(error.to_string().contains("Git was deferred"));
    assert!(!error.to_string().contains(&recovery));
    assert!(!String::from_utf8(stderr).unwrap().contains(&recovery));
}

#[test]
fn git_failure_without_reissued_keys_and_success_with_reveal_are_reported() {
    let mut failure = outcome(Some(StoreError::Git("enumeration failed".into())));
    failure.reissued_recovery.clear();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let error = report_to(
        &failure,
        RotateArgs::default(),
        None,
        &mut stdout,
        &mut stderr,
    )
    .unwrap_err();
    assert!(stdout.is_empty());
    assert!(error.to_string().contains("rotation committed"));

    let success = outcome(None);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    report_to(
        &success,
        RotateArgs {
            reissue_recovery: true,
            reveal: true,
        },
        None,
        &mut stdout,
        &mut stderr,
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(stdout)
            .unwrap()
            .matches(&URL_SAFE_NO_PAD.encode([7; 32]))
            .count(),
        1
    );
}

/// A recovery key on argv lands in shell history and `/proc/<pid>/cmdline`.
#[test]
fn recovery_test_refuses_the_secret_on_argv() {
    assert!(parse(&["recovery", "test", "AAAA"]).is_err());
    assert!(matches!(
        parse(&["recovery", "test"]),
        Ok(PassProtectCmd::Recovery {
            cmd: PassProtectRecoveryCmd::Test { .. }
        })
    ));
}
