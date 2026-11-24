/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.Invocation

#require_theorem OpenSesame.Invocation.prior_requires_binding_receipt_and_policy :
    ∀ (mode : Mode) (stored : Stored) (receipt : Receipt) (allows : Bool)
    (_h : decide mode stored receipt allows = .prior),
    stored = .sameBinding ∧ receipt = .valid ∧ allows = true

#require_theorem OpenSesame.Invocation.reserved_key_never_executes :
    ∀ (mode : Mode) (stored : Stored) (receipt : Receipt) (allows : Bool)
    (_h : stored ≠ .none), decide mode stored receipt allows ≠ .executed

#require_theorem OpenSesame.Invocation.replay_never_starts_an_invocation :
    ∀ (stored : Stored) (receipt : Receipt) (allows : Bool),
    decide .replay stored receipt allows = .prior ∨
      ∃ reason, decide .replay stored receipt allows = .conflict reason

#require_theorem OpenSesame.Invocation.current_denial_withholds_prior :
    ∀ (mode : Mode) (stored : Stored) (receipt : Receipt),
    decide mode stored receipt false ≠ .prior

open OpenSesame.InvocationEffects

#require_theorem OpenSesame.InvocationEffects.o1_receipt_has_no_provider_fields :
    ∀ (path : Path) (c : Connector) (p : Provider),
    (receipt path c p).summary = false ∧ (receipt path c p).requestDigest = false ∧
      (receipt path c p).responseDigest = false

#require_theorem OpenSesame.InvocationEffects.o1_outcome_only_from_host_mock :
    ∀ (path : Path) (c : Connector) (p : Provider)
    (_h : (receipt path c p).outcome ≠ .indeterminate), c = .hostMock ∧ path ≠ .independent

#require_theorem OpenSesame.InvocationEffects.o1_withheld_receipt_ignores_provider :
    ∀ (path : Path) (c : Connector) (p q : Provider) (_h : discloses path c = false),
    receipt path c p = receipt path c q

#require_theorem OpenSesame.InvocationEffects.o1_schema6_signing_refuses_provider_fields :
    ∀ (l : Leak) (_h : signs .v6 l = true), l = .none

#require_theorem OpenSesame.InvocationEffects.o2_opening_only_for_verified_opaque_receipt :
    ∀ (s : Schema) (l : Leak) (k : Key) (tampered : Bool) (_h : opens s l k tampered = true),
    s = .v6 ∧ l = .none ∧ k = .active ∧ tampered = false

#require_theorem OpenSesame.InvocationEffects.o2_commitment_opens_only_original :
    ∀ (s : Schema) (o : Opening) (d : Digest),
    verifiesOpening s o d = true ↔ s = .v6 ∧ o = .own ∧ d = .original

#require_theorem OpenSesame.InvocationEffects.d1_dispatch_requires_the_captured_request :
    ∀ (call : Call) (change : Change) (delegated : Bool) (c : Connector)
    (_h : dispatch call change delegated c = .connector ∨
      dispatch call change delegated c = .hostMock),
    call = .bound ∧ change = .exact

#require_theorem OpenSesame.InvocationEffects.d1_delegated_never_reaches_a_registered_connector :
    ∀ (call : Call) (change : Change), dispatch call change true .registered ≠ .connector

#require_theorem OpenSesame.InvocationEffects.d1_unbound_invoke_never_dispatches :
    ∀ (change : Change) (delegated : Bool) (c : Connector),
    dispatch .unbound change delegated c = .mismatch

#require_theorem OpenSesame.InvocationEffects.d1_binding_refuses_inconsistent_authority :
    ∀ (v : Capture), captures v = true ↔ v = .consistent

#require_theorem OpenSesame.InvocationEffects.d2_egress_requires_owner_row_and_active_root_grant :
    ∀ (e : Egress) (_h : egress e = .sent),
    e.providerMatches ∧ e.ownerMatches ∧ e.grantOrganization ∧ e.grantConnection = .same ∧
      e.rootGrant ∧ e.shallowGrant ∧ e.grantActive ∧ e.stored ∧ e.row = .active ∧
      e.urlAllowed
