import Lean

set_option autoImplicit false

namespace OpenSesame.SpiffePeerDomain

/-- Abstract chain, explicit-domain, and X.509-SVID profile decisions. -/
def verified (chain hasDomain matchesDomain validSvid : Bool) : Bool :=
  chain && hasDomain && matchesDomain && validSvid

inductive Selector where
  | spiffe | dns | uri | thumbprint
  deriving DecidableEq, Repr

/-- Only an exact SPIFFE ID can name a SPIFFE peer in a service binding. -/
def selectorMatches (selector : Selector) (sameId : Bool) : Bool :=
  match selector with
  | .spiffe => sameId
  | _ => false

/-- Revocation remains independent of whether the thumbprint may authorize. -/
def admit (selector : Selector) (sameId revoked : Bool) : Bool :=
  selectorMatches selector sameId && !revoked

/-- Forwarding keeps the original, sealed ingress identity policy. -/
def forwardIngress (selectors : List Selector) : List Selector := selectors

theorem untrusted_chain_refused (hasDomain matchesDomain validSvid : Bool) :
    verified false hasDomain matchesDomain validSvid = false := by simp [verified]

theorem missing_domain_refused (chain matchesDomain validSvid : Bool) :
    verified chain false matchesDomain validSvid = false := by simp [verified]

theorem wrong_domain_refused (chain hasDomain validSvid : Bool) :
    verified chain hasDomain false validSvid = false := by simp [verified]

theorem invalid_svid_refused (chain hasDomain matchesDomain : Bool) :
    verified chain hasDomain matchesDomain false = false := by simp [verified]

theorem verified_requires_all (chain hasDomain matchesDomain validSvid : Bool) :
    verified chain hasDomain matchesDomain validSvid = true ↔
      chain = true ∧ hasDomain = true ∧ matchesDomain = true ∧ validSvid = true := by
  simp [verified, and_assoc]

theorem dns_does_not_authorize (sameId revoked : Bool) :
    admit .dns sameId revoked = false := by simp [admit, selectorMatches]

theorem uri_does_not_authorize (sameId revoked : Bool) :
    admit .uri sameId revoked = false := by simp [admit, selectorMatches]

theorem thumbprint_does_not_authorize (sameId revoked : Bool) :
    admit .thumbprint sameId revoked = false := by simp [admit, selectorMatches]

theorem revoked_is_never_admitted (selector : Selector) (sameId : Bool) :
    admit selector sameId true = false := by simp [admit]

theorem only_exact_id_is_admitted (selector : Selector) (sameId revoked : Bool) :
    admit selector sameId revoked = true →
      selector = .spiffe ∧ sameId = true ∧ revoked = false := by
  cases selector <;> cases sameId <;> cases revoked <;> decide

theorem exact_unrevoked_id_is_admitted : admit .spiffe true false = true := by rfl

theorem forwarding_keeps_ingress_selectors (selectors : List Selector) :
    forwardIngress selectors = selectors := by rfl

private def bit (b : Bool) : String := if b then "1" else "0"
private def name : Selector → String
  | .spiffe => "spiffe"
  | .dns => "dns"
  | .uri => "uri"
  | .thumbprint => "thumbprint"

def main : IO Unit := do
  for selector in [Selector.spiffe, .dns, .uri, .thumbprint] do
    for sameId in [false, true] do
      for revoked in [false, true] do
        IO.println s!"binding\t{name selector}\t{bit sameId}\t{bit revoked}\t{bit (admit selector sameId revoked)}"

end OpenSesame.SpiffePeerDomain

def main : IO Unit := OpenSesame.SpiffePeerDomain.main
