/-! Continues `GuestContract.lean`: verify.sh checks the two files as one
model (`cat GuestContract.lean CustodyContract.lean`) with one axiom audit and
one obligations file. CONN-S1, LOCAL-D1, EXT-O1 and the vector printer. -/

namespace OpenSesame.GuestContract

/-! ## CONN-S1 staged credentials (connector-directory.ts 173-265,
vercel-connect-session.ts 31-208). A session ends at a lock. Directory:
`stage`/`staged` start and finish a sync before any vault, `seal` queues the
write into the open vault. Vercel: `arm` stages a bearer, `hydrate` queues it or
reads the vault's sealed bearer. Writes complete later (`ok`, `fail`); a write
is (captured generation, staging session, vault session). -/
structure Dir where
  gen : Nat
  session : Nat
  vault : Option Nat
  pending : Option Nat
  live : Option Nat
  sync : Option (Nat × Nat)
  writes : List (Nat × Nat × Nat)
  sealed : List (Nat × Nat)

inductive DOp | stage | staged | arm | seal | hydrate | ok | fail | lock | unlock deriving DecidableEq, Repr

def queue (d : Dir) (s v : Nat) : Dir :=
  { d with gen := d.gen + 1, pending := none, writes := d.writes ++ [(d.gen + 1, s, v)] }

/-- `checked`: the directory's write re-checks the generation; Vercel's does not, but
arms the bearer only if the unlock that started it was not ended (`v = session`). -/
def dstep (checked : Bool) (d : Dir) : DOp → Dir
  | .stage => if d.sync.isSome then d else { d with gen := d.gen + 1, sync := some (d.gen + 1, d.session) }
  | .staged => match d.sync with
    | some (g, s) => { d with sync := none, pending := if g == d.gen then some s else d.pending }
    | none => d
  | .arm => { d with gen := d.gen + 1, pending := some d.session, live := some d.session }
  | .seal => match d.pending, d.vault with | some s, some v => queue d s v | _, _ => d
  | .hydrate => match d.pending, d.vault with
    | some s, some v => queue d s v
    | none, some v => { d with live := (d.sealed.find? (·.2 == v)).map (·.1) }
    | _, none => d
  | .ok => match d.writes with
    | (g, s, v) :: w =>
      let sealed := if !checked || g == d.gen then (s, v) :: d.sealed else d.sealed
      { d with writes := w, sealed, live := if !checked && v == d.session then some s else d.live }
    | [] => d
  | .fail => match d.writes with
    | (g, s, _) :: w =>
      let keep := g == d.gen && d.vault.isSome && d.pending.isNone
      { d with writes := w, pending := if keep then some s else d.pending }
    | [] => d
  | .lock => { d with gen := d.gen + 1, session := d.session + 1, vault := none, pending := none, live := none }
  | .unlock => if d.vault.isSome then d else { d with vault := some d.session }

def DInv (d : Dir) : Prop :=
  (∀ s, d.pending = some s → s = d.session) ∧ (∀ v, d.vault = some v → v = d.session) ∧
  (∀ s, d.live = some s → s = d.session) ∧
  (∀ g s, d.sync = some (g, s) → g ≤ d.gen ∧ (g = d.gen → s = d.session)) ∧
  (∀ w ∈ d.writes, w.2.1 = w.2.2 ∧ w.1 ≤ d.gen ∧ (w.1 = d.gen → w.2.2 = d.session)) ∧
  (∀ x ∈ d.sealed, x.1 = x.2)

theorem bump {g n : Nat} {P : Prop} (h : g ≤ n) : g ≤ n + 1 ∧ (g = n + 1 → P) :=
  ⟨Nat.le_succ_of_le h, fun e => absurd e (Nat.ne_of_lt (Nat.lt_succ_of_le h))⟩

theorem dstep_inv (c : Bool) (d : Dir) (op : DOp) (h : DInv d) : DInv (dstep c d op) := by
  obtain ⟨hp, hv, hl, hs, hw, hd⟩ := h
  have hw' : ∀ w ∈ d.writes, w.2.1 = w.2.2 ∧ (w.1 ≤ d.gen + 1 ∧ (w.1 = d.gen + 1 → w.2.2 = d.session + 1)) ∧
      (w.1 ≤ d.gen + 1 ∧ (w.1 = d.gen + 1 → w.2.2 = d.session)) :=
    fun w hm => ⟨(hw w hm).1, bump (hw w hm).2.1, bump (hw w hm).2.1⟩
  have hs' : ∀ g s, d.sync = some (g, s) → (g ≤ d.gen + 1 ∧ (g = d.gen + 1 → s = d.session + 1)) ∧
      (g ≤ d.gen + 1 ∧ (g = d.gen + 1 → s = d.session)) :=
    fun g s h' => ⟨bump (hs g s h').1, bump (hs g s h').1⟩
  have hq : ∀ s v, d.pending = some s → d.vault = some v → DInv (queue d s v) := by
    intro s v h1 h2
    refine ⟨by simp [queue], hv, hl, fun g s' h' => (hs' g s' h').2, ?_, hd⟩
    intro w hm; simp only [queue, List.mem_append, List.mem_singleton] at hm ⊢
    rcases hm with hm | rfl
    · exact ⟨(hw' w hm).1, (hw' w hm).2.2⟩
    · exact ⟨(hp s h1).trans (hv v h2).symm, Nat.le_refl _, fun _ => hv v h2⟩
  cases op
  · cases hc : d.sync.isSome
    · simp only [dstep, hc, Bool.false_eq_true, ↓reduceIte]
      refine ⟨hp, hv, hl, ?_, fun w hm => ⟨(hw' w hm).1, (hw' w hm).2.2⟩, hd⟩
      intro g s h'; simp only [Option.some.injEq, Prod.mk.injEq] at h'; obtain ⟨rfl, rfl⟩ := h'
      exact ⟨Nat.le_refl _, fun _ => rfl⟩
    · simp only [dstep, hc]; exact ⟨hp, hv, hl, hs, hw, hd⟩
  · cases hsy : d.sync with
    | none => simp only [dstep, hsy]; exact ⟨hp, hv, hl, hs, hw, hd⟩
    | some gs =>
      obtain ⟨g, s⟩ := gs; have := hs g s hsy; simp only [dstep, hsy]
      refine ⟨?_, hv, hl, fun _ _ h' => Option.noConfusion h', hw, hd⟩; intro x hx; dsimp only at hx ⊢
      split at hx
      · rename_i hg; rw [← Option.some.inj hx]; exact this.2 (beq_iff_eq.mp hg)
      · exact hp x hx
  · refine ⟨fun _ h' => (Option.some.inj h').symm, hv, fun _ h' => (Option.some.inj h').symm,
      fun g s h' => (hs' g s h').2, fun w hm => ⟨(hw' w hm).1, (hw' w hm).2.2⟩, hd⟩
  · cases h1 : d.pending <;> cases h2 : d.vault <;> simp only [dstep, h1, h2] <;>
      first | exact hq _ _ h1 h2 | exact ⟨hp, hv, hl, hs, hw, hd⟩
  · cases h1 : d.pending <;> cases h2 : d.vault <;> simp only [dstep, h1, h2] <;>
      first | exact hq _ _ h1 h2 | exact ⟨hp, hv, hl, hs, hw, hd⟩ | skip
    rename_i v
    refine ⟨fun _ h => Option.noConfusion h, fun v' h' => (Option.some.inj h') ▸ hv v h2, ?_, hs, hw, hd⟩
    intro x hx
    cases hf : d.sealed.find? (·.2 == v) with
    | none => rw [hf] at hx; exact Option.noConfusion hx
    | some y =>
      rw [hf] at hx; have hy := List.find?_some hf; have := hd y (List.mem_of_find?_eq_some hf)
      have hxy : y.1 = x := Option.some.inj hx
      show x = d.session; rw [← hxy, this, beq_iff_eq.mp hy]; exact hv v h2
  · cases he : d.writes with
    | nil => simp only [dstep, he]; exact ⟨hp, hv, hl, hs, hw, hd⟩
    | cons x w =>
      obtain ⟨g, s, v⟩ := x; rw [he] at hw; simp only [dstep, he]
      have hx := hw (g, s, v) List.mem_cons_self
      refine ⟨hp, hv, ?_, hs, fun x hx => hw x (List.mem_cons_of_mem _ hx), ?_⟩
      · intro y hy; dsimp only at hy; split at hy
        · rename_i hv'; rw [Bool.and_eq_true, beq_iff_eq] at hv'
          show y = d.session; rw [← Option.some.inj hy]; exact hx.1.trans hv'.2
        · exact hl y hy
      · dsimp only; split
        · intro y hy; rw [List.mem_cons] at hy; rcases hy with rfl | hy
          · exact hx.1
          · exact hd y hy
        · exact hd
  · cases he : d.writes with
    | nil => simp only [dstep, he]; exact ⟨hp, hv, hl, hs, hw, hd⟩
    | cons x w =>
      obtain ⟨g, s, v⟩ := x; rw [he] at hw; simp only [dstep, he]
      have hx := hw (g, s, v) List.mem_cons_self
      refine ⟨?_, hv, hl, hs, fun x hx => hw x (List.mem_cons_of_mem _ hx), hd⟩
      intro y hy; dsimp only at hy ⊢; split at hy
      · rename_i hg; simp only [Bool.and_eq_true, beq_iff_eq] at hg
        show y = d.session; rw [← Option.some.inj hy]; exact hx.1.trans (hx.2.2 hg.1.1)
      · exact hp y hy
  · refine ⟨fun _ h => Option.noConfusion h, fun _ h => Option.noConfusion h, fun _ h => Option.noConfusion h,
      fun g s h' => (hs' g s h').1, fun w hm => ⟨(hw' w hm).1, (hw' w hm).2.1⟩, hd⟩
  · cases hc : d.vault.isSome
    · simp only [dstep, hc]; exact ⟨hp, fun _ h' => (Option.some.inj h').symm, hl, hs, hw, hd⟩
    · simp only [dstep, hc]; exact ⟨hp, hv, hl, hs, hw, hd⟩

def dir0 : Dir := ⟨0, 0, none, none, none, none, [], []⟩

theorem foldl_inv (c : Bool) (d : Dir) (ops : List DOp) (h : DInv d) : DInv (ops.foldl (dstep c) d) := by
  induction ops generalizing d with
  | nil => exact h
  | cons op ops ih => exact ih _ (dstep_inv c d op h)

/-- From a fresh tab, every sealed credential (staging session, vault session) is
sealed into a vault opened in the session that staged it, and the armed bearer
always belongs to the current session. -/
theorem staged_credential_never_crosses_sessions (c : Bool) (ops : List DOp) :
    (∀ x ∈ (ops.foldl (dstep c) dir0).sealed, x.1 = x.2) ∧
    (∀ s, (ops.foldl (dstep c) dir0).live = some s → s = (ops.foldl (dstep c) dir0).session) := by
  have h := foldl_inv c dir0 ops (by refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> simp [dir0])
  exact ⟨h.2.2.2.2.2, h.2.2.1⟩

/-! ## LOCAL-D1 (local-directory.ts 97-122, 180-212): only a missing file reads
as empty; a commit writes only after a successful read. -/

inductive Stored | missing | valid | badJson | badShape | oversize | otherKey deriving DecidableEq, Repr

def readDir : Stored → Option Bool | .missing => some false | .valid => some true | _ => none

theorem undecryptable_directory_never_empty (s : Stored) (h : readDir s = some false) : s = .missing := by
  cases s <;> simp_all [readDir]

/-- `commitLocalDirectoryUnderLock` writes only after `readLocalDirectory` succeeds. -/
def commitWrites (s : Stored) : Bool := (readDir s).isSome

theorem refused_directory_never_rewritten (s : Stored) (h : commitWrites s = true) :
    s = .missing ∨ s = .valid := by cases s <;> simp_all [commitWrites, readDir]

/-! ## EXT-O1 (apps/browser-extension/runner/page-fns.ts): a page function reads
the document only in a window of the run's origin; `fill` writes and `submit`
presses only there, and `fill` writes only if the origin still matches after focus. -/

inductive Win | same | other | none deriving DecidableEq, Repr
inductive PageFn | waitFor | fill | presence | submit | layout | readDom | mask | unmask deriving DecidableEq, Repr

def pageReads (w : Win) : Bool := w == .same
def pageActs (f : PageFn) (w : Win) (moved : Bool) : Bool := w == .same && (f == .submit || (f == .fill && !moved))

theorem off_origin_page_untouched (f : PageFn) (w : Win) (m : Bool) (h : w ≠ .same) :
    pageReads w = false ∧ pageActs f w m = false := by cases w <;> simp_all [pageReads, pageActs]

theorem moved_origin_never_filled (w : Win) : pageActs .fill w true = false := by cases w <;> rfl

/-! ## Vectors -/

def b (x : Bool) : String := if x then "1" else "0"
def nm {α : Type} [Repr α] (x : α) : String := ((reprStr x).splitOn ".").getLast!
def obsAll : List Obs := Id.run do
  let mut r := []
  for s in [Sess.none, .own, .other] do
    for f in [false, true] do for h in [false, true] do for x in [false, true] do r := r ++ [⟨s, f, h, x⟩]
  return r
def obsName (o : Obs) : String := s!"{nm o.sess}{b o.fed}{b o.host}{b o.hidden}"
def bits : Nat → List (List Bool) | 0 => [[]] | n + 1 => (bits n).flatMap fun t => [false :: t, true :: t]
def opt (x : Option Nat) : String := (x.map toString).getD "-"
def tg (s : Option TG) : String := match s with | none => "-" | some g => opt g.value
def seqs {α : Type} (step : α → List (α × String)) (a : α) : Nat → List (List String × α)
  | 0 => [([], a)]
  | n + 1 => ([], a) :: (step a).flatMap fun (a', o) => (seqs step a' n).map fun (os, z) => (o :: os, z)
def dirOps (c : Bool) : List DOp :=
  if c then [.stage, .staged, .seal, .ok, .fail, .lock, .unlock] else [.arm, .hydrate, .ok, .fail, .lock, .unlock]
def enabled (d : Dir) : DOp → Bool
  | .stage => d.sync.isNone | .staged => d.sync.isSome | .seal | .hydrate => d.vault.isSome
  | .ok | .fail => !d.writes.isEmpty | .unlock => d.vault.isNone | _ => true
def dirShow (d : Dir) : String := s!"{opt d.pending}/{opt d.live}"

def main : IO Unit := do
  for r in [false, true] do for f in [Fresh.ok, .signOut, .unknown] do
    for c1 in obsAll do for c2 in obsAll do for c3 in obsAll do
      IO.println s!"admission\t{b r}\t{nm (f)}\t{obsName c1}\t{obsName c2}\t{obsName c3}\t{nm ((admit r f c1 c2 c3))}"
  for x in [Seen.absent, .present, .unknown] do for so in [false, true] do for y in [Seen.absent, .present, .unknown] do
    let (o, m, v) := connectFresh x so y
    IO.println s!"fresh\t{nm (x)}\t{b so}\t{nm (y)}\t{nm (o)}\t{b m}\t{b v}"
  for r in [false, true] do for s in bits (if r then 5 else 3) do
    IO.println s!"pairing\t{b r}\t{String.join (s.map b)}\t{sends (pairedPlan r) s}\t{b (completes (pairedPlan r) s)}"
  for s in [Store.gen 0, .gen 3, .refusing] do for m in [Mid.none, .signOut, .lostWrite, .refuse] do
    IO.println s!"epoch\t{nm (s)}\t{nm (m)}\t{b (epochHolds s m)}"
  let ops := [TOp.begin, .write, .freeze, .freezeForeign, .thaw, .block, .unblock, .blockForeign, .finish,
    .release, .releaseForeign, .discard, .releaseRetired]
  for o1 in ops do for o2 in ops do for o3 in ops do
    let (s1, r1) := tstep none 1 o1; let (s2, r2) := tstep s1 2 o2; let (s3, r3) := tstep s2 3 o3
    IO.println s!"transient\t{nm (o1)},{nm (o2)},{nm (o3)}\t{nm (r1)}:{tg s1},{nm (r2)}:{tg s2},{nm (r3)}:{tg s3}"
  for d in [false, true] do for k in [none, some 0, some 1, some 2, some 3] do
    IO.println s!"open\t{b d}\t{opt k}\t{guestScope d}\t{b (prepareOpen d k).1}\t{b (prepareOpen d k).2}"
  for sc in [false, true] do for f in [Fail.none, .beforePrepare, .afterPrepare, .inWrite, .afterWrite] do
    IO.println s!"publish\t{b sc}\t{nm (f)}\t{b (publish sc f).1}\t{b (publish sc f).2}"
  IO.println s!"promote\t-\t0\t{b (promote 2 none false)}"
  for k in List.range 6 do for c in [false, true] do
    IO.println s!"promote\t{k}\t{b c}\t{b (promote 2 (some k) c)}"
  for k in List.range 5 do IO.println s!"deletion\t{k}\t{",".intercalate (deletionPlan.take k)}"
  for c in [true, false] do
    let step (d : Dir) := ((dirOps c).filter (enabled d)).map fun op => (dstep c d op, nm op ++ ":" ++ dirShow (dstep c d op))
    for (os, d) in seqs step dir0 6 do
      let vaults := (List.range (d.session + 1)).map fun v => opt ((d.sealed.find? (·.2 == v)).map (·.1))
      IO.println s!"{if c then "directory" else "vercel"}\t{",".intercalate os}\t{"/".intercalate vaults}"
  for s in [Stored.missing, .valid, .badJson, .badShape, .oversize, .otherKey] do
    IO.println s!"local\t{nm (s)}\t{match readDir s with | none => "refused" | some e => b e}\t{b (commitWrites s)}"
  for f in [PageFn.waitFor, .fill, .presence, .submit, .layout, .readDom, .mask, .unmask] do
    for w in [Win.same, .other, .none] do for m in [false, true] do
      IO.println s!"page\t{nm (f)}\t{nm (w)}\t{b m}\t{b (pageReads w)}\t{b (pageActs f w m)}"

end OpenSesame.GuestContract

def main : IO Unit := OpenSesame.GuestContract.main
