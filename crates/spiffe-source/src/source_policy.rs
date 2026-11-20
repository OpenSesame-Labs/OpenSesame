//! Fail-closed decisions for SDK errors on the Workload API stream.
//!
//! `NoIdentityIssued`, an empty SVID list, and [`WorkloadApiError::EmptyResponse`]
//! are one [`ApiAction::Withdraw`]: [`TransportError::IdentityMissing`] reported
//! as `svid_not_issued`. Permission denial and authentication failure return
//! [`ApiAction::Denied`] with distinct status codes (`workload_api_denied` and
//! `workload_api_unauthenticated`). That variant is separate from
//! [`ApiAction::Withdraw`] and never takes the outage path. The connection loop
//! maps `Denied` to immediate generation withdrawal, using
//! [`TransportError::IdentityMissing`] and the denial's status code. ADR 0227
//! requires generation withdrawal when material-RPC returns `PERMISSION_DENIED`
//! or `UNAUTHENTICATED`; the classifier maps those to [`ApiAction::Denied`], not
//! the outage [`ApiAction::Withdraw`] path.
//!
//! The `spiffe` 0.19 SDK (`WorkloadApiError::from_status`) is what splits a
//! gRPC `PERMISSION_DENIED` whose message contains the SPIRE phrase
//! "no identity issued" into `NoIdentityIssued`. Every other permission
//! message stays `PermissionDenied`. That substring is SPIRE wording, not a
//! SPIFFE field, and this classifier does not match it again. A
//! `PERMISSION_DENIED` status that arrives still wrapped in
//! [`SdkTransportError::Status`] is the permission denial, including when its
//! message happens to contain that phrase.

use opensesame_domain::TransportError;
use spiffe::transport::{GrpcStatusCode, TransportError as SdkTransportError};
use spiffe::WorkloadApiError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ApiAction {
    Denied(&'static str),
    Withdraw(TransportError, &'static str),
    Outage,
}

fn no_identity() -> ApiAction {
    ApiAction::Withdraw(TransportError::IdentityMissing, "svid_not_issued")
}

pub(super) fn classify_api_failure(error: &WorkloadApiError) -> ApiAction {
    match error {
        WorkloadApiError::NoIdentityIssued
        | WorkloadApiError::EmptyResponse
        | WorkloadApiError::MissingRequiredField {
            field: "X509SVIDResponse.svids",
        } => no_identity(),
        WorkloadApiError::PermissionDenied(_) => ApiAction::Denied("workload_api_denied"),
        WorkloadApiError::MissingRequiredField {
            field: "X509SVID.bundle",
        } => ApiAction::Withdraw(TransportError::TrustUnknown, "bundle_missing"),
        WorkloadApiError::Transport(SdkTransportError::Status(status))
            if status.code() == GrpcStatusCode::Unauthenticated =>
        {
            ApiAction::Denied("workload_api_unauthenticated")
        }
        WorkloadApiError::Transport(SdkTransportError::Status(status))
            if status.code() == GrpcStatusCode::PermissionDenied =>
        {
            ApiAction::Denied("workload_api_denied")
        }
        WorkloadApiError::Transport(_) => ApiAction::Outage,
        // The SDK rejected the snapshot before selection: we cannot tell
        // whether it omitted the configured identity or its trust material.
        _ => ApiAction::Withdraw(
            TransportError::malformed("workload API snapshot could not be parsed"),
            "workload_api_message",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transport(code: GrpcStatusCode, message: &str) -> WorkloadApiError {
        WorkloadApiError::Transport(SdkTransportError::status(code, message))
    }

    #[test]
    fn no_identity_empty_svids_and_empty_response_are_one_withdrawal() {
        let expected = no_identity();
        assert_eq!(
            classify_api_failure(&WorkloadApiError::NoIdentityIssued),
            expected
        );
        assert_eq!(
            classify_api_failure(&WorkloadApiError::EmptyResponse),
            expected
        );
        assert_eq!(
            classify_api_failure(&WorkloadApiError::MissingRequiredField {
                field: "X509SVIDResponse.svids",
            }),
            expected
        );
        assert!(matches!(
            expected,
            ApiAction::Withdraw(TransportError::IdentityMissing, "svid_not_issued")
        ));
    }

    #[test]
    fn permission_and_authentication_failures_withdraw_with_distinct_codes() {
        // Classifier result is `ApiAction::Denied` with these codes. The loop
        // maps `Denied` to immediate generation withdrawal.
        let permission = classify_api_failure(&WorkloadApiError::PermissionDenied("denied".into()));
        let unauthenticated = classify_api_failure(&transport(
            GrpcStatusCode::Unauthenticated,
            "unauthenticated",
        ));
        let wrapped_permission = classify_api_failure(&transport(
            GrpcStatusCode::PermissionDenied,
            "workload permission denied",
        ));
        assert_eq!(permission, ApiAction::Denied("workload_api_denied"));
        assert_eq!(wrapped_permission, permission);
        assert_eq!(
            unauthenticated,
            ApiAction::Denied("workload_api_unauthenticated")
        );
        assert_ne!(permission, unauthenticated);
        assert_ne!(permission, ApiAction::Outage);
        assert_ne!(unauthenticated, ApiAction::Outage);
        assert_ne!(permission, no_identity());
    }

    #[test]
    fn permission_message_text_is_not_classified_again() {
        // A `PermissionDenied` or wrapped status that still carries SPIRE's
        // "no identity issued" phrase is permission denial. Only the SDK's
        // `NoIdentityIssued` variant is the no-identity withdrawal.
        let carried = WorkloadApiError::PermissionDenied("no identity issued".into());
        let wrapped = transport(GrpcStatusCode::PermissionDenied, "no identity issued");
        assert_eq!(
            classify_api_failure(&carried),
            ApiAction::Denied("workload_api_denied")
        );
        assert_eq!(
            classify_api_failure(&wrapped),
            classify_api_failure(&carried)
        );
        assert_ne!(
            classify_api_failure(&carried),
            classify_api_failure(&WorkloadApiError::NoIdentityIssued)
        );
    }

    #[test]
    fn unavailable_transport_stays_an_outage() {
        assert_eq!(
            classify_api_failure(&transport(GrpcStatusCode::Unavailable, "unavailable")),
            ApiAction::Outage
        );
    }
}
