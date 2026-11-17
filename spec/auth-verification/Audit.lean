/- Appended after the proof. These independently restate the theorem types so
   that weakening a named theorem does not satisfy the axiom audit. -/
namespace AuthAdmission.Audit

example (safe : Bool) (origin : Option String) (allowed : List String)
    (sameOrigin : Option String) :
    CookieOrigin.decide safe origin allowed sameOrigin = true ↔
      CookieOrigin.policy safe origin allowed sameOrigin :=
  CookieOrigin.decision_refines_policy safe origin allowed sameOrigin

example (allowed : List String) (sameOrigin : Option String) :
    CookieOrigin.decide false none allowed sameOrigin = false :=
  CookieOrigin.unsafe_missing_origin_denied allowed sameOrigin

example (allowed : List String) (sameOrigin : Option String) :
    CookieOrigin.decide false (some "") allowed sameOrigin = false :=
  CookieOrigin.unsafe_empty_origin_denied allowed sameOrigin

example (value : String) (allowed : List String) (sameOrigin : Option String)
    (notListed : value ∉ allowed) (notSame : sameOrigin ≠ some value) :
    CookieOrigin.decide false (some value) allowed sameOrigin = false :=
  CookieOrigin.unsafe_untrusted_origin_denied value allowed sameOrigin notListed notSame

example (facts : Session.Facts) : Session.decide facts = true ↔ Session.policy facts :=
  Session.decision_refines_policy facts

example (facts : Session.Facts) (expired : facts.expiresAt ≤ facts.now) :
    Session.decide facts = false := Session.expired_denied facts expired

example (facts : Session.Facts) (revoked : facts.revoked = true) :
    Session.decide facts = false := Session.revoked_denied facts revoked

example (facts : Session.Facts) (suspended : facts.principal = .suspended) :
    Session.decide facts = false := Session.suspended_denied facts suspended

example (tx : OidcResponse.Transaction) (response : OidcResponse.Response) :
    (OidcResponse.complete tx response).2 = true ↔ OidcResponse.policy tx response :=
  OidcResponse.complete_refines_policy tx response

example (tx : OidcResponse.Transaction) (response : OidcResponse.Response) :
    (OidcResponse.complete tx response).1.spent = true :=
  OidcResponse.complete_consumes tx response

example (tx : OidcResponse.Transaction) (first second : OidcResponse.Response) :
    (OidcResponse.complete (OidcResponse.complete tx first).1 second).2 = false :=
  OidcResponse.replay_never_exchanges tx first second

example (tx : OidcResponse.Transaction) (response : OidcResponse.Response)
    (mismatch : response.state ≠ tx.expectedState) :
    (OidcResponse.complete tx response).2 = false :=
  OidcResponse.mismatched_state_never_exchanges tx response mismatch

end AuthAdmission.Audit
