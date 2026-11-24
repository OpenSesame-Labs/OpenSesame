import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaimCompletion } from "./claim-completion.mjs";
import { extractCookie } from "./cookie.mjs";
import { checkEvidence } from "./evidence.mjs";
import {
  checkFederatedPending,
  extractPendingDecode,
} from "./federated-pending.mjs";
import { checkFederatedTrust } from "./federated-trust.mjs";
import { checkIssuerTrust } from "./issuer-trust.mjs";
import { extractMapGraph, graphSpecs } from "./map-graphs.mjs";
import { extractOidc } from "./oidc.mjs";
import { checkPasskeyCustody } from "./passkey-custody.mjs";
import { extractPrincipal } from "./principal.mjs";
import { checkSamlReplay } from "./saml-replay.mjs";
import { extractTransitions } from "./transitions.mjs";
import { checkWebauthnPurpose } from "./webauthn-purpose.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const lean = process.env.LEAN_BIN ?? "lean";
const marker = "-- SOURCE_DEFINITIONS";
const names = [
  "SourceAuth.cookie_refines_policy",
  "SourceAuth.principal_refines_policy",
  "SourceAuth.principal_never_throws",
  "SourceAuth.oidc_exchange_refines_policy",
  "SourceAuth.oidc_guard_never_dereferences_missing_code",
  "SourceAuth.oidc_completion_consumes",
  "SourceAuth.oidc_replay_cannot_exchange",
  "SourceAuth.evidence_refines_policy",
  "SourceAuth.evidence_always_consumed",
  "SourceAuth.evidence_reentry_denied",
  "SourceAuth.transition_refines_policy",
  "SourceAuth.terminal_has_no_transition",
  "SourceAuth.no_transition_to_pending",
  "SourceAuth.device_graph_refines_policy",
  "SourceAuth.claim_graph_refines_policy",
  "SourceAuth.agent_graph_refines_policy",
  "SourceAuth.resource_graph_refines_policy",
  "SourceAuth.webauthn_guard_refines_policy",
  "SourceAuth.webauthn_registration_denied",
  "SourceAuth.webauthn_unknown_purpose_denied",
  "SourceAuth.webauthn_default_is_authentication",
  "SourceAuth.claim_completion_refines_policy",
  "SourceAuth.claim_completion_requires_review",
  "SourceAuth.claim_completion_requires_principal",
  "SourceAuth.saml_claim_refines_policy",
  "SourceAuth.saml_replay_denied",
  "SourceAuth.saml_expiry_denied",
  "SourceAuth.saml_capacity_denied",
  "SourceAuth.saml_accept_stores_key",
  "SourceAuth.saml_replay_after_accept",
  "SourceAuth.passkey_confirmation_refines_policy",
  "SourceAuth.passkey_replacement_denied",
  "SourceAuth.passkey_absent_denied",
  "SourceAuth.passkey_verifier_rejection_denied",
  "SourceAuth.passkey_zero_counter",
  "SourceAuth.passkey_positive_counter_advances",
  "SourceAuth.issuer_static_precedence",
  "SourceAuth.issuer_organization_precedence",
  "SourceAuth.issuer_byo_requires_active",
  "SourceAuth.issuer_organization_requires_admission",
  "SourceAuth.issuer_no_match_denied",
  "SourceAuth.issuer_blank_denied",
  "SourceAuth.pending_admission_refines_policy",
  "SourceAuth.pending_noncanonical_denied",
  "SourceAuth.pending_legacy_provider_required",
  "SourceAuth.pending_legacy_known_fields_required",
  "SourceAuth.pending_modern_signature_admitted",
  "SourceAuth.pending_no_signature_denied",
  "SourceAuth.trust_binding_refines_policy",
  "SourceAuth.trust_source_rebound_denied",
  "SourceAuth.trust_record_replacement_denied",
  "SourceAuth.trust_legacy_dynamic_denied",
  "SourceAuth.trust_oauth2_pending_denied",
  "SourceAuth.trust_ambiguous_provenance_denied",
  "SourceAuth.trust_non_oidc_authority_denied",
  "SourceAuth.pending_decode_refines_policy",
  "SourceAuth.pending_decode_mac_first",
  "SourceAuth.pending_decode_bad_tag_no_work",
  "SourceAuth.pending_decode_accept_requires_tag",
  "SourceAuth.pending_decode_no_slow_hash",
];
const allowedAxioms = new Set(["propext", "Quot.sound"]);

export function renderProof({
  cookie,
  oidc,
  evidence,
  webauthn,
  saml,
  passkey,
  issuerTrust,
  federatedPending,
  federatedTrustBinding,
  federated,
  graphs,
  machine,
  types,
  contract,
  audit,
}) {
  if (contract.split(marker).length !== 2)
    throw new Error("Expected exactly one source marker");
  const decision = extractCookie(cookie);
  const principal = extractPrincipal(cookie);
  const responseGuard = extractOidc(oidc);
  checkEvidence(evidence);
  checkWebauthnPurpose(webauthn);
  checkSamlReplay(saml);
  checkPasskeyCustody(passkey);
  checkIssuerTrust(issuerTrust);
  const pendingDecode = extractPendingDecode(federatedPending);
  checkFederatedPending(federatedPending);
  checkFederatedTrust(federatedTrustBinding, federated);
  checkClaimCompletion(graphs.claim);
  const transitions = extractTransitions(machine, types);
  const mapGraphs = graphSpecs.flatMap((spec) => [
    `def extracted${spec.name} (source target : ${spec.name}) : Bool :=`,
    "  match source, target with",
    extractMapGraph(graphs[spec.key], types, spec),
    "",
  ]);
  const generated = [
    "def extractedCookie (safe present listed : Bool) (sameOrigin : Option Bool) : Bool :=",
    `  ${decision}`,
    "",
    "def extractedPrincipal (isNull isUndefined suspended closed withdrawalPending : Bool) : Option Bool :=",
    `  ${principal}`,
    "",
    "def extractedOidcGuard (expired mismatch errorFlag : Bool) (code : CodeKind) : Option Bool :=",
    `  ${responseGuard}`,
    "",
    "def extractedOidc (spent owner expired mismatch errorFlag : Bool) (code : CodeKind) : Bool × Option Bool :=",
    "  if spent then (true, some false)",
    "  else if !owner then (true, some false)",
    "  else (true, match extractedOidcGuard expired mismatch errorFlag code with",
    "    | none => none | some true => some false | some false => some true)",
    "",
    "def extractedEvidence (present owner expired : Bool) : Bool × Bool :=",
    "  if !present then (false, false)",
    "  else if !owner then (false, false)",
    "  else if expired then (false, false) else (false, true)",
    "",
    "def extractedWebAuthn (present : Bool) (requested : Option WebPurpose) (issued : WebPurpose) (principalOk : Bool) : Bool :=",
    "  match webExpected requested with",
    "  | .authentication | .transaction => present && (issued == webExpected requested) && principalOk",
    "  | _ => false",
    "",
    "def extractedClaimCompletion (live reviewed principalPresent : Bool) : Bool :=",
    "  live && reviewed && principalPresent",
    "",
    "def extractedSaml (live seen full : Bool) : Bool × Bool :=",
    "  let admitted := live && !seen && !full",
    "  (admitted, admitted || seen)",
    "",
    "def extractedPasskeyConfirmation (present verified sameGeneration counterAllowed : Bool) : Bool :=",
    "  present && verified && sameGeneration && counterAllowed",
    "",
    "def extractedPasskeyCounter (previous : Nat) (next : Option Nat) : Bool :=",
    "  match next with",
    "  | none => true",
    "  | some 0 => previous == 0",
    "  | some n => decide (previous < n)",
    "",
    "def extractedIssuerResolution (nonempty staticTrusted orgEligible byoActive : Bool) : TrustChoice :=",
    "  if !nonempty then .untrusted else if staticTrusted then .static",
    "  else if orgEligible then .org else if byoActive then .byo else .untrusted",
    "",
    "def extractedPendingAdmission (canonical modernValid legacyValid providerPresent knownFieldsOnly : Bool) : Bool :=",
    "  canonical && (modernValid || (legacyValid && providerPresent && knownFieldsOnly))",
    "",
    "def extractedFederatedTrust (pendingOidc currentOidc single hasProvenance sameSource sameId currentStatic : Bool) : Bool :=",
    "  pendingOidc && currentOidc && single &&",
    "    (if hasProvenance then sameSource && sameId else currentStatic)",
    "",
    "def extractedPendingDecode : List PendingInstr :=",
    `  ${pendingDecode}`,
    "",
    "def extractedTransition (source target : Status) : Bool :=",
    "  match source, target with",
    transitions,
    "",
    ...mapGraphs,
  ].join("\n");
  if (!audit?.trim())
    throw new Error("The independent source-proof audit is missing");
  return `${contract.replace(marker, generated)}\n${audit}`;
}

async function leanRun(args, input) {
  const child = spawn(lean, args, {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const status = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", done);
  });
  if (status !== 0)
    throw new Error(`Lean rejected source proof:\n${stdout}${stderr}`);
  return stdout.trim();
}

export async function verifyProof(source) {
  const version = await leanRun(["--short-version"]);
  if (version !== "4.24.0")
    throw new Error(`Expected Lean 4.24.0, got ${version}`);
  const report = await leanRun(["-E", "warning", "--stdin"], source);
  const remaining = new Set(names);
  for (const line of report.split("\n")) {
    const match = line.match(
      /^'([^']+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$/,
    );
    if (!match || !remaining.delete(match[1]))
      throw new Error(`Unexpected Lean audit output: ${line}`);
    const axioms = match[2] ? match[2].split(", ").filter(Boolean) : [];
    if (axioms.some((axiom) => !allowedAxioms.has(axiom)))
      throw new Error(`${match[1]} relies on an unreviewed axiom`);
  }
  if (remaining.size)
    throw new Error(`Missing theorem audit: ${[...remaining].join(", ")}`);
}

export async function readSources() {
  const [
    cookie,
    oidc,
    evidence,
    webauthn,
    saml,
    passkey,
    issuerTrust,
    federatedPending,
    federatedTrustBinding,
    federated,
    machine,
    types,
    contract,
    audit,
    graphs,
  ] = await Promise.all([
    readFile(
      join(root, "packages/control-plane/src/middleware/auth.ts"),
      "utf8",
    ),
    readFile(
      join(root, "packages/app-core/src/browser/oidc/transaction.ts"),
      "utf8",
    ),
    readFile(
      join(root, "packages/app-core/src/browser/oidc/claims.ts"),
      "utf8",
    ),
    readFile(join(root, "packages/auth-upstream/src/webauthn.ts"), "utf8"),
    readFile(
      join(root, "packages/app-core/src/browser/saml/assertion-replay.ts"),
      "utf8",
    ),
    readFile(join(root, "packages/auth-upstream/src/passkey.ts"), "utf8"),
    readFile(
      join(root, "packages/control-plane/src/interactions/trust.ts"),
      "utf8",
    ),
    readFile(
      join(
        root,
        "packages/control-plane/src/interactions/federated-pending.ts",
      ),
      "utf8",
    ),
    readFile(
      join(
        root,
        "packages/control-plane/src/interactions/federated-trust-binding.ts",
      ),
      "utf8",
    ),
    readFile(
      join(root, "packages/control-plane/src/interactions/federated.ts"),
      "utf8",
    ),
    readFile(
      join(root, "packages/os-domain/src/machines/authorization-request.ts"),
      "utf8",
    ),
    readFile(join(root, "packages/os-domain/src/types.ts"), "utf8"),
    readFile(join(directory, "Contracts.lean"), "utf8"),
    readFile(join(directory, "Audit.lean"), "utf8"),
    Promise.all(
      graphSpecs.map(async (spec) => [
        spec.key,
        await readFile(
          join(root, "packages/os-domain/src/machines", spec.file),
          "utf8",
        ),
      ]),
    ).then(Object.fromEntries),
  ]);
  return {
    cookie,
    oidc,
    evidence,
    webauthn,
    saml,
    passkey,
    issuerTrust,
    federatedPending,
    federatedTrustBinding,
    federated,
    machine,
    types,
    contract,
    audit,
    graphs,
  };
}

async function main() {
  await verifyProof(renderProof(await readSources()));
  console.log(
    "Lean checked 59 source-derived authentication theorems and their axioms",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
