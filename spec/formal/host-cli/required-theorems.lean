/- Independent propositions for the CLI app-integration and Host relay restrictions. -/
open OpenSesame.HostCli

-- CLI-WA1: assertion origin, RP, presence, binding and counter.
#require_theorem OpenSesame.HostCli.assertion_requires_exact_origin :
  ∀ (a : Assertion) (stored n : Nat), verify a stored = some n →
    a.clientType = .get ∧ a.origin = true ∧ a.cross ≠ .yes ∧ a.top ≠ .other
#require_theorem OpenSesame.HostCli.assertion_requires_rp_and_presence :
  ∀ (a : Assertion) (stored n : Nat), verify a stored = some n →
    a.pairable = true ∧ a.long = true ∧ a.rp = true ∧ a.up = true ∧ a.uv = true
#require_theorem OpenSesame.HostCli.assertion_binds_challenge_and_key :
  ∀ (a : Assertion) (stored n : Nat), verify a stored = some n →
    a.credential = true ∧ a.challenge = true ∧ a.signature = true ∧ n = a.count
#require_theorem OpenSesame.HostCli.assertion_counter_advances :
  ∀ (a : Assertion) (stored n : Nat), verify a stored = some n → stored < n ∨ (n = 0 ∧ stored = 0)
#require_theorem OpenSesame.HostCli.exact_present_assertion_accepted :
  verify ⟨true, .get, true, .no, .same, true, true, true, true, true, true, 1, true⟩ 0 = some 1

-- CLI-WA2: registration attaches once, never replaces, and never lowers the count.
#require_theorem OpenSesame.HostCli.register_never_replaces :
  ∀ (c : Cred) (r : Registration), ∃ c', (register (some c) r).2 = some c' ∧
    c'.id = c.id ∧ c'.key = c.key ∧ c.count ≤ c'.count
#require_theorem OpenSesame.HostCli.register_attaches_only_verified :
  ∀ (r : Registration) (c : Cred), (register none r).2 = some c →
    r.found = true ∧ r.digest = true ∧ r.key ≠ .device ∧ r.verified = some c.count ∧
      c.id = r.id ∧ c.key = r.key
#require_theorem OpenSesame.HostCli.register_failure_is_inert :
  ∀ (slot : Option Cred) (r : Registration), (register slot r).1 ≠ .ok → (register slot r).2 = slot
#require_theorem OpenSesame.HostCli.history_keeps_credential :
  ∀ (steps : List Step) (c : Cred), ∃ c', run (some c) steps = some c' ∧
    c'.id = c.id ∧ c'.key = c.key ∧ c.count ≤ c'.count

-- CLI-WA3: every verb is refused before any session is created or reused.
#require_theorem OpenSesame.HostCli.ensure_always_denied :
  ∀ (s : Store) (verb : String) (reuse approvable : Bool), (ensure s verb reuse approvable).1 = .denied
#require_theorem OpenSesame.HostCli.ensure_creates_and_reuses_nothing :
  ∀ (s : Store) (verb : String) (reuse approvable : Bool),
    (ensure s verb reuse approvable).2.approved = s.approved ∧
    (ensure s verb reuse approvable).2.denied = s.denied ∧
    (ensure s verb reuse approvable).2.pending ≠ .stale ∧
    ((ensure s verb reuse approvable).2.pending = .live → s.pending = .live)
#require_theorem OpenSesame.HostCli.human_proof_never_verifies :
  ∀ (verb : String) (pinLocked : Bool) (label : Label) (valid : Bool),
    humanProof verb pinLocked label valid = none
#require_theorem OpenSesame.HostCli.approval_never_granted :
  ∀ (verb : String) (label : Label) (valid : Bool), approve verb label valid = false

-- RELAY-T1: organization isolation of inspection and denial.
#require_theorem OpenSesame.HostCli.cross_tenant_refused :
  ∀ (c : Caller) (route : Route) (r : Row) (org : Org) (party : Party),
    scope c = some (org, party) → org ≠ r.org →
      (handle c route r).2 = r.state ∧ ∀ v, (handle c route r).1 ≠ .view v
#require_theorem OpenSesame.HostCli.view_requires_party :
  ∀ (c : Caller) (route : Route) (r : Row) (v : View), (handle c route r).1 = .view v →
    route = .get ∧ ∃ party, scope c = some (r.org, party) ∧ party ≠ .stranger
#require_theorem OpenSesame.HostCli.state_change_requires_holder :
  ∀ (c : Caller) (route : Route) (r : Row), (handle c route r).2 ≠ r.state →
    route = .deny ∧ scope c = some (r.org, .holder) ∧ r.state = .pendingApproval ∧ r.expired = false
#require_theorem OpenSesame.HostCli.anonymous_refused :
  ∀ (route : Route) (r : Row), handle .anonymous route r = (.unauthorized, r.state)

-- RELAY-F1: execution fails closed and stored modes carry no fallback authority.
#require_theorem OpenSesame.HostCli.execution_routes_unavailable :
  ∀ (c : Caller) (route : Route) (r : Row) (org : Org) (party : Party),
    scope c = some (org, party) → route ≠ .get → route ≠ .deny →
      handle c route r = (.unavailable, r.state)
#require_theorem OpenSesame.HostCli.unknown_mode_has_no_authority :
  ∀ (s : StoredMode), s ≠ .relay → s ≠ .broker → parseMode s = none
#require_theorem OpenSesame.HostCli.broker_mode_not_claimable : claimable .broker = false
#require_theorem OpenSesame.HostCli.delegated_invoke_never_executes :
  ∀ (s : StoredMode), delegatedInvoke s ≠ .executed
#require_theorem OpenSesame.HostCli.relay_only_never_falls_back :
  ∀ (s : StoredMode), parseMode s = some .relay → delegatedInvoke s = .relayUnavailable
