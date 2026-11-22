//! `pass protect rewrap | remove | root-rotate` — the verbs that change who can
//! open the store, and therefore rotate the root key by default.
//!
//! Rewrapping or removing a protector without a new root is not revocation:
//! the store's history (and any pushed remote) keeps the previous
//! `.opensesame-key`, and its wrap still opens the unchanged root. So both
//! verbs re-encrypt the store under a new root unless `--no-rotate` is given,
//! and then they say plainly that nothing was revoked.

use std::io::{self, Write};
use std::path::Path;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use opensesame_sealed_store::{
    protect_remove_store, protect_rewrap_store_password, rotate_store_root_with_commit,
    RotationEdit, RotationGitNotice, RotationOutcome,
};

use super::require_yes;
use crate::store::{prompt_password, prompt_secret_hidden, require_reveal, resolve_root};

/// Flags shared by every verb that can rotate the root key.
#[derive(clap::Args, Debug, Default, Clone, Copy)]
pub struct RotateArgs {
    /// Replace each recovery key with a new one; a recovery wrap cannot follow
    /// a new root without its secret. Requires --reveal.
    #[arg(long)]
    pub reissue_recovery: bool,
    /// Print each reissued recovery key once.
    #[arg(long)]
    pub reveal: bool,
}

const NOT_REVOKED: &str = "warning: the root key was NOT rotated (--no-rotate). The previous \
     .opensesame-key is still in this store's git history and any pushed remote, and its wrap \
     still opens every entry. Run `opensesame pass protect root-rotate --yes` to revoke it.";

const HISTORY_NOTE: &str = "note: ciphertext already in git history (and any pushed remote) \
     still opens with the previous root; rotation covers the current store and everything \
     written from now on, not history";

const RECOVERY_OUTPUT_FAILURE: &str = "root rotation committed, but recovery output failed; \
     fix output, unlock the current store, and add a new recovery key with \
     `opensesame vault pass protect recovery add --yes --reveal`. Do not retry the rotation.";

fn check_rotate_args(args: RotateArgs, no_rotate: bool) -> anyhow::Result<()> {
    if args.reissue_recovery && no_rotate {
        anyhow::bail!("--reissue-recovery only applies to a rotation; drop --no-rotate");
    }
    if args.reissue_recovery && !args.reveal {
        anyhow::bail!("--reissue-recovery prints the new recovery key once; pass --reveal");
    }
    if args.reveal {
        require_reveal(true)?;
    }
    Ok(())
}

pub fn cmd_protect_rewrap(
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    no_rotate: bool,
    args: RotateArgs,
) -> anyhow::Result<()> {
    require_yes(yes, "rewrap")?;
    check_rotate_args(args, no_rotate)?;
    let root = resolve_root(path, tomb)?;
    let old = prompt_password("Current store passphrase")?;
    let new = read_new_passphrase(&old)?;
    if no_rotate {
        protect_rewrap_store_password(&root, old.as_bytes(), new.as_bytes())?;
        eprintln!("rewrapped the password protector; the root key is unchanged");
        eprintln!("{NOT_REVOKED}");
        return Ok(());
    }
    let edit = RotationEdit {
        new_password: Some(new.as_bytes()),
        reissue_recovery: args.reissue_recovery,
        ..RotationEdit::default()
    };
    rotate_and_report(
        &root,
        old.as_bytes(),
        edit,
        args,
        Some(
            "rewrapped under the new passphrase; the previous passphrase no longer opens the store",
        ),
    )
}

/// The new passphrase is typed (or piped), never taken from
/// `OPENSESAME_STORE_PASSWORD`: that variable holds the *current* passphrase,
/// and answering the new-passphrase prompts with it would "rewrap" the store
/// to the passphrase it already has while reporting the old one revoked.
fn read_new_passphrase(old: &str) -> anyhow::Result<String> {
    let new = prompt_secret_hidden("New store passphrase")?;
    let confirm = prompt_secret_hidden("Confirm new store passphrase")?;
    check_new_passphrase(old, &new, &confirm)?;
    Ok(new)
}

fn check_new_passphrase(old: &str, new: &str, confirm: &str) -> anyhow::Result<()> {
    if new != confirm {
        anyhow::bail!("passphrases do not match");
    }
    if new.is_empty() {
        anyhow::bail!("the new passphrase is empty");
    }
    if new == old {
        anyhow::bail!("the new passphrase is the current one; nothing would be revoked");
    }
    Ok(())
}

pub fn cmd_protect_remove(
    protector_id: &str,
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    no_rotate: bool,
    args: RotateArgs,
) -> anyhow::Result<()> {
    require_yes(yes, "remove protector")?;
    check_rotate_args(args, no_rotate)?;
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    if no_rotate {
        protect_remove_store(&root, password.as_bytes(), protector_id)?;
        eprintln!("removed {protector_id} from the key file; the root key is unchanged");
        eprintln!("{NOT_REVOKED}");
        return Ok(());
    }
    let edit = RotationEdit {
        remove_protector: Some(protector_id),
        reissue_recovery: args.reissue_recovery,
        ..RotationEdit::default()
    };
    rotate_and_report(
        &root,
        password.as_bytes(),
        edit,
        args,
        Some(&format!(
            "removed {protector_id}; it no longer opens the store"
        )),
    )
}

pub fn cmd_protect_root_rotate(
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    args: RotateArgs,
) -> anyhow::Result<()> {
    require_yes(yes, "root-rotate")?;
    check_rotate_args(args, false)?;
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    let edit = RotationEdit {
        reissue_recovery: args.reissue_recovery,
        ..RotationEdit::default()
    };
    rotate_and_report(&root, password.as_bytes(), edit, args, None)
}

fn rotate_and_report(
    root: &Path,
    password: &[u8],
    edit: RotationEdit<'_>,
    args: RotateArgs,
    note: Option<&str>,
) -> anyhow::Result<()> {
    let outcome = rotate_store_root_with_commit(root, password, edit, &mut |outcome| {
        let delivery = write_recovery_output(outcome, args, &mut io::stdout().lock());
        if delivery.is_err() {
            warn_delivery_failure(delivery, &mut io::stderr().lock())
        } else {
            delivery
        }
    })?;
    report_after_delivery(
        &outcome,
        note,
        outcome.delivery_error.is_some(),
        &mut io::stderr().lock(),
    )
}

#[cfg(test)]
fn report_to(
    outcome: &RotationOutcome,
    args: RotateArgs,
    note: Option<&str>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> anyhow::Result<()> {
    let delivery = write_recovery_output(outcome, args, stdout);
    let failed = warn_delivery_failure(delivery, stderr).is_err();
    report_after_delivery(outcome, note, failed, stderr)
}

fn warn_delivery_failure(delivery: io::Result<()>, stderr: &mut dyn Write) -> io::Result<()> {
    if delivery.is_err() {
        let _ = writeln!(stderr, "{RECOVERY_OUTPUT_FAILURE}");
    }
    delivery
}

fn report_after_delivery(
    outcome: &RotationOutcome,
    note: Option<&str>,
    delivery_failed: bool,
    stderr: &mut dyn Write,
) -> anyhow::Result<()> {
    if delivery_failed {
        let git_note = if outcome.git_deferred {
            " Git was deferred; after restoring recovery output, commit and back up the current encrypted store."
        } else if outcome.git_error.is_some() {
            " Separately, Git could not record the rotation; repair the repository and back up the current encrypted store."
        } else {
            ""
        };
        anyhow::bail!("{RECOVERY_OUTPUT_FAILURE}{git_note}");
    }
    if write_status(outcome, note, stderr).is_err() {
        let git_note = if outcome.git_deferred {
            " Git was deferred; commit and back up the current encrypted store."
        } else if outcome.git_error.is_some() {
            " Git also failed to record the rotation; repair the repository and back up the current encrypted store."
        } else {
            ""
        };
        anyhow::bail!(
            "root rotation committed, but status output failed; retain any recovery keys shown on stdout.{git_note}"
        );
    }
    if let Some(error) = &outcome.git_error {
        anyhow::bail!(
            "root rotation committed, but Git could not record the updated ciphertext ({error}); \
             repair the repository, commit the current encrypted store files, and back them up. \
             Do not retry the rotation to repair Git."
        );
    }
    if outcome.git_deferred {
        anyhow::bail!(
            "root rotation committed; automatic Git was deferred to deliver the reissued recovery keys. \
             Save the keys, commit the current encrypted store files, and back them up. \
             Do not retry the rotation to perform Git backup."
        );
    }
    Ok(())
}

fn write_status(
    outcome: &RotationOutcome,
    note: Option<&str>,
    stderr: &mut dyn Write,
) -> io::Result<()> {
    if let Some(note) = note {
        writeln!(stderr, "{note}")?;
    }
    writeln!(
        stderr,
        "root key rotated (epoch {}): re-encrypted {} entries and {} attachments",
        outcome.root_epoch, outcome.entries, outcome.attachments
    )?;
    if outcome.foreign_entries > 0 {
        writeln!(
            stderr,
            "note: {} gpg/age entries are not sealed under the root key and were left unchanged",
            outcome.foreign_entries
        )?;
    }
    writeln!(stderr, "{HISTORY_NOTE}")?;
    if let Some(notice) = outcome.git_notice {
        let message = match notice {
            RotationGitNotice::NoRepository => {
                "the store has no Git repository; initialize one before backing up"
            }
            RotationGitNotice::NoRemote => "the store has no Git remote; configure one and back up",
            RotationGitNotice::AutoPushDisabled => {
                "automatic backup is disabled; run the backup command"
            }
            RotationGitNotice::AutoPushFailed => {
                "automatic backup failed; run the backup command to retry"
            }
        };
        writeln!(stderr, "warning: {message}")?;
    }
    Ok(())
}

fn write_recovery_output(
    outcome: &RotationOutcome,
    args: RotateArgs,
    stdout: &mut dyn Write,
) -> io::Result<()> {
    for recovery in &outcome.reissued_recovery {
        writeln!(
            stdout,
            "protector={} kind=recovery-key fingerprint={}",
            recovery.protector_id, recovery.fingerprint_b64
        )?;
        if args.reveal {
            writeln!(
                stdout,
                "recovery={}",
                URL_SAFE_NO_PAD.encode(recovery.secret)
            )?;
        }
    }
    if !outcome.reissued_recovery.is_empty() {
        // Recovery keys are shown once, before any fallible status output.
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "rotate_tests.rs"]
mod tests;
