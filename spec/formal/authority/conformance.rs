use opensesame_domain::{
    grant::resource_pattern_matches,
    grant_attenuation::resources_attenuate,
    grant_lineage::{validate_delegator, validate_proof_key_transfer, validate_scope_containment},
    ActorId, ActorInstanceId, ClientId, ConnectionId, EnvironmentId, Grant, GrantConstraints,
    GrantId, OfflineUse, OrganizationId, PrincipalId, ProjectId,
};
use opensesame_time::{DateTime, TimeZone, Utc};
use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
};

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

fn clear_scope_bindings(grant: &mut Grant) {
    grant.project_id = None;
    grant.environment_id = None;
    grant.connection_id = None;
    grant.actor_id = None;
    grant.client_id = None;
    grant.actor_instance_id = None;
}

fn option_id<T: Copy>(label: &str, one: T, two: T) -> Option<T> {
    match label {
        "none" => None,
        "one" => Some(one),
        "two" => Some(two),
        _ => panic!("invalid scope vector {label}"),
    }
}

/// Apply one Lean scope vector to a single `validate_scope_containment` binding.
fn bind_scope_dimension(parent: &mut Grant, child: &mut Grant, dimension: &str, p: &str, c: &str) {
    clear_scope_bindings(parent);
    clear_scope_bindings(child);
    match dimension {
        "project" => {
            let one = ProjectId::new();
            let two = ProjectId::new();
            assert_ne!(one, two);
            parent.project_id = option_id(p, one, two);
            child.project_id = option_id(c, one, two);
        }
        "environment" => {
            let one = EnvironmentId::new();
            let two = EnvironmentId::new();
            assert_ne!(one, two);
            parent.environment_id = option_id(p, one, two);
            child.environment_id = option_id(c, one, two);
        }
        "connection" => {
            let one = ConnectionId::new();
            let two = ConnectionId::new();
            assert_ne!(one, two);
            parent.connection_id = option_id(p, one, two);
            child.connection_id = option_id(c, one, two);
        }
        "actor" => {
            let one = ActorId::new();
            let two = ActorId::new();
            assert_ne!(one, two);
            parent.actor_id = option_id(p, one, two);
            child.actor_id = option_id(c, one, two);
        }
        "client" => {
            let one = ClientId::new();
            let two = ClientId::new();
            assert_ne!(one, two);
            parent.client_id = option_id(p, one, two);
            child.client_id = option_id(c, one, two);
        }
        "actor_instance" => {
            let one = ActorInstanceId::new();
            let two = ActorInstanceId::new();
            assert_ne!(one, two);
            parent.actor_instance_id = option_id(p, one, two);
            child.actor_instance_id = option_id(c, one, two);
        }
        _ => panic!("unknown scope dimension {dimension}"),
    }
}

fn at(offset: &str) -> DateTime<Utc> {
    let seconds: i64 = offset.parse().expect("time vector");
    Utc.timestamp_opt(1_000 + seconds, 0)
        .single()
        .expect("valid timestamp")
}

fn names(field: &str, prefix: &str) -> Vec<String> {
    if field == "-" {
        return Vec::new();
    }
    field.split(',').map(|n| format!("{prefix}-{n}")).collect()
}

fn optional<T>(field: &str, parse: impl Fn(&str) -> T) -> Option<T> {
    (field != "none").then(|| parse(field))
}

/// Apply one Lean `Limits` record (11 columns, see `limitsText`) to a grant.
fn apply_limits(grant: &mut Grant, fields: &[&str]) {
    assert_eq!(fields.len(), 11, "invalid limits vector {fields:?}");
    let limits = &mut grant.constraints;
    limits.audiences = names(fields[0], "aud");
    limits.not_before = optional(fields[1], at);
    limits.expires_at = at(fields[2]);
    // `fido` is a name `assurance_rank` does not know.
    limits.required_assurance = optional(fields[3], str::to_string);
    limits.authentication_max_age_seconds = optional(fields[4], |v| v.parse().expect("age"));
    limits.allowed_networks = names(fields[5], "net");
    limits.parameter_rules_digest = optional(fields[6], |v| format!("digest-{v}"));
    limits.offline_use = match fields[7] {
        "0" => OfflineUse::Forbidden,
        "1" => OfflineUse::ReadOnly,
        "2" => OfflineUse::PreAuthorized,
        other => panic!("invalid offline vector {other}"),
    };
    limits.budgets = if fields[8] == "-" {
        BTreeMap::new()
    } else {
        fields[8]
            .split(',')
            .map(|entry| {
                let (key, value) = entry.split_once('=').expect("budget entry");
                let key = match key {
                    "0" => "calls",
                    "1" => "bytes",
                    other => panic!("invalid budget key {other}"),
                };
                (key.to_string(), value.parse().expect("budget value"))
            })
            .collect()
    };
    grant.delegation_depth = fields[9].parse().expect("depth");
    limits.maximum_delegation_depth = fields[10].parse().expect("maximum depth");
}

fn main() {
    let path = env::args().nth(1).expect("Lean vector path required");
    let contents = fs::read_to_string(path).expect("read Lean vectors");
    let mut seen = HashSet::new();
    let mut counts = [0; 10];
    let mut scope_checks = 0;
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
                let expected = bit(columns[3]);
                for dimension in [
                    "project",
                    "environment",
                    "connection",
                    "actor",
                    "client",
                    "actor_instance",
                ] {
                    bind_scope_dimension(&mut parent, &mut child, dimension, p, c);
                    let actual = validate_scope_containment(&parent, &child).is_ok();
                    assert_eq!(actual, expected, "vector: {line} dimension: {dimension}");
                    scope_checks += 1;
                }
                expected
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
            ["attenuate", _dimension, rest @ ..] if rest.len() == 23 => {
                counts[6] += 1;
                apply_limits(&mut parent, &rest[..11]);
                apply_limits(&mut child, &rest[11..22]);
                Grant::validate_attenuation(&parent, &child).is_ok()
            }
            ["replace", _dimension, rest @ ..] if rest.len() == 34 => {
                counts[7] += 1;
                apply_limits(&mut parent, &rest[..11]);
                apply_limits(&mut child, &rest[11..22]);
                let mut replacement = child.clone();
                replacement.id = GrantId::new();
                apply_limits(&mut replacement, &rest[22..33]);
                Grant::validate_replacement(&parent, &child, &replacement).is_ok()
            }
            ["selector", p, c, _] => {
                counts[8] += 1;
                let contained = resources_attenuate(&[c.to_string()], &[p.to_string()]);
                parent.resources = vec![p.to_string()];
                child.resources = vec![c.to_string()];
                let attenuates = Grant::validate_attenuation(&parent, &child).is_ok();
                assert_eq!(contained, attenuates, "vector: {line}");
                contained
            }
            ["pattern", p, r, _] => {
                counts[9] += 1;
                parent.resources = vec![p.to_string()];
                let permits = parent.permits_resource(r);
                assert_eq!(permits, resource_pattern_matches(p, r), "vector: {line}");
                permits
            }
            _ => panic!("invalid vector: {line}"),
        };
        assert_eq!(
            actual,
            bit(columns.last().expect("expected result")),
            "vector: {line}"
        );
    }
    assert_eq!(
        counts,
        [4, 8, 4, 6, 12, 16, 1127, 1127, 361, 361],
        "incomplete matrix"
    );
    assert_eq!(scope_checks, 36, "incomplete scope binding matrix");
    println!("authority correspondence: {} cases passed", seen.len());
}
