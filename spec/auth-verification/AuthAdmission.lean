import Std

/-!
  An abstract contract for the Identity API's cookie-origin and provisional
  session checks. These definitions are not extracted from TypeScript. See
  README.md for the abstraction, assumptions, and corresponding tests.
-/

namespace AuthAdmission

namespace CookieOrigin

/-- `sameOrigin` is the result of parsing the configured public URL; parsing
    itself is intentionally outside this model. `allowed` is the configured
    CORS-origin list, compared exactly. -/
def decide (safe : Bool) (origin : Option String) (allowed : List String)
    (sameOrigin : Option String) : Bool :=
  if safe then true
  else match origin with
    | none => false
    | some value =>
      if value = "" then false
      else if value ∈ allowed then true
      else if sameOrigin = some value then true
      else false

/-- Unsafe requests may use the ambient cookie only for a named trusted
    origin. Safe requests do not require an Origin header. -/
def policy (safe : Bool) (origin : Option String) (allowed : List String)
    (sameOrigin : Option String) : Prop :=
  safe = true ∨ ∃ value, origin = some value ∧ value ≠ "" ∧
    (value ∈ allowed ∨ sameOrigin = some value)

theorem decision_refines_policy (safe : Bool) (origin : Option String)
    (allowed : List String) (sameOrigin : Option String) :
    decide safe origin allowed sameOrigin = true ↔
      policy safe origin allowed sameOrigin := by
  cases safe <;> cases origin <;> simp [decide, policy]

theorem unsafe_missing_origin_denied (allowed : List String)
    (sameOrigin : Option String) :
    decide false none allowed sameOrigin = false := by
  rfl

theorem unsafe_empty_origin_denied (allowed : List String)
    (sameOrigin : Option String) :
    decide false (some "") allowed sameOrigin = false := by
  rfl

theorem unsafe_untrusted_origin_denied (value : String) (allowed : List String)
    (sameOrigin : Option String) (notListed : value ∉ allowed)
    (notSame : sameOrigin ≠ some value) :
    decide false (some value) allowed sameOrigin = false := by
  simp [decide, notListed, notSame]

end CookieOrigin

namespace Session

inductive Principal where
  | absent | provisional | active | suspended | closed
  deriving DecidableEq

structure Facts where
  accessPrefix : Bool
  tokenMapped : Bool
  sessionPresent : Bool
  now : Nat
  expiresAt : Nat
  revoked : Bool
  principal : Principal

/-- An abstraction of the branch order in resolveProvisionalSession. -/
def decide (facts : Facts) : Bool :=
  if !facts.accessPrefix then false
  else if !facts.tokenMapped then false
  else if !facts.sessionPresent then false
  else if facts.expiresAt ≤ facts.now then false
  else if facts.revoked then false
  else match facts.principal with
    | .provisional | .active => true
    | .absent | .suspended | .closed => false

/-- Positive authentication requires every lease condition and a live
    principal. Times are abstract nonnegative mathematical integers. -/
def policy (facts : Facts) : Prop :=
  facts.accessPrefix = true ∧ facts.tokenMapped = true ∧
    facts.sessionPresent = true ∧ facts.now < facts.expiresAt ∧
    facts.revoked = false ∧
    (facts.principal = .provisional ∨ facts.principal = .active)

theorem decision_refines_policy (facts : Facts) :
    decide facts = true ↔ policy facts := by
  cases hp : facts.accessPrefix <;>
    cases hm : facts.tokenMapped <;>
    cases hs : facts.sessionPresent <;>
    cases hr : facts.revoked <;>
    cases hpr : facts.principal <;>
    simp [decide, policy, hp, hm, hs, hr, hpr, Nat.not_le]

theorem expired_denied (facts : Facts) (expired : facts.expiresAt ≤ facts.now) :
    decide facts = false := by
  simp [decide, expired]

theorem revoked_denied (facts : Facts) (revoked : facts.revoked = true) :
    decide facts = false := by
  simp [decide, revoked]

theorem suspended_denied (facts : Facts) (suspended : facts.principal = .suspended) :
    decide facts = false := by
  simp [decide, suspended]

end Session

namespace OidcResponse

structure Transaction where
  expectedState : String
  expiresAt : Nat
  spent : Bool

structure Response where
  state : String
  now : Nat
  ownerCurrent : Bool
  error : Bool
  hasCode : Bool
  codeBounded : Bool

/-- The token exchange can begin only for the original, live, unspent
    authorization-code transaction. This contract addresses the response
    binding alone, not signature, issuer, audience, nonce, or PKCE checks. -/
def policy (tx : Transaction) (response : Response) : Prop :=
  tx.spent = false ∧ response.ownerCurrent = true ∧
    response.now < tx.expiresAt ∧ response.state = tx.expectedState ∧
    response.error = false ∧ response.hasCode = true ∧
    response.codeBounded = true

/-- Completing any fresh transaction consumes it before testing the response;
    the Boolean result indicates only whether exchange may begin. -/
def complete (tx : Transaction) (response : Response) : Transaction × Bool :=
  if tx.spent then (tx, false)
  else ({ tx with spent := true },
    response.ownerCurrent && decide (response.now < tx.expiresAt) &&
    decide (response.state = tx.expectedState) && !response.error &&
    response.hasCode && response.codeBounded)

theorem complete_refines_policy (tx : Transaction) (response : Response) :
    (complete tx response).2 = true ↔ policy tx response := by
  cases spent : tx.spent <;> simp [complete, policy, spent, and_assoc]

theorem complete_consumes (tx : Transaction) (response : Response) :
    (complete tx response).1.spent = true := by
  cases spent : tx.spent <;> simp [complete, spent]

theorem replay_never_exchanges (tx : Transaction) (first second : Response) :
    (complete (complete tx first).1 second).2 = false := by
  cases spent : tx.spent <;> simp [complete, spent]

theorem mismatched_state_never_exchanges (tx : Transaction) (response : Response)
    (mismatch : response.state ≠ tx.expectedState) :
    (complete tx response).2 = false := by
  cases spent : tx.spent <;> simp [complete, spent, mismatch]

end OidcResponse

end AuthAdmission
