//! Recheck EST certificate evidence at each authorization boundary.
use crate::app_state::AppState;
use opensesame_domain::transport::{EvidenceSource, TransportPolicy, VerifiedPeer};

pub(super) fn evidence_is_current(st: &AppState, verified: &VerifiedPeer) -> bool {
    verified.source() == EvidenceSource::DirectTls
        && verified.policy() == TransportPolicy::MtlsRequired
        && verified.is_usable_at(opensesame_time::Utc::now())
        && st.transport.as_ref().is_none_or(|runtime| {
            runtime
                .generations
                .checked_current(None)
                .is_ok_and(|generation| {
                    verified
                        .require_generations(generation.number, generation.number)
                        .is_ok()
                })
        })
}

/// Recheck the TLS connection that carried the request after every await.
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn transport_is_current(st: &AppState, extensions: &axum::http::Extensions) -> bool {
    st.transport.as_ref().is_none_or(|runtime| {
        let Some(opensesame_transport_security::ListenerProvenance::Tls {
            generation, ..
        }) = extensions.get::<opensesame_transport_security::ListenerProvenance>()
        else {
            return false;
        };
        runtime
            .generations
            .checked_current(Some(*generation))
            .is_ok()
    })
}
