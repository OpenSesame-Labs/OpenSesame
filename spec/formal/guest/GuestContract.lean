import Lean

set_option autoImplicit false

/-! Abstract contracts for AUTH-C1 (fresh-guest admission, local-only guest,
sign-out epoch) and GUEST-V1 (isolated guest tombs). Each section states the
property the register claims of the implementation as a small model and proves
it of that model. No implementation file is mapped to these models and no
executable correspondence checks them: they prove the stated contract, not the
TypeScript. -/

namespace OpenSesame.GuestContract

/-! ## AUTH-C1: fresh-guest admission

`assertNoKnownRemoteSession` (guest-auth.ts) runs before the provisional mint,
after it, and inside the guest-person mint lock. Each run reads the facts
below; any present or unknown session refuses with the sign-out-first message. -/

/-- What one admission check observes. `unknown` covers a held or unreadable answer. -/
inductive Seen where
  | absent
  | present
  | unknown
  deriving DecidableEq, Repr

structure Observation where
  identityCookie : Seen
  federationSession : Seen
  hostGrant : Bool
  orphanCookie : Bool
  owedRevocation : Bool
  deriving DecidableEq, Repr

def clear (o : Observation) : Bool :=
  o.identityCookie == .absent && o.federationSession == .absent &&
    !o.hostGrant && !o.orphanCookie && !o.owedRevocation

/-- The three checks, in order: before the mint, after it, inside the lock. -/
structure Admission where
  beforeMint : Observation
  afterMint : Observation
  inLock : Observation

def admitted (a : Admission) : Bool := clear a.beforeMint && clear a.afterMint && clear a.inLock

theorem admitted_only_if_every_check_clear (a : Admission) (h : admitted a = true) :
    clear a.beforeMint = true ∧ clear a.afterMint = true ∧ clear a.inLock = true := by
  simp only [admitted, Bool.and_eq_true] at h
  exact ⟨h.1.1, h.1.2, h.2⟩

theorem session_seen_anywhere_refuses (a : Admission) (o : Observation)
    (ho : o = a.beforeMint ∨ o = a.afterMint ∨ o = a.inLock)
    (hs : o.identityCookie ≠ .absent ∨ o.federationSession ≠ .absent ∨ o.hostGrant = true ∨
      o.orphanCookie = true ∨ o.owedRevocation = true) :
    admitted a = false := by
  rcases a with ⟨b, m, l⟩
  have hc : clear o = false := by
    rcases o with ⟨ic, fs, hg, oc, ow⟩
    rcases hs with h | h | h | h | h <;> simp_all [clear] <;> cases ic <;> simp_all
  rcases ho with rfl | rfl | rfl <;> simp [admitted, hc]

theorem unknown_status_refuses (a : Admission) (h : a.beforeMint.identityCookie = .unknown) :
    admitted a = false := by
  simp [admitted, clear, h]

/-! ## AUTH-C1: a local-only guest never sends a Host grant

`browser-pairing.ts` re-reads the guest context at every await boundary and
immediately before a request carries a grant; `currentBrowserGrant` reports no
grant while a local-only guest is open. A trace lists, per boundary, whether a
local-only guest is open there; the grant is sent only after every boundary up
to the send reads "not open". -/

/-- Boundaries reached; `true` means a local-only guest is open at that boundary. -/
abbrev PairingTrace := List Bool

def sendsGrant (t : PairingTrace) : Bool := t ≠ [] && t.all (· == false)

def currentGrant (localOnlyOpen : Bool) (stored : Option Nat) : Option Nat :=
  if localOnlyOpen then none else stored

private theorem all_false_of_mem_true : ∀ t : PairingTrace, true ∈ t →
    t.all (· == false) = false
  | [], h => nomatch h
  | b :: rest, h => by
    cases b with
    | true => rfl
    | false =>
      have hr : true ∈ rest := by
        cases h with
        | tail _ hr => exact hr
      show (false == false && rest.all (· == false)) = false
      rw [all_false_of_mem_true rest hr, Bool.and_false]

theorem local_only_guest_never_sends_grant (t : PairingTrace) (i : Nat)
    (hi : i < t.length) (h : t[i] = true) : sendsGrant t = false := by
  have hm : true ∈ t := h ▸ List.getElem_mem hi
  unfold sendsGrant
  rw [all_false_of_mem_true t hm, Bool.and_false]

theorem send_requires_last_boundary_clear (t : PairingTrace) (h : sendsGrant t = true) :
    t.getLast? = some false := by
  unfold sendsGrant at h
  simp only [Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true] at h
  obtain ⟨hne, hall⟩ := h
  cases hl : t.getLast? with
  | none => simp_all
  | some b =>
    have hm : b ∈ t := List.mem_of_getLast? hl
    have := hall b hm
    cases b <;> simp_all

theorem no_grant_reported_to_local_only_guest (stored : Option Nat) :
    currentGrant true stored = none := rfl

/-! ## AUTH-C1: sign-out epoch fence

An operation captures the shared sign-out generation (auth-generation.ts) when
it starts and may commit only if a fresh read still equals it; an unreadable
store (`none`) counts as a sign-out (`assertSignOutEpoch`). -/

def mayCommit (captured : Nat) (current : Option Nat) : Bool :=
  match current with
  | some g => g == captured
  | none => false

def signOut (g : Nat) : Nat := g + 1

theorem unreadable_generation_refuses (captured : Nat) : mayCommit captured none = false := rfl

theorem signout_during_operation_refuses (captured : Nat) :
    mayCommit captured (some (signOut captured)) = false := by
  unfold mayCommit signOut
  exact beq_false_of_ne (Nat.succ_ne_self captured)

theorem commit_requires_same_generation (captured : Nat) (current : Option Nat)
    (h : mayCommit captured current = true) : current = some captured := by
  cases current with
  | none => simp [mayCommit] at h
  | some g => simp [mayCommit] at h; simp [h]

/-! ## GUEST-V1: isolated guest tombs

`selectGuestScope` and `prepareGuestOpen` (store-guest-material.ts) open every
fresh guest in a new `guest_<uuid>` tomb under the exclusive guest lease; a
duress decoy runs in the scratch tomb. A store maps tombs to their contents. -/

inductive Tomb where
  | scratch
  | guest (id : Nat)
  deriving DecidableEq, Repr

structure Contents where
  header : Bool
  body : Nat
  deriving DecidableEq, Repr

abbrev Vaults := Tomb → Option Contents

def setTomb (v : Vaults) (t : Tomb) (c : Option Contents) : Vaults :=
  fun u => if u = t then c else v u

/-- Open a fresh guest under the lease: a tomb id not in use, written empty. -/
def openFreshGuest (v : Vaults) (fresh : Nat) : Vaults :=
  setTomb v (.guest fresh) (some ⟨false, 0⟩)

theorem fresh_guest_never_wipes_another (v : Vaults) (fresh : Nat)
    (t : Tomb) (ht : t ≠ .guest fresh) : openFreshGuest v fresh t = v t := by
  simp [openFreshGuest, setTomb, ht]

/-- Header publication refuses the scratch tomb (`publishOriginalHeader`). -/
def publishHeader (v : Vaults) (t : Tomb) : Vaults :=
  match t, v t with
  | .scratch, _ => v
  | .guest _, some c => setTomb v t (some { c with header := true })
  | .guest _, none => v

theorem scratch_never_gets_header (v : Vaults) (h : ∀ c, v .scratch = some c → c.header = false) :
    ∀ c, publishHeader v .scratch .scratch = some c → c.header = false := by
  simpa [publishHeader] using h

/-- Promotion of an unprotected guest (`promoteGuestVault`): reservation,
recovery manifest, body, and the header last. -/
inductive PromotionStep where
  | reserve
  | manifest
  | body
  | header
  deriving DecidableEq, Repr

def promotionPlan : List PromotionStep := [.reserve, .manifest, .body, .header]

theorem promotion_header_last : promotionPlan.getLast? = some .header := rfl

theorem interrupted_promotion_has_no_header (k : Nat) (hk : k < promotionPlan.length) :
    PromotionStep.header ∉ promotionPlan.take k := by
  simp [promotionPlan] at hk
  rcases k with _ | _ | _ | _ | k <;> simp_all [promotionPlan]
  omega

/-- Deletion of a protected guest (`deleteGuestFileInTurn`): journal, then unlink. -/
def deletionPlan : List String := ["journal", "unlink"]

theorem deletion_journals_before_unlink :
    deletionPlan.idxOf "journal" < deletionPlan.idxOf "unlink" := by decide

/-- A transient guest whose commit outcome is uncertain is frozen
(`freezeTransientGuest`): only recovery under the owner may act. -/
inductive GuestOp where
  | write
  | publish
  | recover
  deriving DecidableEq, Repr

def permitted (frozen : Bool) (op : GuestOp) : Bool := !frozen || op == .recover

theorem frozen_guest_only_recovers (op : GuestOp) (h : permitted true op = true) :
    op = .recover := by
  cases op <;> simp_all [permitted]

/-- The tab actor is a guest person only while that person's tomb is open. -/
def tabActor (openTomb : Option Tomb) (owner : Tomb → Option Nat) : Option Nat :=
  openTomb.bind owner

theorem actor_requires_own_open_tomb (openTomb : Option Tomb) (owner : Tomb → Option Nat)
    (p : Nat) (h : tabActor openTomb owner = some p) :
    ∃ t, openTomb = some t ∧ owner t = some p := by
  cases openTomb with
  | none => simp [tabActor] at h
  | some t => exact ⟨t, rfl, by simpa [tabActor] using h⟩

private def seenName : Seen → String
  | .absent => "absent"
  | .present => "present"
  | .unknown => "unknown"

def main : IO Unit := do
  for s in [Seen.absent, .present, .unknown] do
    for hostGrant in [false, true] do
      for owed in [false, true] do
        let o : Observation := ⟨s, .absent, hostGrant, false, owed⟩
        IO.println s!"admission\t{seenName s}\t{hostGrant}\t{owed}\t{clear o}"

end OpenSesame.GuestContract

def main : IO Unit := OpenSesame.GuestContract.main
