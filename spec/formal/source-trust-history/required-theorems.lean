open OpenSesame.SourceTrustHistory

#require_theorem OpenSesame.SourceTrustHistory.unattested_initialization_refused :
  ∀ (record : Option Record) (names : List Nat), bootstrap record false names = record
#require_theorem OpenSesame.SourceTrustHistory.existing_history_not_replaced :
  ∀ (record : Record) (attested : Bool) (names : List Nat),
    bootstrap (some record) attested names = some record
#require_theorem OpenSesame.SourceTrustHistory.missing_history_cannot_union :
  ∀ (expected : Nat) (names : List Nat), attempt none expected names = none
#require_theorem OpenSesame.SourceTrustHistory.stale_compare_changes_nothing :
  ∀ (record : Record) (expected : Nat) (names : List Nat), record.revision ≠ expected →
    attempt (some record) expected names = some record
#require_theorem OpenSesame.SourceTrustHistory.prior_name_survives :
  ∀ (record : Record) (expected name : Nat) (names : List Nat), name ∈ record.names →
    ∃ result, attempt (some record) expected names = some result ∧ name ∈ result.names
#require_theorem OpenSesame.SourceTrustHistory.successful_compare_adds_name :
  ∀ (record : Record) (name : Nat) (names : List Nat), name ∈ names →
    ∃ result, attempt (some record) record.revision names = some result ∧ name ∈ result.names
#require_theorem OpenSesame.SourceTrustHistory.revision_does_not_decrease :
  ∀ (record : Record) (expected : Nat) (names : List Nat),
    ∃ result, attempt (some record) expected names = some result ∧ record.revision ≤ result.revision
#require_theorem OpenSesame.SourceTrustHistory.retry_preserves_both_writers :
  ∀ (record : Record) (first second : Nat) (firstNames secondNames : List Nat),
    first ∈ firstNames → second ∈ secondNames →
    ∃ winner final,
      attempt (some record) record.revision firstNames = some winner ∧
      attempt (some winner) winner.revision secondNames = some final ∧
      first ∈ final.names ∧ second ∈ final.names
#require_theorem OpenSesame.SourceTrustHistory.reserved_name_not_added_by_local_update :
  ∀ (m : Manager) (name : Nat) (proposed : List Nat), name ∈ m.reserved → name ∉ m.locallyTrusted →
    name ∉ (localUpdate m proposed).locallyTrusted
#require_theorem OpenSesame.SourceTrustHistory.pending_name_stays_blocked_after_handoff :
  ∀ (m : Manager) (names proposed : List Nat) (name newOwner : Nat), name ∈ names →
    name ∉ (localUpdate (handoff (reservePending m names) newOwner) proposed).locallyTrusted
#require_theorem OpenSesame.SourceTrustHistory.no_publication_without_receipt :
  ∀ (m : Manager) (owner epoch wall wallBound mono monoBound : Nat),
    publish m owner epoch false wall wallBound mono monoBound = m
#require_theorem OpenSesame.SourceTrustHistory.stale_owner_or_epoch_does_not_publish :
  ∀ (m : Manager) (owner epoch : Nat) (receipt : Bool) (wall wallBound mono monoBound : Nat),
    (m.owner ≠ owner ∨ m.epoch ≠ epoch) →
    publish m owner epoch receipt wall wallBound mono monoBound = m
#require_theorem OpenSesame.SourceTrustHistory.elapsed_wait_does_not_publish :
  ∀ (m : Manager) (owner epoch : Nat) (receipt : Bool) (wall wallBound mono monoBound : Nat),
    (wallBound ≤ wall ∨ monoBound ≤ mono) →
    publish m owner epoch receipt wall wallBound mono monoBound = m
#require_theorem OpenSesame.SourceTrustHistory.elapsed_provisional_generation_not_usable :
  ∀ (expired : Bool) (wall wallBound mono monoBound : Nat),
    (wallBound ≤ wall ∨ monoBound ≤ mono) →
    provisionalUsable expired wall wallBound mono monoBound = false
#require_theorem OpenSesame.SourceTrustHistory.observed_provisional_expiry_cannot_finalize :
  ∀ (wall wallBound mono monoBound : Nat),
    finalizePermitted true wall wallBound mono monoBound = false
#require_theorem OpenSesame.SourceTrustHistory.pending_write_blocks_reconstruction :
  ∀ (c : Coordination), c.pending ≠ 0 → successorMayClaim c = false
#require_theorem OpenSesame.SourceTrustHistory.retirement_does_not_forget_a_pending_write :
  ∀ (c : Coordination), c.pending ≠ 0 → successorMayClaim (retireManager c) = false
#require_theorem OpenSesame.SourceTrustHistory.unknown_write_outcome_fences_successor :
  ∀ (c : Coordination), successorMayClaim (abortPending c) = false
#require_theorem OpenSesame.SourceTrustHistory.occupied_file_claim_refused :
  ∀ (owner candidate : Nat), claimFile (some owner) candidate = .refused owner
#require_theorem OpenSesame.SourceTrustHistory.unrelated_exit_preserves_file_owner :
  ∀ (owner exiting : Nat), owner ≠ exiting → fileProcessExit (some owner) exiting = some owner
#require_theorem OpenSesame.SourceTrustHistory.observed_event_supersedes_prior_result :
  ∀ (gate : StreamGate) (token : Nat),
    finishPending (observeNewEvent gate) token = observeNewEvent gate
#require_theorem OpenSesame.SourceTrustHistory.saturated_write_capacity_refuses :
  ∀ (limit active : Nat), limit ≤ active → mayStartWrite limit active = false
#require_theorem OpenSesame.SourceTrustHistory.reserved_stored_name_is_quarantined :
  ∀ (reserved stored : List Nat) (name : Nat), name ∈ reserved → name ∉ effectiveStored reserved stored
#require_theorem OpenSesame.SourceTrustHistory.changed_generation_requires_reconciliation :
  ∀ (revision before after : Nat), before ≠ after →
    refreshRequired revision revision (some before) (some after) false = true
#require_theorem OpenSesame.SourceTrustHistory.stale_merge_cannot_replace_new_generation :
  ∀ (expected current candidate : Nat), expected ≠ current →
    conditionalGeneration expected current candidate = current
