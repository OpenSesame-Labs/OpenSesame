use url::{Host, Url};

/// The browser ceremony must use the same Pages deployment as Identity.
pub(super) fn resolve(value: Option<&str>, production: bool) -> Result<Option<Url>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let invalid = || {
        "OPENSESAME_CLIENT_APP_URL must be a valid Pages base URL, using HTTPS (loopback HTTP is allowed outside production), without credentials, query or fragment".to_string()
    };
    if value.len() > 2048 {
        return Err(invalid());
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    let loopback = match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if !(url.scheme() == "https" || (!production && url.scheme() == "http" && loopback))
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.cannot_be_a_base()
    {
        return Err(invalid());
    }
    Ok(Some(url))
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn app_url_is_validated_for_the_deployment_and_preserves_its_base_path() {
        assert_eq!(resolve(None, true).unwrap(), None);
        assert_eq!(resolve(Some("  "), false).unwrap(), None);
        assert_eq!(
            resolve(Some("https://pages.example/OpenSesame/"), true)
                .unwrap()
                .unwrap()
                .as_str(),
            "https://pages.example/OpenSesame/"
        );
        for address in [
            "http://localhost:5180/",
            "http://127.0.0.1:5180/",
            "http://[::1]:5180/",
        ] {
            assert!(resolve(Some(address), false).is_ok(), "{address}");
            assert!(resolve(Some(address), true).is_err(), "{address}");
        }
        for address in [
            "http://pages.example/",
            "ftp://pages.example/",
            "https://name:secret@pages.example/",
            "https://pages.example/?token=value",
            "https://pages.example/#token=value",
            "not-a-url",
        ] {
            assert!(resolve(Some(address), false).is_err(), "{address}");
        }
        assert!(resolve(
            Some(&format!("https://example.test/{}", "x".repeat(2048))),
            false
        )
        .is_err());
    }
}
