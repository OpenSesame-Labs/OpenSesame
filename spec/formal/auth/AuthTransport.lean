/-! Appended to `AuthPolicy.lean` by spec/formal/check-axioms.sh, before
`AuthSession.lean`: IDENTITY-TLS1 (control-plane transport/listener.ts and
transport/request-evidence.ts). -/

namespace OpenSesame.AuthPolicy.Transport

/-! IDENTITY-TLS1. `Evidence` is the input of `recordRequestEvidence`
(request-evidence.ts lines 63–127): `current` is `isCurrent()` (the listener's
trust generation is the one the request was recorded under), a peer is absent
or usable/expired at the read's clock, and `bindingAllows` says whether the
binding set resolves the acting identity for the purpose and operation.
Certificate parsing, chain verification, `resolveOriginating`, the TLS stack,
socket lifetimes and concurrency are outside the model. -/

inductive Policy where | plain | serverTls | mtlsRequired | trustedIngress
  deriving DecidableEq, Repr

structure Evidence where
  (policy : Policy) (current : Bool) (peer originating : Option Bool)
  (originatingError bindingAllows : Bool)

inductive Admit where
  | ok | expired | notBound | forwardedUnverified | policyMismatch
  deriving DecidableEq, Repr

inductive Party where | peer | originating
  deriving DecidableEq, Repr

/-- The `peer` getter (lines 71–75). -/
def peerView (e : Evidence) : Bool := e.current && e.peer == some true

/-- The `originating` getter (lines 76–83). -/
def originatingView (e : Evidence) : Bool :=
  e.current && e.peer == some true && e.originating == some true

def unbound (e : Evidence) : Admit := if e.originatingError then .forwardedUnverified else .notBound

/-- `admit` (lines 84–122) with `admitService` (service-admission.ts lines 47–71). -/
def admit (e : Evidence) : Admit :=
  if !e.current || e.peer == some false then .expired
  else if e.policy == .trustedIngress && e.originating.isNone then unbound e
  else match e.originating <|> e.peer with
    | none => if e.policy == .plain then .policyMismatch else unbound e
    | some usable => if !usable then .expired else if e.bindingAllows then .ok else .notBound

/-- `bindingPeerOf` (lines 174–196). -/
def bindingPeer (e : Evidence) : Option Party :=
  if originatingView e then some .originating
  else if e.originatingError || e.policy == .trustedIngress then none
  else if peerView e then some .peer else none

theorem stale_evidence_refused (e : Evidence) (h : e.current = false) :
    peerView e = false ∧ originatingView e = false ∧ admit e = .expired ∧ bindingPeer e = none := by
  simp [peerView, originatingView, admit, bindingPeer, h]

theorem admit_ok_requires (e : Evidence) (h : admit e = .ok) :
    e.current = true ∧ e.bindingAllows = true ∧ e.peer ≠ some false ∧
      (e.originating = some true ∨ (e.originating = none ∧ e.peer = some true)) := by
  rcases e with ⟨pol, cur, peer, orig, err, bind⟩
  cases pol <;> cases cur <;> cases err <;> cases bind <;>
    rcases peer with _ | ⟨_ | _⟩ <;> rcases orig with _ | ⟨_ | _⟩ <;>
    simp_all [admit, unbound]

theorem ingress_never_acts_as_client (e : Evidence) (h : e.policy = .trustedIngress) :
    bindingPeer e ≠ some .peer ∧ (admit e = .ok → e.originating = some true) := by
  rcases e with ⟨pol, cur, peer, orig, err, bind⟩
  simp only at h; subst h
  cases cur <;> cases err <;> cases bind <;>
    rcases peer with _ | ⟨_ | _⟩ <;> rcases orig with _ | ⟨_ | _⟩ <;>
    simp_all [admit, unbound, bindingPeer, originatingView]

theorem forwarded_error_never_binds_peer (e : Evidence) (h : e.originatingError = true) :
    bindingPeer e ≠ some .peer := by
  unfold bindingPeer; split
  · simp
  · simp [h]

/-- Listener generations (listener.ts `restart`, lines 237–262): every reload
advances the credential generation; one that changes client CA, originating
trust or bindings also advances the trust generation and closes connections. -/
structure Gens where (trust cred : Nat)

def reload (g : Gens) (trustChanged : Bool) : Gens :=
  ⟨if trustChanged then g.trust + 1 else g.trust, g.cred + 1⟩

def reloads (g : Gens) (rs : List Bool) : Gens := rs.foldl reload g

/-- `isCurrent` (line 201) and the socket registry's check (line 173). -/
def recordedCurrent (recorded : Nat) (g : Gens) : Bool := recorded == g.trust

/-- The number of reloads that changed trust. -/
def changes : List Bool → Nat | [] => 0 | r :: rs => (if r then 1 else 0) + changes rs

private theorem reloads_trust (g : Gens) (rs : List Bool) :
    (reloads g rs).trust = g.trust + changes rs := by
  induction rs generalizing g with
  | nil => rfl
  | cons r rest ih =>
    show (reloads (reload g r) rest).trust = _
    rw [ih]; cases r <;> simp [reload, changes, Nat.add_assoc]

private theorem changes_pos (rs : List Bool) (h : true ∈ rs) : changes rs ≠ 0 := by
  induction rs with
  | nil => cases h
  | cons r rest ih =>
    cases r
    · rcases List.mem_cons.mp h with e | e
      · cases e
      · show 0 + changes rest ≠ 0
        rw [Nat.zero_add]; exact ih e
    · show 1 + changes rest ≠ 0
      rw [Nat.add_comm]; exact Nat.succ_ne_zero _

private theorem changes_zero (rs : List Bool) (h : ∀ r ∈ rs, r = false) : changes rs = 0 := by
  induction rs with
  | nil => rfl
  | cons r rest ih =>
    have hr := h r List.mem_cons_self; subst hr
    simp only [changes]; exact (Nat.zero_add _).symm ▸ ih (fun x hx => h x (List.mem_cons_of_mem _ hx))

theorem trust_change_stales (g : Gens) (rs : List Bool) (h : true ∈ rs) :
    recordedCurrent g.trust (reloads g rs) = false := by
  unfold recordedCurrent; rw [reloads_trust]
  cases hb : (g.trust == g.trust + changes rs) with
  | false => rfl
  | true =>
    have e : g.trust + 0 = g.trust + changes rs := (Nat.add_zero _).trans (eq_of_beq hb)
    exact absurd (Nat.add_left_cancel e).symm (changes_pos rs h)

theorem credential_reload_keeps_current (g : Gens) (rs : List Bool) (h : ∀ r ∈ rs, r = false) :
    recordedCurrent g.trust (reloads g rs) = true := by
  unfold recordedCurrent; rw [reloads_trust, changes_zero rs h, Nat.add_zero]; exact beq_iff_eq.mpr rfl

end OpenSesame.AuthPolicy.Transport
