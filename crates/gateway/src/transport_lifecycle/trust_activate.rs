//! Turning a stored [`TrustProfileSet`] into the serving generation.
//!
//! Split in two on purpose. [`prepare`] builds every bundle and the whole
//! candidate from the generation serving now and has no side effect, so a
//! write can be refused (an unusable anchor, a withdrawn generation) before
//! anything is stored. [`activate`] swaps that candidate in, and only while
//! the generation it was built from still serves. `trust_store` stores
//! between the two, so the running set is never ahead of the stored one.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use opensesame_domain::transport::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_time::{DateTime, Utc};
use opensesame_transport_security::{GenerationCandidate, TransportGenerations, TrustBundle};

use crate::app_state::AppState;
use crate::transport_lifecycle::activation;
use crate::transport_lifecycle::trust::{bundles, TrustError, TrustProfileSet};

/// Serializes trust writes, refreshes and the overlap reconcile within one
/// process. Across processes sharing the store, the conditional write in
/// `trust_store::put_cas` is what serializes.
pub(crate) static TRUST_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A candidate built from one serving generation, not yet activated.
pub(crate) struct Prepared {
    runtime: Option<(Arc<TransportGenerations>, u64, GenerationCandidate)>,
    pub(crate) quarantined: BTreeSet<TrustProfileRef>,
}

/// Build the peer-trust map for `stored` on top of the deployment plane's
/// bundles *as they serve now*, keeping the identity that is serving.
/// Nothing is activated and nothing is stored.
///
/// Three things this refuses to do:
///
/// - **Resurrect a withdrawn generation.** A withdrawal (a revoked or lapsed
///   source) is not undone by copying its identity into a fresh candidate.
/// - **Overwrite a concurrent rotation.** The candidate carries the number of
///   the generation it was derived from, and [`activate`] swaps it in only
///   while that generation still serves.
/// - **Roll deployment-plane bundles back to boot.** A deployment-plane
///   source (the SPIFFE Workload API above all) replaces its bundles on
///   every snapshot, so the boot-time copy goes stale. Those profiles are
///   taken from the serving generation, never from the boot snapshot.
///
/// `stored_names` is every name the store has owned in this process (the
/// set being replaced and the set last activated), so a stored SPIFFE
/// profile that was removed is never mistaken for a deployment-plane one.
///
/// # Errors
///
/// `Withdrawn` for a withdrawn generation, `Invalid` for an anchor that
/// does not build or a name that shadows the deployment plane.
pub(crate) fn prepare(
    state: &AppState,
    stored_names: &BTreeSet<TrustProfileRef>,
    stored: &TrustProfileSet,
    now: DateTime<Utc>,
) -> Result<Prepared, TrustError> {
    prepare_with_quarantine(state, stored_names, stored, now, false)
}

/// Prepare a stored set for restoration. Source-reserved entries are kept in
/// the stored document but excluded from the effective local trust candidate.
/// Operator writes use [`prepare`] and remain strict.
pub(crate) fn prepare_adoption(
    state: &AppState,
    stored_names: &BTreeSet<TrustProfileRef>,
    stored: &TrustProfileSet,
    now: DateTime<Utc>,
) -> Result<Prepared, TrustError> {
    prepare_with_quarantine(state, stored_names, stored, now, true)
}

fn prepare_with_quarantine(
    state: &AppState,
    stored_names: &BTreeSet<TrustProfileRef>,
    stored: &TrustProfileSet,
    now: DateTime<Utc>,
    allow_quarantine: bool,
) -> Result<Prepared, TrustError> {
    stored.validate(now).map_err(TrustError::Invalid)?;
    let Some(generations) = state.transport_lifecycle.generations() else {
        // No runtime: still refuse a set whose anchors would not build.
        bundles(&state.transport_lifecycle.base_trust(), stored, now)
            .map_err(TrustError::Invalid)?;
        return Ok(Prepared {
            runtime: None,
            quarantined: BTreeSet::new(),
        });
    };
    let current = generations.current();
    if let Some(reason) = &current.withdrawn {
        return Err(TrustError::Withdrawn(reason.clone()));
    }
    generations
        .checked_current(Some(current.number))
        .map_err(|error| match error {
            TransportError::GenerationStale => TrustError::GenerationChanged,
            other => TrustError::Invalid(other),
        })?;
    let source = generations
        .source_trust(current.number)
        .map_err(TrustError::Invalid)?;
    let mut base = deployment_plane_trust(state, &current, stored_names);
    let mut effective = stored.clone();
    let mut quarantined = BTreeSet::new();
    if let Some(source) = source {
        for profile in stored
            .profiles
            .iter()
            .filter(|profile| profile.enabled && source.reserved.contains(&profile.profile))
        {
            if !allow_quarantine {
                return Err(TrustError::Invalid(TransportError::malformed(format!(
                    "trust profile {} is reserved by the deployment source",
                    profile.profile
                ))));
            }
            quarantined.insert(profile.profile.clone());
        }
        effective
            .profiles
            .retain(|profile| !profile.enabled || !quarantined.contains(&profile.profile));
        base.extend(source.bundles);
    }
    let peer_trust = bundles(&base, &effective, now).map_err(TrustError::Invalid)?;
    let candidate = GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust,
        own_trust: None,
        identity_required: current.identity.is_some(),
    };
    Ok(Prepared {
        runtime: Some((generations, current.number, candidate)),
        quarantined,
    })
}

/// Swap a [`Prepared`] candidate in, only while the generation it was built
/// from still serves. With no runtime attached this is a no-op.
///
/// # Errors
///
/// `GenerationChanged` when a rotation or withdrawal landed in between;
/// `Invalid` when the candidate does not activate. Either way the previous
/// generation keeps serving unchanged.
pub(crate) async fn activate(
    state: &AppState,
    prepared: Prepared,
) -> Result<Option<u64>, TrustError> {
    let Some((generations, number, candidate)) = prepared.runtime else {
        return Ok(None);
    };
    match activation::activate_candidate_if_current(
        state,
        crate::transport_lifecycle::HOST_LISTENER_TARGET,
        &generations,
        number,
        candidate,
    )
    .await
    {
        Ok(number) => Ok(Some(number)),
        Err(TransportError::GenerationStale) => Err(TrustError::GenerationChanged),
        Err(error) => Err(TrustError::Invalid(error)),
    }
}

/// A [`TrustError`] as the [`TransportError`] the background passes log.
pub(crate) fn as_transport_error(error: TrustError) -> TransportError {
    match error {
        TrustError::Invalid(inner) | TrustError::Withdrawn(inner) => inner,
        TrustError::GenerationChanged => TransportError::GenerationStale,
        other => TransportError::malformed(other.to_string()),
    }
}

/// The deployment plane's bundles as the serving generation holds them.
///
/// Names come from the boot snapshot (`base_trust`) — a stored profile can
/// never add one — but each bundle is the one serving now, and a name the
/// serving generation no longer carries (a trust domain the Workload API
/// dropped) is not brought back. On a SPIFFE listener every trust domain
/// the current snapshot delivered is deployment-plane too, including ones
/// federated after boot; a name the store owns is left to the store.
fn deployment_plane_trust(
    state: &AppState,
    current: &opensesame_transport_security::Generation,
    stored_names: &BTreeSet<TrustProfileRef>,
) -> BTreeMap<TrustProfileRef, TrustBundle> {
    let boot = state.transport_lifecycle.base_trust();
    let spiffe = state.transport.as_ref().is_some_and(|runtime| {
        runtime.config.listener.as_ref().is_some_and(|listener| {
            matches!(
                listener.identity,
                opensesame_transport_security::env::NativeIdentitySpec::Spiffe { .. }
            )
        })
    });
    current
        .peer_trust
        .iter()
        .filter(|(profile, bundle)| {
            boot.contains_key(*profile)
                || (spiffe
                    && bundle.kind() == TrustProfileKind::SpiffeTrustDomain
                    && !stored_names.contains(*profile))
        })
        .map(|(profile, bundle)| (profile.clone(), bundle.clone()))
        .collect()
}
