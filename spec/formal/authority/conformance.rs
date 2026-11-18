use chrono::{TimeZone, Utc};
use opensesame_domain::{
    grant_lineage::{validate_delegator, validate_proof_key_transfer, validate_scope_containment},
    Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId, ProjectId,
};
use std::{collections::HashSet, env, fs};

fn fixture() -> (Grant, Grant) {
    let now = Utc
        .timestamp_opt(1_000, 0)
        .single()
        .expect("valid timestamp");
    let issuer = PrincipalId::new();
    let holder = PrincipalId::new();
    assert_ne!(issuer, holder);
    let parent = Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: issuer,
        beneficiary_principal_id: holder,
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: OrganizationId::new(),
        project_id: None,
        environment_id: None,
        connection_id: None,
        actions: vec!["read".into()],
        resources: vec!["repo:example".into()],
        constraints: GrantConstraints {
            audiences: vec![],
            not_before: None,
            expires_at: now,
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: Default::default(),
            maximum_delegation_depth: 2,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    };
    let mut child = parent.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = 1;
    (parent, child)
}

fn bit(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid boolean vector {value}"),
    }
}

fn key(value: &str) -> Option<String> {
    match value {
        "none" => None,
        "one" => Some("key-one".into()),
        "two" => Some("key-two".into()),
        _ => panic!("invalid key vector {value}"),
    }
}

fn actions(read: bool, write: bool) -> Vec<String> {
    [(read, "read"), (write, "write")]
        .into_iter()
        .filter_map(|(enabled, name)| enabled.then(|| name.to_string()))
        .collect()
}

fn main() {
    let path = env::args().nth(1).expect("Lean vector path required");
    let contents = fs::read_to_string(path).expect("read Lean vectors");
    let mut seen = HashSet::new();
    let mut counts = [0; 6];
    for line in contents.lines() {
        let columns: Vec<_> = line.split('\t').collect();
        assert!(seen.insert(line.to_string()), "duplicate vector: {line}");
        let (mut parent, mut child) = fixture();
        let actual = match columns.as_slice() {
            ["delegate", parent_export, child_export, _] => {
                counts[0] += 1;
                parent.constraints.raw_credential_export = bit(parent_export);
                child.constraints.raw_credential_export = bit(child_export);
                Grant::validate_attenuation(&parent, &child).is_ok()
            }
            ["replacement", parent_export, current_export, replacement_export, _] => {
                counts[1] += 1;
                parent.constraints.raw_credential_export = bit(parent_export);
                child.constraints.raw_credential_export = bit(current_export);
                let mut replacement = child.clone();
                replacement.id = GrantId::new();
                replacement.constraints.raw_credential_export = bit(replacement_export);
                Grant::validate_replacement(&parent, &child, &replacement).is_ok()
            }
            ["issuer", holder, issuer, _] => {
                counts[2] += 1;
                let (holder, issuer) = (bit(holder), bit(issuer));
                if holder && issuer {
                    parent.issuer_principal_id = parent.beneficiary_principal_id;
                }
                child.issuer_principal_id = if holder {
                    parent.beneficiary_principal_id
                } else if issuer {
                    parent.issuer_principal_id
                } else {
                    let stranger = PrincipalId::new();
                    assert_ne!(stranger, parent.issuer_principal_id);
                    assert_ne!(stranger, parent.beneficiary_principal_id);
                    stranger
                };
                validate_delegator(&parent, &child).is_ok()
            }
            ["scope", p, c, _] => {
                counts[3] += 1;
                let one = ProjectId::new();
                let two = ProjectId::new();
                assert_ne!(one, two);
                let lookup = |label| match label {
                    "none" => None,
                    "one" => Some(one),
                    "two" => Some(two),
                    _ => panic!("invalid scope vector"),
                };
                parent.project_id = lookup(p);
                child.project_id = lookup(c);
                validate_scope_containment(&parent, &child).is_ok()
            }
            ["key", p, c, same_holder, _] => {
                counts[4] += 1;
                parent.proof_key_thumbprint = key(p);
                child.proof_key_thumbprint = key(c);
                if !bit(same_holder) {
                    child.beneficiary_principal_id = PrincipalId::new();
                    assert_ne!(
                        child.beneficiary_principal_id,
                        parent.beneficiary_principal_id
                    );
                }
                validate_proof_key_transfer(&parent, &child).is_ok()
            }
            ["actions", pr, pw, cr, cw, _] => {
                counts[5] += 1;
                parent.actions = actions(bit(pr), bit(pw));
                child.actions = actions(bit(cr), bit(cw));
                Grant::validate_attenuation(&parent, &child).is_ok()
            }
            _ => panic!("invalid vector: {line}"),
        };
        assert_eq!(
            actual,
            bit(columns.last().expect("expected result")),
            "vector: {line}"
        );
    }
    assert_eq!(counts, [4, 8, 4, 6, 12, 16], "incomplete matrix");
    println!("authority correspondence: {} cases passed", seen.len());
}
