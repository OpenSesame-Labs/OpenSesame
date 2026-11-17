//! Validation for PDP destinations and configured store paths.

use crate::{OpenFgaError, Result};

/// Operator PDP base URL: https, or loopback http, without credentials,
/// query, or fragment.
///
/// # Errors
///
/// The URL cannot be used as a PDP base.
pub fn assert_pdp_base_url(raw: &str) -> Result<()> {
    let url = url::Url::parse(raw.trim()).map_err(|e| OpenFgaError::Config(e.to_string()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(OpenFgaError::Config(
            "PDP URL must not embed credentials".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(OpenFgaError::Config(
            "PDP URL must not contain a query or fragment".into(),
        ));
    }
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    match url.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err(OpenFgaError::Config(
            "PDP URL must be https or loopback http".into(),
        )),
    }
}

/// Accept one nonempty, unambiguous URL path segment. OpenFGA's store IDs
/// and the conventional test IDs are included; encoded separators and dot
/// segments are never reinterpreted as a different endpoint.
pub(crate) fn assert_store_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id == "."
        || id == ".."
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err(OpenFgaError::Config(
            "OPENSESAME_OPENFGA_STORE_ID must be one URL-safe path segment".into(),
        ));
    }
    Ok(())
}
