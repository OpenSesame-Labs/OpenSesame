//! Fail-closed decisions for SDK errors on the Workload API stream.

use opensesame_domain::TransportError;
use spiffe::transport::{GrpcStatusCode, TransportError as SdkTransportError};
use spiffe::WorkloadApiError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ApiAction {
    Denied(&'static str),
    Withdraw(TransportError, &'static str),
    Outage,
}

pub(super) fn classify_api_failure(error: &WorkloadApiError) -> ApiAction {
    match error {
        WorkloadApiError::NoIdentityIssued => ApiAction::Denied("svid_not_issued"),
        WorkloadApiError::PermissionDenied(_) => ApiAction::Denied("workload_api_denied"),
        WorkloadApiError::MissingRequiredField {
            field: "X509SVIDResponse.svids",
        } => ApiAction::Withdraw(TransportError::IdentityMissing, "svid_not_issued"),
        WorkloadApiError::MissingRequiredField {
            field: "X509SVID.bundle",
        } => ApiAction::Withdraw(TransportError::TrustUnknown, "bundle_missing"),
        WorkloadApiError::Transport(SdkTransportError::Status(status))
            if status.code() == GrpcStatusCode::Unauthenticated =>
        {
            ApiAction::Denied("workload_api_denied")
        }
        WorkloadApiError::Transport(_) | WorkloadApiError::EmptyResponse => ApiAction::Outage,
        // The SDK rejected the snapshot before selection: we cannot tell
        // whether it omitted the configured identity or its trust material.
        _ => ApiAction::Withdraw(
            TransportError::malformed("workload API snapshot could not be parsed"),
            "workload_api_message",
        ),
    }
}
