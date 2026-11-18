/- Independent contract for the source-only Host listener selector. -/
open OpenSesame.SourceTrustSelection

#require_theorem OpenSesame.SourceTrustSelection.stale_view_is_refused :
  ∀ (present spiffeKind matchingProfile matchingDomain : Bool), choose false present spiffeKind matchingProfile matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.missing_source_is_refused :
  ∀ (fresh spiffeKind matchingProfile matchingDomain : Bool), choose fresh false spiffeKind matchingProfile matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_kind_is_refused :
  ∀ (fresh present matchingProfile matchingDomain : Bool), choose fresh present false matchingProfile matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_profile_is_refused :
  ∀ (fresh present spiffeKind matchingDomain : Bool), choose fresh present spiffeKind false matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_domain_is_refused :
  ∀ (fresh present spiffeKind matchingProfile : Bool), choose fresh present spiffeKind matchingProfile false = false
#require_theorem OpenSesame.SourceTrustSelection.selection_requires_all :
  ∀ (fresh present spiffeKind matchingProfile matchingDomain : Bool),
    choose fresh present spiffeKind matchingProfile matchingDomain = true ↔
      fresh = true ∧ present = true ∧ spiffeKind = true ∧ matchingProfile = true ∧ matchingDomain = true
#require_theorem OpenSesame.SourceTrustSelection.complete_source_is_accepted :
  choose true true true true true = true
