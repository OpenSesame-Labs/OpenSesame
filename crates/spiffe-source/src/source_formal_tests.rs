//! Compares Lean-generated finite cases to actual SDK decisions and deadlines.

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_domain::{CredentialStatus, TransportError};
use spiffe::transport::{GrpcStatusCode, TransportError as SdkTransportError};
use spiffe::WorkloadApiError;

use super::{apply_outage, bounded_deadline, classify_api_failure, ApiAction};
use crate::bundles::TrustDomainBundles;
use crate::fake::FakeTrustDomain;
use crate::outage::retention_deadline;
use crate::status::{SourcePhase, SourceStatus};

fn api_error(name: &str) -> WorkloadApiError {
    match name {
        "no_identity" => WorkloadApiError::NoIdentityIssued,
        "permission_denied" => WorkloadApiError::PermissionDenied("denied".into()),
        "missing_svids" => WorkloadApiError::MissingRequiredField {
            field: "X509SVIDResponse.svids",
        },
        "missing_bundle" => WorkloadApiError::MissingRequiredField {
            field: "X509SVID.bundle",
        },
        "transport" => WorkloadApiError::Transport(SdkTransportError::status(
            GrpcStatusCode::Unavailable,
            "unavailable",
        )),
        "unauthenticated" => WorkloadApiError::Transport(SdkTransportError::status(
            GrpcStatusCode::Unauthenticated,
            "unauthenticated",
        )),
        "empty_response" => WorkloadApiError::EmptyResponse,
        "malformed_field" => WorkloadApiError::MissingRequiredField {
            field: "X509SVID.spiffe_id",
        },
        "invalid_field" => WorkloadApiError::InvalidResponseField {
            field: "X509SVID.x509_svid",
        },
        _ => panic!("unknown SDK failure case {name}"),
    }
}

fn decision(name: &str) -> ApiAction {
    match name {
        "no_identity" => ApiAction::Denied("svid_not_issued"),
        "permission_denied" => ApiAction::Denied("workload_api_denied"),
        "missing_svids" => ApiAction::Withdraw(TransportError::IdentityMissing, "svid_not_issued"),
        "missing_bundle" => ApiAction::Withdraw(TransportError::TrustUnknown, "bundle_missing"),
        "outage" => ApiAction::Outage,
        "malformed" => ApiAction::Withdraw(
            TransportError::malformed("workload API snapshot could not be parsed"),
            "workload_api_message",
        ),
        _ => panic!("unknown expected decision {name}"),
    }
}

fn seconds(value: &str) -> i64 {
    value.parse().expect("integer model time")
}

fn time(value: &str) -> DateTime<Utc> {
    DateTime::from_timestamp(seconds(value), 0).expect("model time in range")
}

fn duration(value: &str) -> Duration {
    Duration::from_secs(value.parse().expect("nonnegative model duration"))
}

fn bit(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid model boolean {value}"),
    }
}

fn assert_model_ticks(values: &[&str]) {
    for value in values {
        assert!(
            ["0", "1", "5", "10"].contains(value),
            "unknown model input {value}"
        );
    }
}

fn trust_set(mask: &str, anchors: &[Vec<u8>; 3]) -> TrustDomainBundles {
    let mask: u8 = mask.parse().expect("numeric trust mask");
    assert!(mask < 8, "unknown trust mask");
    let mut result = TrustDomainBundles::default();
    let mut first_domain = Vec::new();
    if mask & 1 != 0 {
        first_domain.push(anchors[0].clone());
    }
    if mask & 2 != 0 {
        first_domain.push(anchors[1].clone());
    }
    if !first_domain.is_empty() {
        result.insert("a.test", first_domain).unwrap();
    }
    if mask & 4 != 0 {
        result.insert("b.test", vec![anchors[2].clone()]).unwrap();
    }
    result
}

fn check_retry(not_after: &str, previous: &str, since: &str, max_stale: &str, expected: &str) {
    assert_model_ticks(&[not_after, previous, since, max_stale]);
    let candidate = retention_deadline(time(not_after), Some((time(since), duration(max_stale))));
    let mut status = SourceStatus::initial("spiffe://example.test/workload");
    status.phase = SourcePhase::Outage;
    status.retain_until = Some(time(previous));
    apply_outage(
        &mut status,
        time(since),
        Some(candidate),
        SourcePhase::Outage,
        "workload_api_transport".into(),
    );
    assert_eq!(status.retain_until.unwrap().timestamp(), seconds(expected));
}

fn check_status(not_after: &str, retained: &str, now: &str, expected: &str) {
    assert_model_ticks(&[not_after, retained, now]);
    let mut status = SourceStatus::initial("spiffe://example.test/workload");
    status.phase = SourcePhase::Outage;
    status.generation = Some(1);
    status.not_after = Some(time(not_after));
    status.retain_until = Some(time(retained));
    assert_eq!(
        matches!(
            status.credential_status(time(now)),
            CredentialStatus::Configured { .. }
        ),
        bit(expected)
    );
}

#[test]
#[ignore = "requires Lean vectors; run spec/formal/spiffe/verify.sh"]
fn lean_vectors_match_the_sdk_classifier_and_outage_deadlines() {
    let path = std::env::var_os("OPENSESAME_SPIFFE_VECTORS")
        .expect("Lean vectors must be provided by the formal verification script");
    let data = std::fs::read_to_string(path).expect("read Lean vectors");
    let anchors = [
        FakeTrustDomain::new("a.test").bundle_der(),
        FakeTrustDomain::new("a.test").bundle_der(),
        FakeTrustDomain::new("b.test").bundle_der(),
    ];
    let mut seen = HashSet::new();
    let mut counts = [0usize; 6];
    for line in data.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        assert!(fields.len() >= 2, "invalid Lean vector {line}");
        assert!(
            seen.insert(fields[..fields.len() - 1].join("\t")),
            "duplicate model input {line}"
        );
        match fields.as_slice() {
            ["classify", signal, expected] => {
                counts[0] += 1;
                assert_eq!(
                    classify_api_failure(&api_error(signal)),
                    decision(expected),
                    "{line}"
                );
            }
            ["trust", previous, incoming, expected] => {
                counts[1] += 1;
                assert_eq!(
                    trust_set(incoming, &anchors).contains_all(&trust_set(previous, &anchors)),
                    bit(expected),
                    "{line}"
                );
            }
            ["deadline", not_after, since, max_stale, expected] => {
                counts[2] += 1;
                assert_model_ticks(&[not_after, since, max_stale]);
                let actual =
                    retention_deadline(time(not_after), Some((time(since), duration(max_stale))));
                assert_eq!(actual.timestamp(), seconds(expected), "{line}");
            }
            ["retry", not_after, previous, since, max_stale, expected] => {
                counts[3] += 1;
                check_retry(not_after, previous, since, max_stale, expected);
            }
            ["effective", not_after, retained, expected] => {
                counts[4] += 1;
                assert_model_ticks(&[not_after, retained]);
                assert_eq!(
                    bounded_deadline(time(not_after), Some(time(retained))).timestamp(),
                    seconds(expected),
                    "{line}"
                );
            }
            ["status", not_after, retained, now, expected] => {
                counts[5] += 1;
                check_status(not_after, retained, now, expected);
            }
            _ => panic!("invalid Lean vector {line}"),
        }
    }
    assert_eq!(
        counts,
        [9, 64, 64, 256, 16, 64],
        "missing or extra model cases"
    );
}
