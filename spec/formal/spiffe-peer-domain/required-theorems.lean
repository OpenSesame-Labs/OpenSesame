/- Independent propositions for the modeled SPIFFE peer policy. -/
open OpenSesame.SpiffePeerDomain

#require_theorem OpenSesame.SpiffePeerDomain.untrusted_chain_refused :
  ∀ (hasDomain matchesDomain validSvid : Bool), verified false hasDomain matchesDomain validSvid = false
#require_theorem OpenSesame.SpiffePeerDomain.missing_domain_refused :
  ∀ (chain matchesDomain validSvid : Bool), verified chain false matchesDomain validSvid = false
#require_theorem OpenSesame.SpiffePeerDomain.wrong_domain_refused :
  ∀ (chain hasDomain validSvid : Bool), verified chain hasDomain false validSvid = false
#require_theorem OpenSesame.SpiffePeerDomain.invalid_svid_refused :
  ∀ (chain hasDomain matchesDomain : Bool), verified chain hasDomain matchesDomain false = false
#require_theorem OpenSesame.SpiffePeerDomain.verified_requires_all :
  ∀ (chain hasDomain matchesDomain validSvid : Bool), verified chain hasDomain matchesDomain validSvid = true ↔
    chain = true ∧ hasDomain = true ∧ matchesDomain = true ∧ validSvid = true
#require_theorem OpenSesame.SpiffePeerDomain.dns_does_not_authorize :
  ∀ (sameId revoked : Bool), admit .dns sameId revoked = false
#require_theorem OpenSesame.SpiffePeerDomain.uri_does_not_authorize :
  ∀ (sameId revoked : Bool), admit .uri sameId revoked = false
#require_theorem OpenSesame.SpiffePeerDomain.thumbprint_does_not_authorize :
  ∀ (sameId revoked : Bool), admit .thumbprint sameId revoked = false
#require_theorem OpenSesame.SpiffePeerDomain.revoked_is_never_admitted :
  ∀ (selector : Selector) (sameId : Bool), admit selector sameId true = false
#require_theorem OpenSesame.SpiffePeerDomain.only_exact_id_is_admitted :
  ∀ (selector : Selector) (sameId revoked : Bool), admit selector sameId revoked = true →
    selector = .spiffe ∧ sameId = true ∧ revoked = false
#require_theorem OpenSesame.SpiffePeerDomain.exact_unrevoked_id_is_admitted :
  admit .spiffe true false = true
#require_theorem OpenSesame.SpiffePeerDomain.forwarding_keeps_ingress_selectors :
  ∀ (selectors : List Selector), forwardIngress selectors = selectors
