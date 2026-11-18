//! Choose only the authoritative current Workload API bundle for a SPIFFE listener.

use opensesame_domain::transport::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::{SourceTrust, TrustBundle};

fn bundle_matches(
    actual_profile: &TrustProfileRef,
    kind: TrustProfileKind,
    actual_domain: Option<&str>,
    profile: &TrustProfileRef,
    configured_domain: &str,
) -> bool {
    actual_profile == profile
        && kind == TrustProfileKind::SpiffeTrustDomain
        && actual_domain == Some(configured_domain)
}

/// Refuse stale/missing views and wrong-kind, mislabeled, or wrong-domain bundles.
/// The caller obtains `source` with `TransportGenerations::source_trust(g)`,
/// which compares the requested generation under the activation lock.
pub(super) fn select(
    source: Result<Option<SourceTrust>, TransportError>,
    profile: &TrustProfileRef,
    configured_domain: &str,
) -> Result<TrustBundle, TransportError> {
    source?
        .and_then(|view| {
            view.bundles
                .get(profile)
                .filter(|bundle| {
                    bundle_matches(
                        bundle.profile(),
                        bundle.kind(),
                        bundle.spiffe_trust_domain(),
                        profile,
                        configured_domain,
                    )
                })
                .cloned()
        })
        .ok_or(TransportError::TrustUnknown)
}

#[cfg(test)]
#[path = "source_trust_selection_formal.rs"]
mod formal;
