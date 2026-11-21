//! Operator URL and system-event guards shared by Host and fuzz oracles.

/// Validate operator-supplied NATS URL (no http(s) — that is not the NATS protocol).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn validate_nats_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("nats_url is required for nats backend".into());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("nats://") || lower.starts_with("tls://")) {
        return Err("nats_url must start with nats:// or tls://".into());
    }
    if lower.contains(' ') {
        return Err("nats_url must not contain spaces".into());
    }
    if url.contains('@') {
        return Err("nats_url must not embed credentials".into());
    }
    Ok(())
}

/// Host-only system wake types (not callout-user publishable).
#[must_use]
pub fn is_system_event_type(event_type: &str) -> bool {
    event_type.starts_with("system.")
}

/// Full `JetStream` subject for a `CloudEvents` type under the default prefix.
#[must_use]
pub fn system_event_subject(event_type: &str) -> String {
    crate::event_subject(crate::DEFAULT_SUBJECT_PREFIX, event_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SYSTEM_SUBJECT_PREFIX;
    #[cfg(feature = "jetstream")]
    use opensesame_domain::transport::TransportError;
    #[cfg(feature = "jetstream")]
    use std::collections::{HashMap, HashSet};

    #[cfg(feature = "jetstream")]
    #[test]
    #[ignore = "requires Lean vectors; run spec/formal/source-trust-selection/verify.sh --nats"]
    fn lean_vectors_match_nats_reconnect_limit() {
        let path = std::env::var("OPENSESAME_NATS_RETRY_VECTORS").expect("Lean retry vectors");
        let text = std::fs::read_to_string(path).expect("read retry vectors");
        let value = |raw: &str| match raw {
            "none" => None,
            "0" => Some(0),
            "1" => Some(1),
            "5" => Some(5),
            _ => panic!("invalid retry vector value"),
        };
        let mut seen = HashSet::new();
        for line in text.lines() {
            let parts: Vec<_> = line.split('\t').collect();
            let ["retry", flag, requested, expected] = parts.as_slice() else {
                panic!("invalid retry vector");
            };
            let injected = match *flag {
                "0" => false,
                "1" => true,
                _ => panic!("invalid retry vector flag"),
            };
            let requested = value(requested);
            assert!(seen.insert((injected, requested)), "duplicate retry vector");
            assert_eq!(
                crate::nats_transport::reconnect_limit(injected, requested),
                value(expected),
                "retry limit correspondence"
            );
        }
        assert_eq!(seen.len(), 8, "incomplete retry vector matrix");
    }

    #[cfg(feature = "jetstream")]
    fn flag_spec(
        flag: &str,
        value: &str,
        explicit_plaintext: bool,
    ) -> Result<Option<crate::NatsTransportSpec>, opensesame_domain::transport::TransportError>
    {
        let lookup = |name: &str| match name {
            name if name == flag => Some(value.to_owned()),
            "OPENSESAME_NATS_REQUIRE_TLS" if explicit_plaintext => Some("0".to_owned()),
            _ => None,
        };
        crate::NatsTransportSpec::from_lookup("OPENSESAME_NATS", &lookup)
    }

    #[cfg(feature = "jetstream")]
    fn assert_false_flag(flag: &str, value: &str) {
        if flag.ends_with("TLS_FIRST") {
            assert!(
                flag_spec(flag, value, false).is_err(),
                "TLS_FIRST alone must not select plaintext"
            );
        }
        let spec = flag_spec(flag, value, true).unwrap().unwrap();
        assert!(
            !spec.is_secure(),
            "explicit false flag remains false: {flag}={value}"
        );
    }

    #[cfg(feature = "jetstream")]
    #[test]
    fn invalid_nats_security_booleans_fail_closed() {
        for flag in ["OPENSESAME_NATS_REQUIRE_TLS", "OPENSESAME_NATS_TLS_FIRST"] {
            for value in ["tru", "TRUE", "2"] {
                assert!(
                    flag_spec(flag, value, false).is_err(),
                    "invalid security flag must be refused: {flag}={value}"
                );
            }
            for value in ["1", "true", "yes", "on"] {
                let spec = flag_spec(flag, value, false).unwrap().unwrap();
                assert!(
                    spec.is_secure(),
                    "enabled flag must require TLS: {flag}={value}"
                );
                assert!(spec.normalized("nats://localhost:4222").is_err());
            }
            for value in ["0", "false", "no", "off"] {
                assert_false_flag(flag, value);
            }
        }
    }

    #[cfg(feature = "jetstream")]
    fn assert_security_setting_requires_tls(entries: &[(&str, &str)]) {
        let mut settings: HashMap<_, _> = entries.iter().copied().collect();
        settings.insert("OPENSESAME_NATS_REQUIRE_TLS", "0");
        let lookup = |name: &str| settings.get(name).map(|value| (*value).to_owned());
        let spec = crate::NatsTransportSpec::from_lookup("OPENSESAME_NATS", &lookup)
            .expect("security settings must resolve")
            .expect("security settings must select a policy");
        assert!(spec.is_secure(), "security setting must imply TLS");
        assert!(
            matches!(
                spec.normalized("nats://localhost:4222"),
                Err(TransportError::TrustUnknown)
            ),
            "security setting without trust must fail closed"
        );
    }

    #[cfg(feature = "jetstream")]
    #[test]
    fn explicit_plaintext_flag_cannot_disable_security_settings() {
        for settings in [
            &[("OPENSESAME_NATS_TLS_SERVER_NAME", "localhost")][..],
            &[(
                "OPENSESAME_NATS_TLS_SERVER_SPIFFE_ID",
                "spiffe://a.test/nats",
            )][..],
            &[("OPENSESAME_NATS_TLS_MIN_VERSION", "1.2")][..],
            &[("OPENSESAME_NATS_TLS_MIN_VERSION", "1.3")][..],
            &[("OPENSESAME_NATS_TLS_CRL_FILE", "/missing.crl")][..],
            &[
                ("OPENSESAME_NATS_PROVISION_AUTH", "nkey"),
                ("OPENSESAME_NATS_PROVISION_NKEY_SEED_FILE", "/missing.seed"),
            ][..],
        ] {
            assert_security_setting_requires_tls(settings);
        }
    }

    #[cfg(feature = "jetstream")]
    #[test]
    #[ignore = "requires Lean vectors; run spec/formal/source-trust-selection/verify.sh --nats"]
    fn lean_vectors_match_nats_reconnect_limit() {
        use std::collections::HashSet;
        let path = std::env::var("OPENSESAME_NATS_RETRY_VECTORS").expect("Lean retry vectors");
        let text = std::fs::read_to_string(path).expect("read retry vectors");
        let value = |raw: &str| match raw {
            "none" => None,
            "0" => Some(0),
            "1" => Some(1),
            "5" => Some(5),
            _ => panic!("invalid retry vector value"),
        };
        let mut seen = HashSet::new();
        for line in text.lines() {
            let parts: Vec<_> = line.split('\t').collect();
            let ["retry", flag, requested, expected] = parts.as_slice() else {
                panic!("invalid retry vector");
            };
            let injected = match *flag {
                "0" => false,
                "1" => true,
                _ => panic!("invalid retry vector flag"),
            };
            let requested = value(requested);
            assert!(seen.insert((injected, requested)), "duplicate retry vector");
            assert_eq!(
                crate::nats_transport::reconnect_limit(injected, requested),
                value(expected),
                "retry limit correspondence"
            );
        }
        assert_eq!(seen.len(), 8, "incomplete retry vector matrix");
    }

    #[cfg(feature = "jetstream")]
    fn flag_spec(
        flag: &str,
        value: &str,
        explicit_plaintext: bool,
    ) -> Result<Option<crate::NatsTransportSpec>, opensesame_domain::transport::TransportError>
    {
        let lookup = |name: &str| match name {
            name if name == flag => Some(value.to_owned()),
            "OPENSESAME_NATS_REQUIRE_TLS" if explicit_plaintext => Some("0".to_owned()),
            _ => None,
        };
        crate::NatsTransportSpec::from_lookup("OPENSESAME_NATS", &lookup)
    }

    #[cfg(feature = "jetstream")]
    fn assert_false_flag(flag: &str, value: &str) {
        if flag.ends_with("TLS_FIRST") {
            assert!(
                flag_spec(flag, value, false).is_err(),
                "TLS_FIRST alone must not select plaintext"
            );
        }
        let spec = flag_spec(flag, value, true).unwrap().unwrap();
        assert!(
            !spec.is_secure(),
            "explicit false flag remains false: {flag}={value}"
        );
    }

    #[cfg(feature = "jetstream")]
    #[test]
    fn invalid_nats_security_booleans_fail_closed() {
        for flag in ["OPENSESAME_NATS_REQUIRE_TLS", "OPENSESAME_NATS_TLS_FIRST"] {
            for value in ["tru", "TRUE", "2"] {
                assert!(
                    flag_spec(flag, value, false).is_err(),
                    "invalid security flag must be refused: {flag}={value}"
                );
            }
            for value in ["1", "true", "yes", "on"] {
                let spec = flag_spec(flag, value, false).unwrap().unwrap();
                assert!(
                    spec.is_secure(),
                    "enabled flag must require TLS: {flag}={value}"
                );
                assert!(spec.normalized("nats://localhost:4222").is_err());
            }
            for value in ["0", "false", "no", "off"] {
                assert_false_flag(flag, value);
            }
        }
    }

    #[test]
    fn accepts_nats_and_tls_rejects_http() {
        assert!(validate_nats_url("nats://127.0.0.1:4222").is_ok());
        assert!(validate_nats_url("tls://box.tailnet.ts.net:4222").is_ok());
        assert!(validate_nats_url("http://127.0.0.1:4222").is_err());
        assert!(validate_nats_url("").is_err());
        assert!(validate_nats_url("nats://bad host:4222").is_err());
    }

    #[test]
    fn system_types_map_under_system_prefix() {
        assert!(is_system_event_type("system.backup.wake"));
        assert!(!is_system_event_type("principal.created"));
        assert!(
            system_event_subject("system.github.webhook.wake").starts_with(SYSTEM_SUBJECT_PREFIX)
        );
    }
}

#[cfg(test)]
mod pact {
    use super::*;
    use crate::SYSTEM_SUBJECT_PREFIX;

    #[test]
    fn property_nats_and_tls_accepted_http_refused() {
        for ok in ["nats://127.0.0.1:4222", "tls://box.tailnet.ts.net:4222"] {
            assert!(validate_nats_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://127.0.0.1:4222",
            "https://nats.example",
            "",
            "nats://bad host:4222",
            "nats://user:secret@127.0.0.1:4222",
        ] {
            assert!(validate_nats_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn adversarial_userinfo_urls_are_refused() {
        assert!(validate_nats_url("nats://user:secret@127.0.0.1:4222").is_err());
        assert!(validate_nats_url("http://user:secret@127.0.0.1:4222").is_err());
    }

    #[test]
    fn chaos_system_types_never_leave_the_system_prefix() {
        for ty in ["system.backup.wake", "system.github.webhook.wake"] {
            assert!(is_system_event_type(ty));
            assert!(system_event_subject(ty).starts_with(SYSTEM_SUBJECT_PREFIX));
        }
        assert!(!is_system_event_type("principal.created"));
    }

    #[test]
    fn contract_validate_runs_before_connect() {
        let src = include_str!("nats.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();
        let validate = production
            .find("validate_nats_url")
            .expect("validate_nats_url");
        let connect = production
            .find("options.connect(")
            .expect("options.connect(");
        assert!(validate < connect);
    }
}
