/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.GuestContract

#require_theorem OpenSesame.GuestContract.admitted_only_if_every_check_clear :
    ∀ (a : Admission) (_h : admitted a = true),
    clear a.beforeMint = true ∧ clear a.afterMint = true ∧ clear a.inLock = true

#require_theorem OpenSesame.GuestContract.session_seen_anywhere_refuses :
    ∀ (a : Admission) (o : Observation)
    (_ho : o = a.beforeMint ∨ o = a.afterMint ∨ o = a.inLock)
    (_hs : o.identityCookie ≠ .absent ∨ o.federationSession ≠ .absent ∨ o.hostGrant = true ∨
      o.orphanCookie = true ∨ o.owedRevocation = true),
    admitted a = false

#require_theorem OpenSesame.GuestContract.unknown_status_refuses :
    ∀ (a : Admission) (_h : a.beforeMint.identityCookie = .unknown), admitted a = false

#require_theorem OpenSesame.GuestContract.local_only_guest_never_sends_grant :
    ∀ (t : PairingTrace) (i : Nat) (hi : i < t.length) (_h : t[i] = true),
    sendsGrant t = false

#require_theorem OpenSesame.GuestContract.send_requires_last_boundary_clear :
    ∀ (t : PairingTrace) (_h : sendsGrant t = true), t.getLast? = some false

#require_theorem OpenSesame.GuestContract.no_grant_reported_to_local_only_guest :
    ∀ (stored : Option Nat), currentGrant true stored = none

#require_theorem OpenSesame.GuestContract.unreadable_generation_refuses :
    ∀ (captured : Nat), mayCommit captured none = false

#require_theorem OpenSesame.GuestContract.signout_during_operation_refuses :
    ∀ (captured : Nat), mayCommit captured (some (signOut captured)) = false

#require_theorem OpenSesame.GuestContract.commit_requires_same_generation :
    ∀ (captured : Nat) (current : Option Nat) (_h : mayCommit captured current = true),
    current = some captured

#require_theorem OpenSesame.GuestContract.fresh_guest_never_wipes_another :
    ∀ (v : Vaults) (fresh : Nat) (t : Tomb) (_ht : t ≠ .guest fresh),
    openFreshGuest v fresh t = v t

#require_theorem OpenSesame.GuestContract.scratch_never_gets_header :
    ∀ (v : Vaults) (_h : ∀ c, v .scratch = some c → c.header = false),
    ∀ c, publishHeader v .scratch .scratch = some c → c.header = false

#require_theorem OpenSesame.GuestContract.promotion_header_last :
    promotionPlan.getLast? = some .header

#require_theorem OpenSesame.GuestContract.interrupted_promotion_has_no_header :
    ∀ (k : Nat) (_hk : k < promotionPlan.length), PromotionStep.header ∉ promotionPlan.take k

#require_theorem OpenSesame.GuestContract.deletion_journals_before_unlink :
    deletionPlan.idxOf "journal" < deletionPlan.idxOf "unlink"

#require_theorem OpenSesame.GuestContract.frozen_guest_only_recovers :
    ∀ (op : GuestOp) (_h : permitted true op = true), op = .recover

#require_theorem OpenSesame.GuestContract.actor_requires_own_open_tomb :
    ∀ (openTomb : Option Tomb) (owner : Tomb → Option Nat) (p : Nat)
    (_h : tabActor openTomb owner = some p),
    ∃ t, openTomb = some t ∧ owner t = some p
