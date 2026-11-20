//! Choose only the authoritative current Workload API bundle for a SPIFFE listener.

use opensesame_domain::transport::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::{SourceTrust, TrustBundle};

/// Refuse stale/missing source views and any wrong-kind or mislabeled bundle.
/// The caller obtains `source` with `TransportGenerations::source_trust(g)`,
/// which compares the requested generation under the activation lock.
pub(super) fn select(
    source: Result<Option<SourceTrust>, TransportError>,
    profile: &TrustProfileRef,
) -> Result<TrustBundle, TransportError> {
    source?
        .and_then(|view| {
            view.bundles
                .get(profile)
                .filter(|bundle| {
                    bundle.profile() == profile
                        && bundle.kind() == TrustProfileKind::SpiffeTrustDomain
                })
                .cloned()
        })
        .ok_or(TransportError::TrustUnknown)
}

#[cfg(test)]
#[path = "source_trust_selection_formal.rs"]
mod formal;
