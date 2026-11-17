use serde_json::Value;
use url::{Host, Url};

/// The complete link must be the displayed ceremony with exactly this code.
pub(super) fn validate(auth: &Value, user_code: &str) -> anyhow::Result<(String, Option<String>)> {
    let valid_code = user_code.len() == 9
        && user_code.bytes().enumerate().all(|(index, byte)| {
            if index == 4 {
                byte == b'-'
            } else {
                byte.is_ascii_uppercase()
            }
        });
    if !valid_code {
        anyhow::bail!("device authorize response has an invalid user code");
    }
    let value = auth["verification_uri"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("device authorize response missing verification_uri"))?;
    let uri = Url::parse(value).map_err(|_| anyhow::anyhow!("invalid device verification URL"))?;
    let loopback = match uri.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if value.len() > 2048
        || !(uri.scheme() == "https" || uri.scheme() == "http" && loopback)
        || uri.host().is_none()
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.query().is_some()
        || uri.fragment().is_some()
    {
        anyhow::bail!("invalid device verification URL");
    }
    let complete = match auth.get("verification_uri_complete") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let raw = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid complete device verification URL"))?;
            let parsed = Url::parse(raw)
                .map_err(|_| anyhow::anyhow!("invalid complete device verification URL"))?;
            if raw.len() > 2200
                || parsed.origin() != uri.origin()
                || parsed.path() != uri.path()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.fragment().is_some()
                || parsed.query_pairs().collect::<Vec<_>>()
                    != vec![("user_code".into(), user_code.into())]
            {
                anyhow::bail!("invalid complete device verification URL");
            }
            Some(parsed.to_string())
        }
    };
    Ok((uri.to_string(), complete))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn complete_link_cannot_switch_origins_paths_codes_or_carry_extra_parameters() {
        let uri = "https://app.example/OpenSesame/device";
        let valid = json!({"verification_uri": uri, "verification_uri_complete": format!("{uri}?user_code=BCDF-GHJK")});
        assert!(validate(&valid, "BCDF-GHJK").is_ok());
        for bad in [
            "https://app.example.evil.test/OpenSesame/device?user_code=BCDF-GHJK",
            "https://app.example/OpenSesame/other?user_code=BCDF-GHJK",
            "https://app.example/OpenSesame/device?user_code=XXXX-YYYY",
            "https://app.example/OpenSesame/device?user_code=BCDF-GHJK&token=secret",
            "https://name@app.example/OpenSesame/device?user_code=BCDF-GHJK",
            "https://app.example/OpenSesame/device?user_code=BCDF-GHJK#token",
        ] {
            assert!(validate(
                &json!({"verification_uri": uri, "verification_uri_complete": bad}),
                "BCDF-GHJK"
            )
            .is_err());
        }
    }

    #[test]
    fn rejects_untrusted_transport_credentials_and_terminal_control_characters() {
        for uri in [
            "http://app.example/device",
            "https://name@app.example/device",
            "javascript:alert(1)",
            "https://app.example/device?token=secret",
        ] {
            assert!(validate(&json!({"verification_uri": uri}), "BCDF-GHJK").is_err());
        }
        assert!(validate(
            &json!({"verification_uri": "http://127.0.0.1:5180/device"}),
            "BCDF-GHJK"
        )
        .is_ok());
        assert!(validate(
            &json!({"verification_uri": "https://app.example/device"}),
            "\u{1b}[31mBAD"
        )
        .is_err());
    }
}
