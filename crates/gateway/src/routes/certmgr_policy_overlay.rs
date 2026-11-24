//! The partial rules document a policy create or update may carry.
//!
//! `rules` used to arrive as untyped JSON, be shallow-merged over the seed's
//! re-encoded document, and only then be decoded. It is now decoded with the
//! body, into the same field types [`PolicyRules`] has: each top-level rule
//! the caller names replaces the seed's, an unknown rule is refused, and a
//! named rule may not be `null` (it was never a way to clear one).

use opensesame_pki_core::{
    BasicConstraintRule, Constraint, ExtendedKeyUsage, KeyAlgorithm, KeyUsage, PolicyRules,
    SanRules, SignatureAlgorithm, SubjectRules,
};
use serde::{Deserialize, Deserializer};

/// The rules a caller names, each replacing the seed's.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyRulesOverlay {
    #[serde(default, deserialize_with = "named")]
    subject: Option<SubjectRules>,
    #[serde(default, deserialize_with = "named")]
    san: Option<SanRules>,
    #[serde(default, deserialize_with = "named")]
    signature_algorithms: Option<Constraint<SignatureAlgorithm>>,
    #[serde(default, deserialize_with = "named")]
    key_algorithms: Option<Constraint<KeyAlgorithm>>,
    #[serde(default, deserialize_with = "named")]
    key_usages: Option<Constraint<KeyUsage>>,
    #[serde(default, deserialize_with = "named")]
    ext_key_usages: Option<Constraint<ExtendedKeyUsage>>,
    #[serde(default, deserialize_with = "named")]
    basic_constraints: Option<BasicConstraintRule>,
}

/// A rule that is present is a value of its type; `null` is not one.
fn named<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

impl PolicyRulesOverlay {
    /// `seed` with every rule this overlay names replaced.
    pub(crate) fn over(self, mut seed: PolicyRules) -> PolicyRules {
        if let Some(subject) = self.subject {
            seed.subject = subject;
        }
        if let Some(san) = self.san {
            seed.san = san;
        }
        if let Some(rule) = self.signature_algorithms {
            seed.signature_algorithms = rule;
        }
        if let Some(rule) = self.key_algorithms {
            seed.key_algorithms = rule;
        }
        if let Some(rule) = self.key_usages {
            seed.key_usages = rule;
        }
        if let Some(rule) = self.ext_key_usages {
            seed.ext_key_usages = rule;
        }
        if let Some(rule) = self.basic_constraints {
            seed.basic_constraints = rule;
        }
        seed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overlay(json: &str) -> Result<PolicyRulesOverlay, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn an_empty_overlay_keeps_the_seed() {
        let seed = PolicyRules::default();
        assert_eq!(overlay("{}").expect("empty").over(seed.clone()), seed);
    }

    #[test]
    fn a_named_rule_replaces_only_that_rule() {
        let seed: PolicyRules = serde_json::from_str(
            r#"{"key_algorithms":{"allowed":["ed25519"]},"key_usages":{"required":["digital_signature"]}}"#,
        )
        .expect("seed");
        let merged = overlay(r#"{"key_algorithms":{"allowed":["ecdsa-p256"]}}"#)
            .expect("overlay")
            .over(seed.clone());
        let expected_keys: Constraint<KeyAlgorithm> =
            serde_json::from_str(r#"{"allowed":["ecdsa-p256"]}"#).expect("constraint");
        assert_eq!(merged.key_algorithms, expected_keys);
        assert_eq!(merged.key_usages, seed.key_usages);
    }

    #[test]
    fn unknown_null_or_mistyped_rules_are_refused() {
        for json in [
            r#"{"unknown_rule":{}}"#,
            r#"{"subject":null}"#,
            r#"{"key_algorithms":{"allowed":["rot13"]}}"#,
            r#"{"san":{"upn":{},"extra":1}}"#,
            r#"5"#,
        ] {
            assert!(overlay(json).is_err(), "{json}");
        }
    }
}
