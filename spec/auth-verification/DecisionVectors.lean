/- Appended to AuthAdmission.lean by verify.mjs. The same finite vectors are
   used to exercise the real TypeScript decisions; they are not a proof of
   TypeScript semantics or of code outside these tested partitions. -/

namespace AuthAdmission.Vectors

def bools : List Bool := [false, true]

def cookie : List Bool :=
  bools.flatMap fun safe =>
  bools.flatMap fun present =>
  bools.flatMap fun listed =>
  bools.map fun same =>
    CookieOrigin.decide safe (if present then some "caller" else none)
      (if listed then ["caller"] else [])
      (if same then some "caller" else some "service")

def session : List Bool :=
  bools.flatMap fun access =>
  bools.flatMap fun mapped =>
  bools.flatMap fun present =>
  [999, 1000, 1001].flatMap fun expiry =>
  bools.flatMap fun revoked =>
  [Session.Principal.absent, .provisional, .active, .suspended, .closed].map fun principal =>
    Session.decide ⟨access, mapped, present, 1000, expiry, revoked, principal⟩

def oidc : List Bool :=
  bools.flatMap fun spent =>
  bools.flatMap fun current =>
  bools.flatMap fun inTime =>
  bools.flatMap fun matching =>
  bools.flatMap fun error =>
  bools.flatMap fun hasCode =>
  bools.map fun bounded =>
    let tx : OidcResponse.Transaction := ⟨"expected", 1000, spent⟩
    let response : OidcResponse.Response :=
      ⟨if matching then "expected" else "other", if inTime then 999 else 1000,
        current, error, hasCode, bounded⟩
    (OidcResponse.complete tx response).2

def bits (values : List Bool) : String :=
  String.join (values.map fun value => if value then "1" else "0")

#eval bits cookie ++ "|" ++ bits session ++ "|" ++ bits oidc

end AuthAdmission.Vectors
