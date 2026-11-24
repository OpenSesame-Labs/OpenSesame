/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.GuestContract

#require_theorem OpenSesame.GuestContract.admitted_only_if_every_check_clear :
    ∀ (r : Bool) (f : Fresh) (c1 c2 c3 : Obs) (_h : admit r f c1 c2 c3 = .ok),
    passes false c1 = true ∧ passes r c3 = true ∧ (r = true → f = .ok ∧ passes true c2 = true)

#require_theorem OpenSesame.GuestContract.session_seen_anywhere_refuses :
    ∀ (r : Bool) (f : Fresh) (c1 c2 c3 o : Obs) (_ho : o = c1 ∨ o = c3 ∨ (r = true ∧ o = c2))
    (_hs : o.sess = .other ∨ o.fed = true ∨ o.host = true ∨ o.hidden = true),
    admit r f c1 c2 c3 ≠ .ok

#require_theorem OpenSesame.GuestContract.unknown_status_refuses :
    ∀ (s : Bool) (a : Seen),
    (connectFresh .unknown s a).1 = .unknown ∧ (connectFresh .absent false .unknown).1 = .unknown

#require_theorem OpenSesame.GuestContract.fresh_adopts_only_clear :
    ∀ (b a : Seen) (s : Bool) (_h : (connectFresh b s a).1 = .ok), b = .absent ∧ s = false ∧ a = .absent

#require_theorem OpenSesame.GuestContract.minted_unadopted_is_revoked :
    ∀ (b a : Seen) (s : Bool) (_hm : (connectFresh b s a).2.1 = true) (_hn : (connectFresh b s a).1 ≠ .ok),
    (connectFresh b s a).2.2 = true

#require_theorem OpenSesame.GuestContract.local_only_guest_never_sends_grant :
    ∀ (p : List Step) (s : List Bool) (pre mid post : List Ev)
    (_h : walk p s = pre ++ .read true :: mid ++ .sent :: post), False

#require_theorem OpenSesame.GuestContract.send_requires_last_boundary_clear :
    ∀ (s : List Bool) (r : Bool) (_h : completes (pairedPlan r) s = true),
    ∀ e ∈ walk (pairedPlan r) s, e ≠ .read true

#require_theorem OpenSesame.GuestContract.no_grant_reported_to_local_only_guest :
    ∀ (stored : Option Nat), currentGrant true stored = none

#require_theorem OpenSesame.GuestContract.unreadable_generation_refuses :
    ∀ (c : Option Nat) (s : Store), mayCommit c none = false ∧ mayCommit none (readGen s) = false

#require_theorem OpenSesame.GuestContract.signout_during_operation_refuses :
    ∀ (s : Store), epochHolds s .signOut = false

#require_theorem OpenSesame.GuestContract.commit_requires_same_generation :
    ∀ (c g : Option Nat) (_h : mayCommit c g = true), ∃ n, c = some n ∧ g = some n

#require_theorem OpenSesame.GuestContract.fresh_guest_never_wipes_another :
    ∀ (g : TG) (i : Nat), tstep (some g) i .begin = (some g, .refused)

#require_theorem OpenSesame.GuestContract.blocked_or_retired_refuses_writes :
    ∀ (g : TG) (i : Nat) (_h : g.blocked = true ∨ g.retired = true), tstep (some g) i .write = (some g, .refused)

#require_theorem OpenSesame.GuestContract.foreign_owner_changes_nothing :
    ∀ (s : Option TG) (i : Nat) (op : TOp)
    (_h : op = .freezeForeign ∨ op = .blockForeign ∨ op = .releaseForeign), (tstep s i op).1 = s

#require_theorem OpenSesame.GuestContract.frozen_guest_only_recovers :
    ∀ (g g' : TG) (i : Nat) (op : TOp) (_hb : g.blocked = true)
    (_h : (tstep (some g) i op).1 = some g') (_hu : g'.blocked = false), op = .unblock

#require_theorem OpenSesame.GuestContract.failed_open_leaves_nothing :
    ∀ (d : Bool) (k : Nat) (_h : k < 3), prepareOpen d (some k) = (false, false)

#require_theorem OpenSesame.GuestContract.decoy_never_opens_a_guest_tomb :
    ∀ (k : Option Nat), (prepareOpen true k).2 = false

#require_theorem OpenSesame.GuestContract.scratch_never_gets_header :
    ∀ (f : Fail), (publish true f).1 = false

#require_theorem OpenSesame.GuestContract.promotion_header_last :
    ∀ (n : Nat), (promotionPlan n).dropLast.getLast? = some .header

#require_theorem OpenSesame.GuestContract.interrupted_promotion_has_no_header :
    ∀ (n k : Nat) (_hk : k ≤ n + 2), PromotionStep.header ∉ (promotionPlan n).take k

#require_theorem OpenSesame.GuestContract.promotion_header_only_when_complete :
    ∀ (n k : Nat) (c : Bool) (_h : promote n (some k) c = true), n + 2 ≤ k

#require_theorem OpenSesame.GuestContract.deletion_journals_before_unlink :
    deletionPlan.idxOf "journal" < deletionPlan.idxOf "unlink"

#require_theorem OpenSesame.GuestContract.staged_credential_never_crosses_sessions :
    ∀ (c : Bool) (ops : List DOp),
    (∀ x ∈ (ops.foldl (dstep c) dir0).sealed, x.1 = x.2) ∧
    (∀ s, (ops.foldl (dstep c) dir0).live = some s → s = (ops.foldl (dstep c) dir0).session)

#require_theorem OpenSesame.GuestContract.undecryptable_directory_never_empty :
    ∀ (s : Stored) (_h : readDir s = some false), s = .missing

#require_theorem OpenSesame.GuestContract.refused_directory_never_rewritten :
    ∀ (s : Stored) (_h : commitWrites s = true), s = .missing ∨ s = .valid

#require_theorem OpenSesame.GuestContract.off_origin_page_untouched :
    ∀ (f : PageFn) (w : Win) (m : Bool) (_h : w ≠ .same), pageReads w = false ∧ pageActs f w m = false

#require_theorem OpenSesame.GuestContract.moved_origin_never_filled :
    ∀ (w : Win), pageActs .fill w true = false
