//! Apply the common X.509-SVID profile after the TLS chain has verified.

use opensesame_time::{DateTime, Utc};
use rustls::pki_types::{CertificateDer, UnixTime};
use rustls::CertificateError;

use crate::svid_profile::{validate_leaf, SvidExpectation, SvidRole};

pub(crate) fn verify_svid(
    leaf: &CertificateDer<'_>,
    trust_domain: &str,
    expected_id: Option<&str>,
    role: SvidRole,
    now: UnixTime,
) -> Result<(), rustls::Error> {
    let failure =
        || rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure);
    let seconds = i64::try_from(now.as_secs()).map_err(|_| failure())?;
    let now = DateTime::<Utc>::from_timestamp(seconds, 0).ok_or_else(failure)?;
    validate_leaf(
        leaf.as_ref(),
        &SvidExpectation {
            trust_domain,
            spiffe_id: expected_id,
            role,
        },
        now,
    )
    .map(|_| ())
    .map_err(|_| failure())
}
