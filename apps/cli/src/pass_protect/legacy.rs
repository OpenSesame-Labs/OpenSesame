//! Explicit owner assertion for an old entry without a name-bound envelope.

use std::path::Path;

pub(super) fn cmd_migrate_legacy(
    name: &str,
    trust_source: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    if !trust_source {
        anyhow::bail!("verify the source file's name and version before using --trust-source");
    }
    let (root, key) = crate::store::open_unlocked(path, tomb)?;
    root.migrate_legacy_entry_trusting_name(name, &key)?;
    println!("migrated legacy entry {name}");
    Ok(())
}
