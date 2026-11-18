import Lean

set_option autoImplicit false

namespace OpenSesame.SourceTrustSelection

/-- A source-selected listener admits its requested bundle only when the
    generation-bound source view exists and the bundle is present, carries the
    required kind, and is internally labeled with the requested profile. -/
def choose (fresh present spiffeKind matchingProfile : Bool) : Bool :=
  fresh && present && spiffeKind && matchingProfile

theorem stale_view_is_refused (present spiffeKind matchingProfile : Bool) :
    choose false present spiffeKind matchingProfile = false := by
  simp [choose]

theorem missing_source_is_refused (fresh spiffeKind matchingProfile : Bool) :
    choose fresh false spiffeKind matchingProfile = false := by
  simp [choose]

theorem wrong_kind_is_refused (fresh present matchingProfile : Bool) :
    choose fresh present false matchingProfile = false := by
  simp [choose]

theorem wrong_profile_is_refused (fresh present spiffeKind : Bool) :
    choose fresh present spiffeKind false = false := by
  simp [choose]

theorem selection_requires_all (fresh present spiffeKind matchingProfile : Bool) :
    choose fresh present spiffeKind matchingProfile = true ↔
      fresh = true ∧ present = true ∧ spiffeKind = true ∧ matchingProfile = true := by
  simp [choose, and_assoc]

theorem complete_source_is_accepted : choose true true true true = true := by
  rfl

private def bit (value : Bool) : String := if value then "1" else "0"

def main : IO Unit := do
  for fresh in [false, true] do
    for present in [false, true] do
      for spiffeKind in [false, true] do
        for matchingProfile in [false, true] do
          IO.println s!"source\t{bit fresh}\t{bit present}\t{bit spiffeKind}\t{bit matchingProfile}\t{bit (choose fresh present spiffeKind matchingProfile)}"

end OpenSesame.SourceTrustSelection

def main : IO Unit := OpenSesame.SourceTrustSelection.main
