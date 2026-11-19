//! Explicit owner assertion when recovering a possibly stale ciphertext.

use std::path::Path;

pub(super) fn cmd_recover_ciphertext(
    name: &str,
    trust_source: bool,
    attachment: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    if !trust_source {
        anyhow::bail!(
            "independently verify the ciphertext's version before using --trust-source; \
             an old replay can also authenticate"
        );
    }
    let (root, key) = crate::store::open_unlocked(path, tomb)?;
    if attachment {
        root.recover_attachment_trusting_ciphertext(name, &key)?;
    } else {
        root.recover_entry_trusting_ciphertext(name, &key)?;
    }
    println!("recovered owner-trusted ciphertext for {name}");
    Ok(())
}
