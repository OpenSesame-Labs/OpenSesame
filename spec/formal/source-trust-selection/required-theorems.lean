/- Independent contract for the source-only Host listener selector. -/
open OpenSesame.SourceTrustSelection

#require_theorem OpenSesame.SourceTrustSelection.stale_view_is_refused :
  ∀ (present spiffeKind matchingProfile : Bool), choose false present spiffeKind matchingProfile = false
#require_theorem OpenSesame.SourceTrustSelection.missing_source_is_refused :
  ∀ (fresh spiffeKind matchingProfile : Bool), choose fresh false spiffeKind matchingProfile = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_kind_is_refused :
  ∀ (fresh present matchingProfile : Bool), choose fresh present false matchingProfile = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_profile_is_refused :
  ∀ (fresh present spiffeKind : Bool), choose fresh present spiffeKind false = false
#require_theorem OpenSesame.SourceTrustSelection.selection_requires_all :
  ∀ (fresh present spiffeKind matchingProfile : Bool),
    choose fresh present spiffeKind matchingProfile = true ↔
      fresh = true ∧ present = true ∧ spiffeKind = true ∧ matchingProfile = true
#require_theorem OpenSesame.SourceTrustSelection.complete_source_is_accepted :
  choose true true true true = true
