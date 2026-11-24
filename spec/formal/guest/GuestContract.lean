import Lean

set_option autoImplicit false

/-! Browser-side guest, staging and custody models for AUTH-C1, GUEST-V1,
CONN-S1, LOCAL-D1 and EXT-O1. Each section models the decision logic of the
cited TypeScript, with every await boundary the code re-checks made an explicit
input. `main` prints the model's answer for every case of each finite domain;
the conformance tests drive the real functions through their test seams and
require exact agreement. Browser scheduling, Web Locks, OPFS, cookies and
cryptography are inputs here, not modelled. -/

namespace OpenSesame.GuestContract

/-! ## AUTH-C1 admission (guest-auth.ts 127-179, local-guest.ts 183-200)
`assertNoKnownRemoteSession` runs before the mint (c1), after it (c2, only with
a remote Identity API) and inside the guest-ordinal lock (c3). -/

inductive Sess | none | own | other deriving DecidableEq, Repr
structure Obs where
  sess : Sess
  fed : Bool
  host : Bool
  hidden : Bool
  deriving DecidableEq, Repr

/-- `own` is the principal this admission minted; without a mint nothing matches. -/
def passes (minted : Bool) (o : Obs) : Bool :=
  (o.sess == .none || (minted && o.sess == .own)) && !o.fed && !o.host && !o.hidden

inductive Fresh | ok | signOut | unknown deriving DecidableEq, Repr

def admit (remote : Bool) (f : Fresh) (c1 c2 c3 : Obs) : Fresh :=
  if !passes false c1 then .signOut
  else if !remote then (if passes false c3 then .ok else .signOut)
  else match f with
    | .ok => if passes true c2 && passes true c3 then .ok else .signOut
    | r => r

theorem passes_refuses_evidence (m : Bool) (o : Obs)
    (h : o.sess = .other ∨ o.fed = true ∨ o.host = true ∨ o.hidden = true) : passes m o = false := by
  rcases o with ⟨s, f, ho, hi⟩; rcases h with h | h | h | h <;> simp_all [passes] <;> cases s <;> simp_all

theorem admitted_only_if_every_check_clear (r : Bool) (f : Fresh) (c1 c2 c3 : Obs)
    (h : admit r f c1 c2 c3 = .ok) :
    passes false c1 = true ∧ passes r c3 = true ∧ (r = true → f = .ok ∧ passes true c2 = true) := by
  unfold admit at h; cases r <;> cases f <;> cases h1 : passes false c1 <;>
    cases h2 : passes true c2 <;> cases h3a : passes true c3 <;> cases h3b : passes false c3 <;>
    simp_all

theorem session_seen_anywhere_refuses (r : Bool) (f : Fresh) (c1 c2 c3 o : Obs)
    (ho : o = c1 ∨ o = c3 ∨ (r = true ∧ o = c2))
    (hs : o.sess = .other ∨ o.fed = true ∨ o.host = true ∨ o.hidden = true) :
    admit r f c1 c2 c3 ≠ .ok := by
  intro h; have := admitted_only_if_every_check_clear r f c1 c2 c3 h
  rcases ho with rfl | rfl | ⟨hr, rfl⟩
  · simp [passes_refuses_evidence _ _ hs] at this
  · simp [passes_refuses_evidence _ _ hs] at this
  · simp [hr, passes_refuses_evidence _ _ hs] at this

/-! ## AUTH-C1 fresh mint (`connectFreshProvisionalDefault` and
`mintProvisionalSession`, identity.ts 317-400): cookie before the mint, a
sign-out observed when the mint returns, cookie after the mint. -/

inductive Seen | absent | present | unknown deriving DecidableEq, Repr

/-- Outcome (`ok` = session adopted), whether a bearer was minted, whether it was revoked. -/
def connectFresh (before : Seen) (signedOut : Bool) (after : Seen) : Fresh × Bool × Bool :=
  match before, signedOut, after with
  | .present, _, _ => (.signOut, false, false)
  | .unknown, _, _ => (.unknown, false, false)
  | .absent, true, _ => (.signOut, true, true)
  | .absent, false, .absent => (.ok, true, false)
  | .absent, false, .present => (.signOut, true, true)
  | .absent, false, .unknown => (.unknown, true, true)

theorem unknown_status_refuses (s : Bool) (a : Seen) :
    (connectFresh .unknown s a).1 = .unknown ∧ (connectFresh .absent false .unknown).1 = .unknown := by
  simp [connectFresh]

theorem fresh_adopts_only_clear (b a : Seen) (s : Bool) (h : (connectFresh b s a).1 = .ok) :
    b = .absent ∧ s = false ∧ a = .absent := by
  cases b <;> cases s <;> cases a <;> simp_all [connectFresh]

theorem minted_unadopted_is_revoked (b a : Seen) (s : Bool)
    (hm : (connectFresh b s a).2.1 = true) (hn : (connectFresh b s a).1 ≠ .ok) :
    (connectFresh b s a).2.2 = true := by
  cases b <;> cases s <;> cases a <;> simp_all [connectFresh]

/-! ## AUTH-C1 local-only guest (`pairedHostFetch`, browser-pairing.ts 251-304)
Each `check` reads whether a local-only guest is open after an await; each
`send` is a request carrying the Host grant. A DPoP-nonce retry repeats the
proof, check and send. -/

inductive Step | check | send deriving DecidableEq, Repr
inductive Ev | read (opened : Bool) | sent deriving DecidableEq, Repr

def pairedPlan (retry : Bool) : List Step :=
  [.check, .check, .send, .check] ++ (if retry then [.check, .send, .check] else [])

def walk : List Step → List Bool → List Ev
  | [], _ => []
  | .send :: p, s => .sent :: walk p s
  | .check :: _, [] => [.read true]
  | .check :: p, b :: s => if b then [.read true] else .read false :: walk p s

theorem walk_open_is_last (p : List Step) (s : List Bool) (pre post : List Ev)
    (h : walk p s = pre ++ .read true :: post) : post = [] := by
  induction p generalizing s pre with
  | nil => cases pre <;> simp [walk] at h
  | cons st p ih =>
    cases st with
    | send => cases pre with
      | nil => simp [walk] at h
      | cons e pre => simp only [walk, List.cons_append, List.cons.injEq] at h; exact ih s pre h.2
    | check => cases s with
      | nil => cases pre with
        | nil => simp [walk] at h; exact h
        | cons e pre => cases pre <;> simp [walk] at h
      | cons b s => cases b with
        | true => cases pre with
          | nil => simp [walk] at h; exact h
          | cons e pre => cases pre <;> simp [walk] at h
        | false => cases pre with
          | nil => simp [walk] at h
          | cons e pre => simp [walk] at h; exact ih s pre h.2

/-- A grant is sent only when no earlier boundary saw a local-only guest. -/
theorem local_only_guest_never_sends_grant (p : List Step) (s : List Bool) (pre mid post : List Ev)
    (h : walk p s = pre ++ .read true :: mid ++ .sent :: post) : False := by
  have := walk_open_is_last p s pre (mid ++ .sent :: post) (by simpa using h)
  simp at this

def sends (p : List Step) (s : List Bool) : Nat := (walk p s).count .sent
def completes (p : List Step) (s : List Bool) : Bool := (walk p s).getLast? != some (.read true)

theorem send_requires_last_boundary_clear (s : List Bool) (r : Bool) (h : completes (pairedPlan r) s = true) :
    ∀ e ∈ walk (pairedPlan r) s, e ≠ .read true := by
  intro e he hc; subst hc
  obtain ⟨pre, post, hp⟩ := List.append_of_mem he
  have := walk_open_is_last _ _ _ _ hp; subst this
  simp [completes, hp] at h

def currentGrant (localOnlyOpen : Bool) (stored : Option Nat) : Option Nat :=
  if localOnlyOpen then none else stored

theorem no_grant_reported_to_local_only_guest (stored : Option Nat) :
    currentGrant true stored = none := rfl

/-! ## AUTH-C1 sign-out epoch (identity-shared-signout.ts 58-66,
auth-generation.ts 140-158). `capture` reads the shared generation; the store
may change before `assert`. A refused write is a sign-out nobody sees. -/

inductive Store | gen (n : Nat) | refusing deriving DecidableEq, Repr
inductive Mid | none | signOut | lostWrite | refuse deriving DecidableEq, Repr

def readGen : Store → Option Nat | .gen n => some n | .refusing => none
def midStep : Store → Mid → Store
  | .gen n, .signOut => .gen (n + 1)
  | _, .refuse => .refusing
  | s, _ => s

def mayCommit (captured current : Option Nat) : Bool :=
  match captured, current with | some c, some g => g == c | _, _ => false

def epochHolds (s : Store) (m : Mid) : Bool := mayCommit (readGen s) (readGen (midStep s m))

theorem unreadable_generation_refuses (c : Option Nat) (s : Store) :
    mayCommit c none = false ∧ mayCommit none (readGen s) = false := by
  cases c <;> cases s <;> simp [mayCommit]

theorem signout_during_operation_refuses (s : Store) : epochHolds s .signOut = false := by
  cases s with
  | gen n => exact beq_false_of_ne (Nat.succ_ne_self n)
  | refusing => rfl

theorem commit_requires_same_generation (c g : Option Nat) (h : mayCommit c g = true) :
    ∃ n, c = some n ∧ g = some n := by
  cases c <;> cases g <;> simp_all [mayCommit]

theorem lost_signout_write_is_unseen (n : Nat) : epochHolds (.gen n) .lostWrite = true :=
  beq_iff_eq.mpr rfl

/-! ## GUEST-V1 transient guest store (vfs-transient-guest.ts 14-172)
One tomb, one key. `blocked` is an uncertain promotion commit; a write while
frozen waits and lands on thaw unless the store retired or blocked. -/

structure TG where
  frozen : Bool
  blocked : Bool
  retired : Bool
  value : Option Nat
  queued : List Nat
  deriving DecidableEq, Repr

inductive TOp | begin | write | freeze | freezeForeign | thaw | block | unblock | blockForeign
  | finish | release | releaseForeign | discard | releaseRetired
  deriving DecidableEq, Repr
inductive TRes | ok | refused | noStore | deferred deriving DecidableEq, Repr

def settle (g : TG) : TG :=
  { g with frozen := false, queued := [],
           value := if g.retired || g.blocked then g.value else g.queued.getLast?.or g.value }

def tstep : Option TG → Nat → TOp → Option TG × TRes
  | none, _, .begin => (some ⟨false, false, false, none, []⟩, .ok)
  | some g, _, .begin => (some g, .refused)
  | none, _, .write => (none, .noStore)
  | some g, i, .write =>
    if g.retired || g.blocked then (some g, .refused)
    else if g.frozen then (some { g with queued := g.queued ++ [i] }, .deferred)
    else (some { g with value := some i }, .ok)
  | some g, _, .freeze =>
    if g.retired || g.frozen then (some g, .refused) else (some { g with frozen := true }, .ok)
  | some g, _, .thaw => (some (settle g), .ok)
  | none, _, .thaw => (none, .ok)
  | some g, _, .block => (some (if g.retired then g else { g with blocked := true }), .ok)
  | some g, _, .unblock => (some (if g.retired then g else { g with blocked := false }), .ok)
  | some g, _, .finish => (some (settle { g with retired := true, value := none }), .ok)
  | none, _, .finish => (none, .ok)
  | some _, _, .release => (none, .ok)
  | some g, _, .discard => if g.value.isSome || g.frozen then (some g, .refused) else (none, .ok)
  | some g, _, .releaseRetired => (if g.retired then none else some g, .ok)
  | none, _, .releaseRetired => (none, .ok)
  | s, _, _ => (s, .refused)

theorem fresh_guest_never_wipes_another (g : TG) (i : Nat) : tstep (some g) i .begin = (some g, .refused) := rfl

theorem blocked_or_retired_refuses_writes (g : TG) (i : Nat) (h : g.blocked = true ∨ g.retired = true) :
    tstep (some g) i .write = (some g, .refused) := by
  rcases h with h | h <;> simp [tstep, h]

theorem foreign_owner_changes_nothing (s : Option TG) (i : Nat) (op : TOp)
    (h : op = .freezeForeign ∨ op = .blockForeign ∨ op = .releaseForeign) : (tstep s i op).1 = s := by
  rcases h with rfl | rfl | rfl <;> cases s <;> rfl

/-- A blocked (uncertain-commit) guest leaves `blocked` only through the owner's unblock. -/
theorem frozen_guest_only_recovers (g g' : TG) (i : Nat) (op : TOp) (hb : g.blocked = true)
    (h : (tstep (some g) i op).1 = some g') (hu : g'.blocked = false) : op = .unblock := by
  cases op <;> simp [tstep, settle] at h <;> (try split at h) <;> (try split at h) <;>
    simp_all <;> (try subst h) <;> simp_all

/-! ## GUEST-V1 opening (`selectGuestScope`, `prepareGuestOpen`,
store-guest-material.ts 95-141): a decoy uses the scratch tomb, every other
guest a new isolated tomb begun as a transient store. Its checks run after the
person, after the lease, inside the material (isolated only) and at the end; a
failing check releases the lease and discards the unpublished transient store. -/

def guestScope (decoy : Bool) : String := if decoy then "scratch" else "fresh"

/-- (opened, transient store left) when the check at boundary `k` fails. -/
def prepareOpen (decoy : Bool) (k : Option Nat) : Bool × Bool :=
  match k with
  | some k => if k < (if decoy then 3 else 4) then (false, false) else (true, !decoy)
  | none => (true, !decoy)

theorem failed_open_leaves_nothing (d : Bool) (k : Nat) (h : k < 3) : prepareOpen d (some k) = (false, false) := by
  cases d <;> simp [prepareOpen] <;> omega

theorem decoy_never_opens_a_guest_tomb (k : Option Nat) : (prepareOpen true k).2 = false := by
  cases k <;> simp [prepareOpen]; split <;> rfl

/-! ## GUEST-V1 header and promotion order. `publishOriginalHeader`
(store-header-publication.ts 224-246) refuses the scratch tomb before any check
and commits only if every check up to the write passes. `promoteGuestVault`
(guest-vault-promotion.ts 152-233) writes the reservation, the recovery
manifest, each non-header file, then the header; deletion (vfs-guest-deletion.ts
315-340) journals, unlinks, revises the index, then idles the journal. -/

inductive Fail | none | beforePrepare | afterPrepare | inWrite | afterWrite deriving DecidableEq, Repr

/-- (header written, publication succeeded) -/
def publish (scratch : Bool) (f : Fail) : Bool × Bool :=
  if scratch then (false, false)
  else match f with | .none => (true, true) | .afterWrite => (true, false) | _ => (false, false)

theorem scratch_never_gets_header (f : Fail) : (publish true f).1 = false := rfl

inductive PromotionStep | reserve | manifest | body | header | release deriving DecidableEq, Repr

/-- The registry reservation is released (best effort) after the header. -/
def promotionPlan (files : Nat) : List PromotionStep :=
  [.reserve, .manifest] ++ List.replicate files .body ++ [.header, .release]

theorem promotion_header_last (n : Nat) : (promotionPlan n).dropLast.getLast? = some .header := by
  rw [show promotionPlan n = ([.reserve, .manifest] ++ List.replicate n .body ++ [.header]) ++ [.release] from
    by simp [promotionPlan], List.dropLast_concat]
  exact List.getLast?_concat

theorem interrupted_promotion_has_no_header (n k : Nat) (hk : k ≤ n + 2) :
    PromotionStep.header ∉ (promotionPlan n).take k := by
  have e : promotionPlan n = ([.reserve, .manifest] ++ List.replicate n .body : List PromotionStep) ++ [.header, .release] := rfl
  rw [e, List.take_append_of_le_length (by simp; omega)]
  intro hm; have := List.mem_of_mem_take hm; simp at this

/-- Interruption at durable write `k`; `committed`: that write landed before it failed. -/
def promote (n : Nat) (k : Option Nat) (committed : Bool) : Bool :=
  match k with | none => true | some k => (k == n + 2 && committed) || k == n + 3

theorem promotion_header_only_when_complete (n k : Nat) (c : Bool) (h : promote n (some k) c = true) :
    n + 2 ≤ k := by simp [promote] at h; omega

def deletionPlan : List String := ["journal", "unlink", "index", "idle"]

theorem deletion_journals_before_unlink :
    deletionPlan.idxOf "journal" < deletionPlan.idxOf "unlink" := by decide

end OpenSesame.GuestContract
