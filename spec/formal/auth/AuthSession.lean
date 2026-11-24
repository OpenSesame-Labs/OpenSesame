/-! Appended to `AuthPolicy.lean` and `AuthTransport.lean` by
spec/formal/check-axioms.sh: AUTH-S2 (control-plane middleware/auth.ts), the
sign-out step runner (app-core session-exit.ts) and the correspondence vectors. -/

namespace OpenSesame.AuthPolicy.Session
open OpenSesame.AuthPolicy

/-- What `resolveProvisionalSession` (auth.ts lines 33–53) reads for one token. -/
structure SessionFacts where
  (hasPrefix mapped present unrevoked : Bool) (expiresAt : Int)
  (principal : SessionPrincipal) (cleanupPending withdrawalPending : Bool)

/-- The resolver: the AUTH-S1 checks, then no pending cleanup (line 45) and no
pending withdrawal (`principalStillAuthenticates`, line 27). -/
def resolves (f : SessionFacts) (now : Int) : Bool :=
  sessionAdmitted f.hasPrefix f.mapped f.present f.unrevoked f.expiresAt now f.principal &&
    !f.cleanupPending && !f.withdrawalPending

/-- `principalStillAuthenticates` for the `prn_` bearer (lines 146–151). -/
def principalOk (p : SessionPrincipal) (withdrawal : Bool) : Bool :=
  principalCanAuthenticate p && !withdrawal

/-- `resolveBoundRequest` (lines 89–117) once any bound header is present. -/
structure BoundFacts where
  (idValid proofPresent expectedValid cookiePresent originAllowed : Bool)
  (cookie : SessionFacts) (sessionMatches principalMatches proofMatches : Bool)

inductive Bearer where
  | none | session (f : SessionFacts) | principal (p : SessionPrincipal) (withdrawal : Bool)
  | other

structure CookieFacts where (present originAllowed : Bool) (session : SessionFacts)

inductive Outcome where
  | reject | anonymous | bound | bearer | principalBearer | cookie
  deriving DecidableEq, Repr

def boundOutcome (b : BoundFacts) (now : Int) : Outcome :=
  if b.idValid && b.proofPresent && b.expectedValid && b.cookiePresent && b.originAllowed &&
      resolves b.cookie now && b.sessionMatches && b.principalMatches && b.proofMatches
  then .bound else .reject

def cookieOutcome (c : CookieFacts) (now : Int) : Outcome :=
  if c.present && c.originAllowed && resolves c.session now then .cookie else .anonymous

/-- A bearer that did not authenticate (lines 153–155). -/
def afterBearer (requireBearer : Bool) (c : CookieFacts) (now : Int) : Outcome :=
  if requireBearer then .reject else cookieOutcome c now

/-- `authMiddleware` (lines 119–172). -/
def middleware (bound : Option BoundFacts) (bearer : Bearer) (allowPrincipal requireBearer : Bool)
    (c : CookieFacts) (now : Int) : Outcome :=
  match bound with
  | some b => boundOutcome b now
  | none =>
    match bearer with
    | .none => cookieOutcome c now
    | .session f => if resolves f now then .bearer else afterBearer requireBearer c now
    | .principal p w =>
      if allowPrincipal && principalOk p w then .principalBearer else afterBearer requireBearer c now
    | .other => afterBearer requireBearer c now

theorem resolves_requires_session_admitted (f : SessionFacts) (now : Int)
    (h : resolves f now = true) :
    sessionAdmitted f.hasPrefix f.mapped f.present f.unrevoked f.expiresAt now f.principal = true := by
  simp [resolves] at h; exact h.1.1

theorem cleanup_pending_session_denied (f : SessionFacts) (now : Int)
    (h : f.cleanupPending = true) : resolves f now = false := by simp [resolves, h]

theorem pending_withdrawal_session_denied (f : SessionFacts) (now : Int)
    (h : f.withdrawalPending = true) : resolves f now = false := by simp [resolves, h]

theorem bound_never_falls_back (b : BoundFacts) (bearer : Bearer) (allow req : Bool)
    (c : CookieFacts) (now : Int) :
    middleware (some b) bearer allow req c now = .bound ∨
      middleware (some b) bearer allow req c now = .reject := by
  simp only [middleware, boundOutcome]; split <;> simp

theorem bound_admission_requires (b : BoundFacts) (bearer : Bearer) (allow req : Bool)
    (c : CookieFacts) (now : Int) (h : middleware (some b) bearer allow req c now = .bound) :
    b.idValid ∧ b.proofPresent ∧ b.expectedValid ∧ b.cookiePresent ∧ b.originAllowed ∧
      resolves b.cookie now ∧ b.sessionMatches ∧ b.principalMatches ∧ b.proofMatches := by
  simp only [middleware, boundOutcome] at h
  split at h
  · simp_all
  · cases h

theorem cookieOutcome_cases (c : CookieFacts) (now : Int) :
    cookieOutcome c now = .cookie ∨ cookieOutcome c now = .anonymous := by
  unfold cookieOutcome; split <;> simp

theorem afterBearer_cases (req : Bool) (c : CookieFacts) (now : Int) :
    afterBearer req c now = .reject ∨ afterBearer req c now = .cookie ∨
      afterBearer req c now = .anonymous := by
  unfold afterBearer; split
  · exact Or.inl rfl
  · exact Or.inr (cookieOutcome_cases c now)

theorem required_bearer_never_uses_cookie (bearer : Bearer) (allow : Bool) (c : CookieFacts)
    (now : Int) (hb : bearer ≠ .none) :
    middleware none bearer allow true c now ≠ .cookie ∧
      middleware none bearer allow true c now ≠ .anonymous := by
  cases bearer with
  | none => exact absurd rfl hb
  | session f => simp only [middleware, afterBearer]; split <;> simp
  | principal p w => simp only [middleware, afterBearer]; split <;> simp
  | other => simp [middleware, afterBearer]

/-- Which credential authenticated, as a function of the middleware's inputs. -/
theorem outcome_source (bound : Option BoundFacts) (bearer : Bearer) (allow req : Bool)
    (c : CookieFacts) (now : Int) :
    (∃ b, bound = some b ∧ middleware bound bearer allow req c now = boundOutcome b now) ∨
    (bound = none ∧ ((∃ f, bearer = .session f ∧ resolves f now = true ∧
        middleware bound bearer allow req c now = .bearer) ∨
      (allow = true ∧ (∃ p w, bearer = .principal p w ∧ principalOk p w = true) ∧
        middleware bound bearer allow req c now = .principalBearer) ∨
      (bearer = .none ∧ middleware bound bearer allow req c now = cookieOutcome c now) ∨
      middleware bound bearer allow req c now = afterBearer req c now)) := by
  cases bound with
  | some b => exact Or.inl ⟨b, rfl, rfl⟩
  | none =>
    refine Or.inr ⟨rfl, ?_⟩
    cases bearer with
    | none => exact Or.inr (Or.inr (Or.inl ⟨rfl, rfl⟩))
    | session f =>
      by_cases hr : resolves f now = true
      · exact Or.inl ⟨f, rfl, hr, by simp [middleware, hr]⟩
      · exact Or.inr (Or.inr (Or.inr (by simp [middleware, hr])))
    | principal p w =>
      by_cases ha : (allow && principalOk p w) = true
      · simp only [Bool.and_eq_true] at ha
        exact Or.inr (Or.inl ⟨ha.1, ⟨p, w, rfl, ha.2⟩, by simp [middleware, ha.1, ha.2]⟩)
      · exact Or.inr (Or.inr (Or.inr (by simp only [middleware]; rw [if_neg ha])))
    | other => exact Or.inr (Or.inr (Or.inr rfl))

theorem boundOutcome_cases (b : BoundFacts) (now : Int) :
    boundOutcome b now = .bound ∨ boundOutcome b now = .reject := by
  unfold boundOutcome; split <;> simp

theorem bearer_requires_resolution (bound : Option BoundFacts) (bearer : Bearer)
    (allow req : Bool) (c : CookieFacts) (now : Int)
    (h : middleware bound bearer allow req c now = .bearer) :
    bound = none ∧ ∃ f, bearer = .session f ∧ resolves f now = true := by
  rcases outcome_source bound bearer allow req c now with ⟨b, _, e⟩ | ⟨hb, s⟩
  · rcases boundOutcome_cases b now with x | x <;> rw [e, x] at h <;> cases h
  · refine ⟨hb, ?_⟩
    rcases s with ⟨f, hf, hr, _⟩ | ⟨_, _, e⟩ | ⟨_, e⟩ | e
    · exact ⟨f, hf, hr⟩
    · rw [e] at h; cases h
    · rcases cookieOutcome_cases c now with x | x <;> rw [e, x] at h <;> cases h
    · rcases afterBearer_cases req c now with x | x | x <;> rw [e, x] at h <;> cases h

theorem principal_bearer_requires (bound : Option BoundFacts) (bearer : Bearer)
    (allow req : Bool) (c : CookieFacts) (now : Int)
    (h : middleware bound bearer allow req c now = .principalBearer) :
    bound = none ∧ allow = true ∧ ∃ p, bearer = .principal p false ∧
      principalCanAuthenticate p = true := by
  rcases outcome_source bound bearer allow req c now with ⟨b, _, e⟩ | ⟨hb, s⟩
  · rcases boundOutcome_cases b now with x | x <;> rw [e, x] at h <;> cases h
  · rcases s with ⟨_, _, _, e⟩ | ⟨ha, ⟨p, w, hp, hok⟩, _⟩ | ⟨_, e⟩ | e
    · rw [e] at h; cases h
    · simp [principalOk] at hok
      exact ⟨hb, ha, p, by rw [hp, hok.2], hok.1⟩
    · rcases cookieOutcome_cases c now with x | x <;> rw [e, x] at h <;> cases h
    · rcases afterBearer_cases req c now with x | x | x <;> rw [e, x] at h <;> cases h

theorem cookie_requires (bound : Option BoundFacts) (bearer : Bearer) (allow req : Bool)
    (c : CookieFacts) (now : Int) (h : middleware bound bearer allow req c now = .cookie) :
    bound = none ∧ c.present ∧ c.originAllowed ∧ resolves c.session now ∧
      (req = false ∨ bearer = .none) := by
  have hc : cookieOutcome c now = .cookie →
      c.present ∧ c.originAllowed ∧ resolves c.session now := by
    intro hc; unfold cookieOutcome at hc; split at hc
    · simp_all
    · cases hc
  rcases outcome_source bound bearer allow req c now with ⟨b, _, e⟩ | ⟨hb, s⟩
  · rcases boundOutcome_cases b now with x | x <;> rw [e, x] at h <;> cases h
  · rcases s with ⟨_, _, _, e⟩ | ⟨_, _, e⟩ | ⟨hn, e⟩ | e
    · rw [e] at h; cases h
    · rw [e] at h; cases h
    · obtain ⟨a, b, d⟩ := hc (e ▸ h); exact ⟨hb, a, b, d, Or.inr hn⟩
    · rw [e] at h; unfold afterBearer at h
      cases req
      · obtain ⟨a, b, d⟩ := hc h; exact ⟨hb, a, b, d, Or.inl rfl⟩
      · cases h

/-- Every session the middleware admits (bound, bearer or ambient cookie) passed
the AUTH-S1 checks and both AUTH-S2 guards. -/
theorem admitted_session_satisfies_auth_s1 (bound : Option BoundFacts) (bearer : Bearer)
    (allow req : Bool) (c : CookieFacts) (now : Int)
    (h : middleware bound bearer allow req c now = .bound ∨
      middleware bound bearer allow req c now = .bearer ∨
      middleware bound bearer allow req c now = .cookie) :
    ∃ f : SessionFacts, sessionAdmitted f.hasPrefix f.mapped f.present f.unrevoked f.expiresAt now
      f.principal = true ∧ f.cleanupPending = false ∧ f.withdrawalPending = false := by
  have done : ∀ f : SessionFacts, resolves f now = true → ∃ g : SessionFacts,
      sessionAdmitted g.hasPrefix g.mapped g.present g.unrevoked g.expiresAt now g.principal = true ∧
        g.cleanupPending = false ∧ g.withdrawalPending = false := by
    intro f hf
    refine ⟨f, resolves_requires_session_admitted f now hf, ?_, ?_⟩ <;>
      simp [resolves] at hf <;> simp [hf]
  rcases h with h | h | h
  · cases bound with
    | none => rcases outcome_source none bearer allow req c now with ⟨_, hb, _⟩ | ⟨_, s⟩
              · cases hb
              · rcases s with ⟨_, _, _, e⟩ | ⟨_, _, e⟩ | ⟨_, e⟩ | e
                · rw [e] at h; cases h
                · rw [e] at h; cases h
                · rcases cookieOutcome_cases c now with x | x <;> rw [e, x] at h <;> cases h
                · rcases afterBearer_cases req c now with x | x | x <;> rw [e, x] at h <;> cases h
    | some b => exact done b.cookie (bound_admission_requires b bearer allow req c now h).2.2.2.2.2.1
  · obtain ⟨_, f, _, hf⟩ := bearer_requires_resolution bound bearer allow req c now h
    exact done f hf
  · exact done c.session (cookie_requires bound bearer allow req c now h).2.2.2.1

end OpenSesame.AuthPolicy.Session

namespace OpenSesame.AuthPolicy.SignOut

/-! `signOutDefault` (app-core session-exit.ts lines 48–88). Each local
clearing step runs inside `step` (lines 52–58), which catches a throw and only
marks the exit incomplete. What each step clears, browser storage, the notice
UI and `settleSignOut`'s network outcome are outside the model. -/

inductive Step where
  | fenceLocalSignOut | cancelAllTransactions | clearFederationSession | clearPendingSignIn
  | forgetPendingLink | clearPendingJoin | endJoinAuthority | forgetClaim | storeAuthOutcome
  | endSession | lockVault
  deriving DecidableEq, Repr

/-- The unconditional steps (lines 59–76), in source order. -/
def steps : List Step := [.fenceLocalSignOut, .cancelAllTransactions, .clearFederationSession,
  .clearPendingSignIn, .forgetPendingLink, .clearPendingJoin, .endJoinAuthority, .forgetClaim,
  .storeAuthOutcome, .endSession]

structure Exit where (attempted : List Step) (incomplete settles : Bool)

/-- The run for the steps that throw (`fails`); the vault locks when it is open
or awaiting a second step (lines 77–79); an incomplete exit reports and returns
before `settleSignOut` (lines 80–87). -/
def signOut (fails : Step → Bool) (vaultOpen : Bool) : Exit :=
  let attempted := steps ++ (if vaultOpen then [.lockVault] else [])
  ⟨attempted, attempted.any fails, !(attempted.any fails)⟩

theorem exit_attempts_every_step (fails : Step → Bool) (vaultOpen : Bool) (s : Step)
    (h : s ∈ steps) : s ∈ (signOut fails vaultOpen).attempted :=
  List.mem_append_left _ h

theorem exit_ends_session (fails : Step → Bool) (vaultOpen : Bool) :
    .endSession ∈ (signOut fails vaultOpen).attempted :=
  exit_attempts_every_step fails vaultOpen .endSession (by simp [steps])

theorem exit_locks_open_vault (fails : Step → Bool) (vaultOpen : Bool) (h : vaultOpen = true) :
    .lockVault ∈ (signOut fails vaultOpen).attempted := by
  subst h; exact List.mem_append_right _ (List.mem_singleton.mpr rfl)

theorem exit_incomplete_iff_failure (fails : Step → Bool) (vaultOpen : Bool) :
    (signOut fails vaultOpen).incomplete = true ↔
      ∃ s ∈ (signOut fails vaultOpen).attempted, fails s = true := List.any_eq_true

theorem exit_settles_only_when_complete (fails : Step → Bool) (vaultOpen : Bool) :
    (signOut fails vaultOpen).settles = !(signOut fails vaultOpen).incomplete := rfl

end OpenSesame.AuthPolicy.SignOut

namespace OpenSesame.AuthPolicy.Vectors
open OpenSesame.AuthPolicy OpenSesame.AuthPolicy.Session OpenSesame.AuthPolicy.Transport
open OpenSesame.AuthPolicy.Storage OpenSesame.AuthPolicy.SignOut

/-! Correspondence vectors, one row per abstract case, printed by `main`. -/

def bit (b : Bool) : String := if b then "1" else "0"
def bits : List Bool := [false, true]
def opt : Option Bool → String | none => "absent" | some true => "usable" | some false => "expired"

def assuranceCases : List (String × Option Assurance) := [("missing", none),
  ("provisional", some .provisional), ("self_asserted", some .selfAsserted),
  ("verified", some .verified), ("mfa", some .mfa),
  ("phishing_resistant", some .phishingResistant),
  ("enterprise_managed", some .enterpriseManaged), ("workload_attested", some .workloadAttested)]
def principalLabel : PrincipalVerdict → String
  | .notFound => "not_found" | .provisional => "provisional" | .admitted => "admitted"
def roleCases : List (String × Option Role) :=
  [("none", none), ("member", some .member), ("admin", some .admin), ("owner", some .owner)]
def stateCases : List (String × ProjectState) := [("provisional", .provisional),
  ("active", .active), ("expired", .expired), ("deleting", .deleting), ("deleted", .deleted)]
def expiryCases : List (String × Option Int) :=
  [("none", none), ("past", some (-1)), ("equal", some 0), ("future", some 1)]
def roleLabel : Option Role → String
  | none => "denied" | some .member => "member" | some .admin => "admin" | some .owner => "owner"
def sessionPrincipalCases : List (String × SessionPrincipal) := [("missing", .missing),
  ("provisional", .provisional), ("active", .active), ("suspended", .suspended),
  ("closed", .closed)]

/-- The two token facts the middleware vectors use: admitted, and revoked. -/
def okFacts : SessionFacts := ⟨true, true, true, true, 1, .active, false, false⟩
def revokedFacts : SessionFacts := { okFacts with unrevoked := false }
def factsCases : List (String × SessionFacts) := [("ok", okFacts), ("revoked", revokedFacts)]

def outcomeLabel : Outcome → String
  | .reject => "reject" | .anonymous => "anonymous" | .bound => "bound" | .bearer => "bearer"
  | .principalBearer => "principal" | .cookie => "cookie"
def bearerCases : List (String × Bearer) := [("none", .none), ("pst_ok", .session okFacts),
  ("pst_revoked", .session revokedFacts), ("prn_ok", .principal .active false),
  ("prn_suspended", .principal .suspended false), ("prn_withdrawn", .principal .active true),
  ("other", .other)]
def cookieCases : List (String × CookieFacts) := [("absent", ⟨false, true, okFacts⟩),
  ("cross_origin", ⟨true, false, okFacts⟩), ("ok", ⟨true, true, okFacts⟩),
  ("revoked", ⟨true, true, revokedFacts⟩)]

/-- Store slots: rows `K` (keyed) and `L` (legacy) at `now = 0`; `O` is another key's row. -/
def slotCases : List (String × Option (Option Int)) :=
  [("absent", none), ("past", some (some (-1))), ("future", some (some 1)), ("forever", some none)]
def slotLabel : Option (Row String) → String
  | none => "-"
  | some r => r.value ++ ":" ++ match r.expiresAt with
    | none => "forever" | some t => if t < 0 then "past" else "future"
def storeOf (keyed legacy : Option (Option Int)) : Store String := fun
  | .keyed "k" => keyed.map (⟨"K", ·⟩) | .legacyDigest "k" => legacy.map (⟨"L", ·⟩)
  | .keyed "o" => some ⟨"O", some 1⟩ | _ => none
def storageOps : List String := ["get", "set", "claim", "delete", "take", "adopt", "migrate"]
def runOp (s : Store String) : String → Store String × String
  | "get" => (s, (lookup false s 0 "k").getD "-")
  | "set" => (write s 0 "k" ⟨"W", none⟩, "ok")
  | "claim" => let r := claim s 0 "k" ⟨"W", none⟩; (r.1, bit r.2)
  | "delete" => let r := delete s "k"; (r.1, bit r.2)
  | "take" => let r := take s 0 "k"; (r.1, r.2.getD "-")
  | "adopt" => (rekey s 0 "k", bit (s (.legacyDigest "k")).isSome)
  | _ => (migrate s 0 ["k"], bit (liveAt s 0 (.legacyDigest "k")).isSome)

def policyCases : List (String × Policy) := [("plain", .plain), ("server_tls", .serverTls),
  ("mtls_required", .mtlsRequired), ("trusted_ingress", .trustedIngress)]
def admitLabel : Admit → String
  | .ok => "ok" | .expired => "evidence_expired" | .notBound => "peer_not_bound"
  | .forwardedUnverified => "forwarded_evidence_unverified"
  | .policyMismatch => "listener_policy_mismatch"
def partyLabel : Option Party → String
  | none => "none" | some .peer => "peer" | some .originating => "originating"
/-- Reload sequences of length at most three: `c` credential only, `t` trust change. -/
def reloadCases : List (List Bool) :=
  [[]] ++ (bits.map ([·])) ++ (bits.flatMap fun a => bits.map ([a, ·])) ++
    (bits.flatMap fun a => bits.flatMap fun b => bits.map ([a, b, ·]))
def reloadLabel (rs : List Bool) : String :=
  if rs.isEmpty then "-" else String.join (rs.map fun r => if r then "t" else "c")

def stepLabel : Step → String
  | .fenceLocalSignOut => "ambientAuthSeams.fenceLocalSignOut"
  | .cancelAllTransactions => "ambientAuthSeams.cancelAllTransactions"
  | .clearFederationSession => "clearFederationSession" | .clearPendingSignIn => "clearPendingSignIn"
  | .forgetPendingLink => "forgetPendingLink" | .clearPendingJoin => "clearPendingJoin"
  | .endJoinAuthority => "endJoinAuthority" | .forgetClaim => "forgetClaim"
  | .storeAuthOutcome => "storeAuthOutcome" | .endSession => "endSession"
  | .lockVault => "vaultStore.lock"

def main : IO Unit := do
  for (label, assurance) in assuranceCases do
    IO.println s!"principal\t{label}\t{principalLabel (principalVerdict assurance)}"
  for p in bits do for m in bits do for pr in bits do
    for (el, e) in [("past", -1), ("equal", 0), ("future", 1)] do
      for u in bits do for (pl, prin) in sessionPrincipalCases do for cl in bits do
        for w in bits do
          IO.println s!"session\t{bit p}\t{bit m}\t{bit pr}\t{el}\t{bit u}\t{pl}\t{bit cl}\t{bit w}\t{bit (resolves ⟨p, m, pr, u, e, prin, cl, w⟩ 0)}"
  for present in bits do for (sl, state) in stateCases do for (el, expiry) in expiryCases do
    for (label, role) in roleCases do
      let d := projectDecision present (isVisible state expiry 0) role
      let pf := proofsFor d
      IO.println s!"project\t{bit present}\t{sl}\t{el}\t{label}\t{roleLabel d}\t{bit pf.member}\t{bit pf.admin}\t{bit pf.owner}"
  for op in storageOps do for (kl, k) in slotCases do for (ll, l) in slotCases do
    let (t, result) := runOp (storeOf k l) op
    IO.println s!"storage\t{op}\t{kl}\t{ll}\t{result}\t{slotLabel (t (.keyed "k"))}\t{slotLabel (t (.legacyDigest "k"))}\t{(lookup false t 0 "k").getD "-"}\t{bit (liveAt t 0 (.legacyDigest "k")).isSome}\t{bit (slotLabel (t (.keyed "o")) == "O:future" && slotLabel (t (.legacyDigest "o")) == "-")}"
  for a in bits do for b in bits do for c in bits do for d in bits do for e in bits do
    for (fl, f) in factsCases do for g in bits do for h in bits do for i in bits do
      let o := middleware (some ⟨a, b, c, d, e, f, g, h, i⟩) (.session okFacts) true false ⟨true, true, okFacts⟩ 0
      IO.println s!"bound\t{bit a}\t{bit b}\t{bit c}\t{bit d}\t{bit e}\t{fl}\t{bit g}\t{bit h}\t{bit i}\t{outcomeLabel o}"
  for (bl, bearer) in bearerCases do for allow in bits do for req in bits do
    for (cl, c) in cookieCases do
      IO.println s!"credential\t{bl}\t{bit allow}\t{bit req}\t{cl}\t{outcomeLabel (middleware none bearer allow req c 0)}"
  for (pl, pol) in policyCases do for cur in bits do
    for peer in [none, some false, some true] do for orig in [none, some false, some true] do
      for err in bits do for bind in bits do
        let e : Evidence := ⟨pol, cur, peer, orig, err, bind⟩
        IO.println s!"evidence\t{pl}\t{bit cur}\t{opt peer}\t{opt orig}\t{bit err}\t{bit bind}\t{bit (peerView e)}\t{bit (originatingView e)}\t{admitLabel (admit e)}\t{partyLabel (bindingPeer e)}"
  for (step, index) in (signOut (fun _ => false) true).attempted.zipIdx do
    IO.println s!"signout\t{index}\t{stepLabel step}"
  for rs in reloadCases do
    let g := reloads ⟨1, 1⟩ rs
    IO.println s!"listener\t{reloadLabel rs}\t{g.cred}\t{g.trust}\t{bit !(recordedCurrent 1 g)}\t{bit (rs.any id)}"

end OpenSesame.AuthPolicy.Vectors
-- `lean --run` needs an unqualified entrypoint.
def main : IO Unit := OpenSesame.AuthPolicy.Vectors.main
