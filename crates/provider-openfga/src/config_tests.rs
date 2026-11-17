use super::*;
use std::env::VarError;

fn configured(url: Option<&str>, store: Option<&str>) -> Result<Option<OpenFgaClient>> {
    OpenFgaClient::from_lookup(|name| {
        match name {
            "OPENSESAME_OPENFGA_URL" => url,
            "OPENSESAME_OPENFGA_STORE_ID" => store,
            _ => None,
        }
        .map(str::to_owned)
        .ok_or(VarError::NotPresent)
    })
}

#[test]
fn absent_or_blank_url_is_deliberately_unconfigured() {
    assert!(configured(None, None).unwrap().is_none());
    assert!(configured(Some("  "), Some("unused")).unwrap().is_none());
    assert!(
        configured(Some("http://127.0.0.1:8080/"), Some("store-01_A.~"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn configured_pdp_rejects_missing_or_unsafe_store_and_url() {
    let base = "http://127.0.0.1:8080";
    for store in [
        None,
        Some(""),
        Some("  "),
        Some("."),
        Some(".."),
        Some("a/b"),
        Some("a\\b"),
        Some("a?x"),
        Some("a#x"),
        Some("%2e%2e"),
        Some("a%2fb"),
    ] {
        assert!(configured(Some(base), store).is_err(), "store {store:?}");
    }
    for url in [
        "http://remote.example",
        "http://127.0.0.1:8080?x=1",
        "http://127.0.0.1:8080#fragment",
    ] {
        assert!(
            configured(Some(url), Some("store-01")).is_err(),
            "url {url:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn present_non_utf8_values_are_configuration_errors() {
    use std::os::unix::ffi::OsStringExt;

    let non_utf8 = || VarError::NotUnicode(std::ffi::OsString::from_vec(vec![0xff]));
    assert!(OpenFgaClient::from_lookup(|name| {
        if name == "OPENSESAME_OPENFGA_URL" {
            Err(non_utf8())
        } else {
            Err(VarError::NotPresent)
        }
    })
    .is_err());
    assert!(OpenFgaClient::from_lookup(|name| match name {
        "OPENSESAME_OPENFGA_URL" => Ok("http://127.0.0.1:8080".into()),
        "OPENSESAME_OPENFGA_STORE_ID" => Err(non_utf8()),
        _ => Err(VarError::NotPresent),
    })
    .is_err());
}

#[tokio::test]
async fn directly_constructed_client_refuses_unsafe_store_before_network() {
    let client = OpenFgaClient::new("http://127.0.0.1:1", "../other");
    let tuple = TupleKey {
        user: "user:alice".into(),
        relation: "reader".into(),
        object: "document:a".into(),
    };
    assert!(matches!(
        client.check(&tuple).await,
        Err(OpenFgaError::Config(_))
    ));
    assert!(matches!(
        client.write_tuples(&[tuple]).await,
        Err(OpenFgaError::Config(_))
    ));
    assert!(matches!(
        client.write_authorization_model(json!({})).await,
        Err(OpenFgaError::Config(_))
    ));
}
