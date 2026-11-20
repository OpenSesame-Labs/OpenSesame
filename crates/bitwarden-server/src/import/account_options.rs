//! Human-selected limits for a live account import.

use super::account::{self, AccountRequest, Ask};
use super::Source;
use crate::hashing::HashRegistry;

/// Per-import bounds for live-account attachment downloads and scratch space.
/// Failed downloads consume their reserved allowance, since the source may
/// have sent bytes before failing. The per-file cap remains 500 MiB.
#[derive(Clone, Copy, Debug)]
pub struct AttachmentLimits {
    /// Maximum number of listed personal attachments to attempt.
    pub max_count: usize,
    /// Maximum aggregate retained ciphertext and scratch bytes.
    pub max_total_bytes: usize,
}

impl Default for AttachmentLimits {
    fn default() -> Self {
        Self {
            max_count: 512,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

/// Read an account, allowing attachment downloads from additional origins
/// supplied by the person running the import. Server-provided links must not
/// be used to populate this list.
///
/// # Errors
///
/// Returns the same errors as [`account::read`], or an error for an invalid origin.
pub async fn read_with_download_origins(
    request: &AccountRequest<'_>,
    hashes: &HashRegistry,
    ask: &mut dyn Ask,
    download_origins: &[String],
) -> anyhow::Result<Source> {
    account::read_with_options(
        request,
        hashes,
        ask,
        download_origins,
        AttachmentLimits::default(),
    )
    .await
}
