#!/usr/bin/env python3
"""Confirm the OAuth conformance suite rejects guard removals in scratch copies."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
pending_source = root / "packages/control-plane/src/interactions/federated-pending.ts"
trust_source = root / "packages/control-plane/src/interactions/federated-trust-binding.ts"
lean = os.environ.get("OPENSESAME_LEAN_BIN", "lean")
base_env = os.environ.copy()
base_env.pop("OPENSESAME_OAUTH_MUTANT", None)
base_env.pop("OPENSESAME_OAUTH_TRUST_MUTANT", None)
subprocess.run(["bash", "spec/formal/oauth/verify.sh"], cwd=root, env=base_env, check=True)

mutations = {
    "payload not authenticated": (
        pending_source, "OPENSESAME_OAUTH_MUTANT",
        '${payload}\\0${legacyInput}',
        '${""}\\0${legacyInput}',
    ),
    "legacy provenance allowed": (
        pending_source, "OPENSESAME_OAUTH_MUTANT", "legacyEligible &&", "true &&",
    ),
    "legacy provider absence allowed": (
        pending_source, "OPENSESAME_OAUTH_MUTANT", "legacyProviderPresent &&", "true &&",
    ),
    "legacy MAC not checked": (
        pending_source, "OPENSESAME_OAUTH_MUTANT",
        "signatureMatches(supplied, pendingSignature(legacyInput, secret))", "true",
    ),
    "organization owner not checked": (
        trust_source, "OPENSESAME_OAUTH_TRUST_MUTANT",
        "trust.organizationId === pending.orgId", "true",
    ),
}
(root / "work").mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="oauth-negative-", dir=root / "work") as scratch:
    directory = Path(scratch)
    vectors = directory / "vectors.tsv"
    with vectors.open("w") as output:
        subprocess.run([lean, "-DwarningAsError=true", "--run", "PendingIntegrity.lean"],
                       cwd=root / "spec/formal/oauth", env=base_env, stdout=output, check=True)
    for name, (source, variable, before, after) in mutations.items():
        original = source.read_text()
        if original.count(before) != 1:
            raise SystemExit(f"{name}: mutation target not unique")
        mutant = directory / source.name
        mutant.write_text(original.replace(before, after, 1))
        env = base_env | {variable: str(mutant),
                          "OPENSESAME_OAUTH_FORMAL_VECTORS": str(vectors)}
        result = subprocess.run([str(root / "node_modules/.bin/vitest"), "run", "--config",
                                 "spec/formal/oauth/vitest.config.ts", "--maxWorkers=2"],
                                cwd=root, env=env, text=True, capture_output=True)
        if result.returncode == 0 or "AssertionError" not in result.stdout + result.stderr:
            raise SystemExit(f"{name}: expected a failing security assertion, got {result.returncode}")
        print(f"{name}: detected")
    for variable in ("OPENSESAME_OAUTH_MUTANT", "OPENSESAME_OAUTH_TRUST_MUTANT"):
        rejected = subprocess.run(["bash", "spec/formal/oauth/verify.sh"], cwd=root,
                                  env=base_env | {variable: str(mutant)},
                                  text=True, capture_output=True)
        if rejected.returncode == 0 or "mutant overrides are not allowed" not in rejected.stderr:
            raise SystemExit("normal OAuth gate accepted a mutant override")
    print("normal gate rejected mutant override")
subprocess.run(["bash", "spec/formal/oauth/verify.sh"], cwd=root, env=base_env, check=True)
