#!/usr/bin/env python3
"""Run authentication guard mutations using isolated source copies."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
AUTH = ROOT / "spec/formal/auth"
RUNNER = ROOT / "scripts/test/auth-formal.sh"
SOURCES = (
    "packages/control-plane/src/lib/ids.ts",
    "packages/control-plane/src/middleware/auth.ts",
    "packages/control-plane/src/proofs/verified-principal.ts",
    "packages/control-plane/src/proofs/project-role.ts",
    "packages/control-plane/src/services/project-access.ts",
    "packages/os-domain/src/json.ts",
    "spec/formal/auth/auth-conformance.test.ts",
    # Runtime imports of auth.ts; they are copied so the scratch suite loads.
    "packages/control-plane/src/middleware/bound-cookie.ts",
    "packages/control-plane/src/middleware/bound-cookie-name.ts",
    # AUTH-S1 storage, AUTH-S2 middleware and IDENTITY-TLS1 (session-conformance).
    "packages/control-plane/src/repos/durable-map.ts",
    "packages/control-plane/src/repos/durable-map-legacy.ts",
    "packages/control-plane/src/transport/request-evidence.ts",
    "packages/control-plane/src/transport/listener.ts",
    "spec/formal/auth/session-conformance.test.ts",
    "packages/control-plane/src/repos/durable-record.ts",
    "packages/control-plane/src/deployment-mode.ts",
    "packages/control-plane/src/__tests__/free-port.ts",
    *(f"packages/control-plane/src/transport/{name}.ts" for name in (
        "config", "ingress", "ingress-evidence-adapter", "peer-evidence",
        "service-admission", "__tests__/pki", "__tests__/server-helpers")),
    "packages/app-core/src/lib/session-exit.ts",
    "spec/auth-verification/source/ast.mjs",
)
EXIT = "packages/app-core/src/lib/session-exit.ts"
DURABLE, EVIDENCE, LISTENER = SOURCES[9], SOURCES[11], SOURCES[12]
MUTATIONS = (
    ("session-prefix", "session", SOURCES[1],
     'if (!token.startsWith("pst_")) return undefined;',
     'if (false && !token.startsWith("pst_")) return undefined;'),
    ("session-mapping", "session", SOURCES[1],
     'if (!sessionId) return undefined;', 'if (false && !sessionId) return undefined;'),
    ("session-expiry", "session", SOURCES[1],
     'session.expiresAt <= ctx.clock()', 'session.expiresAt < ctx.clock()'),
    ("session-revocation", "session", SOURCES[1],
     '    session.revokedAt ||\n', '    false ||\n'),
    # Guards outside the Lean model; the correspondence test checks they narrow it.
    ("session-cleanup-pending", "session", SOURCES[1],
     '    session.revocationCleanupPending\n', '    false\n'),
    ("session-pending-withdrawal", "session", SOURCES[1],
     '!(await ctx.stores.organizationMemberships.hasPendingWithdrawalForPrincipal(',
     '!(false && await ctx.stores.organizationMemberships.hasPendingWithdrawalForPrincipal('),
    ("session-suspension", "session", SOURCES[1],
     'principal.state !== "suspended" &&\n    principal.state !== "closed"',
     'true &&\n    principal.state !== "closed"'),
    ("session-closure", "session", SOURCES[1],
     'principal.state !== "suspended" &&\n    principal.state !== "closed"',
     'principal.state !== "suspended" &&\n    true'),
    ("principal-provisional", "principal", SOURCES[2],
     'if (principal.assurance === "provisional") {',
     'if (false && principal.assurance === "provisional") {'),
    ("role-proof", "project", SOURCES[3],
     'if (role === "member") return', 'if (role === "admin") return'),
    ("project-state", "project", SOURCES[4],
     'if (!VISIBLE_PROJECT_STATES.has(project.state)) return false;',
     'if (false && !VISIBLE_PROJECT_STATES.has(project.state)) return false;'),
    ("expiry-boundary", "project", SOURCES[4],
     'project.expiresAt <= now', 'project.expiresAt < now'),
    # AUTH-S2 middleware (Lean `middleware`).
    ("bound-fallback", "bound", SOURCES[1],
     'if (bound !== "none") {', 'if (bound !== "none" && bound !== "invalid") {'),
    ("bound-proof", "bound", SOURCES[1],
     '    !(await boundCookieMatches(ctx, boundId, proof))\n', '    false\n'),
    ("bound-principal", "bound", SOURCES[1],
     'resolved.principalId !== expected ||', 'false ||'),
    ("require-bearer", "credential", SOURCES[1],
     'if (c.req.header("x-opensesame-require-bearer") === "1")', 'if (false)'),
    ("principal-bearer", "credential", SOURCES[1],
     'if (await principalStillAuthenticates(ctx, token)) {', 'if (true) {'),
    ("cookie-origin", "credential", SOURCES[1],
     'cookieVal &&\n      cookieAuthAllowed(ctx, c.req.method, c.req.header("origin"))',
     'cookieVal &&\n      true'),
    # AUTH-S1 storage refinement (Lean `Storage`).
    ("storage-live-read", "storage", DURABLE,
     '.where(and(this.condition(key), this.live()))\n      .limit(1);',
     '.where(this.condition(key))\n      .limit(1);'),
    ("storage-adopt-live", "storage", DURABLE, 'if (!current) {', 'if (true) {'),
    ("storage-adopt-expiry", "storage", DURABLE,
     'await this.upsert(overlapCast(tx), sealed, legacy.expiresAt);',
     'await this.upsert(overlapCast(tx), sealed, null);'),
    ("storage-claim", "storage", DURABLE,
     'if (existing && onlyIfAbsent) return false;', 'if (false) return false;'),
    ("storage-purge", "storage", DURABLE,
     'lte(oidcPayloads.expiresAt, new Date()),', 'lte(oidcPayloads.expiresAt, new Date(0)),'),
    ("storage-take-live", "storage", DURABLE,
     '.where(and(this.condition(key), this.live()))\n        .returning();',
     '.where(this.condition(key))\n        .returning();'),
    ("storage-legacy-live", "storage", DURABLE,
     '.where(and(eq(oidcPayloads.model, this.model), this.live()))\n      .limit(10_001);',
     '.where(eq(oidcPayloads.model, this.model))\n      .limit(10_001);'),
    # IDENTITY-TLS1 (Lean `Transport`).
    ("evidence-current", "evidence", EVIDENCE,
     'if (!current() || (input.peer && !input.peer.usableAt(now))) {',
     'if (input.peer && !input.peer.usableAt(now)) {'),
    ("evidence-ingress", "evidence", EVIDENCE,
     'input.provenance.policy === "trusted_ingress" &&\n        !input.originating',
     'input.provenance.policy === "never" &&\n        !input.originating'),
    ("binding-peer-ingress", "evidence", EVIDENCE,
     'record.provenance.policy === "trusted_ingress"\n  ) {',
     'record.provenance.policy === "never"\n  ) {'),
    ("listener-generation", "listener", LISTENER,
     '    state.trustGeneration += 1;\n', ''),
    ("listener-registry", "listener", LISTENER,
     'peer.trustGeneration() === state.trustGeneration &&', 'true &&'),
    ("listener-request-current", "listener", LISTENER,
     'isCurrent: () => state.trustGeneration === trustGeneration,', 'isCurrent: () => true,'),
    # Sign-out step runner (Lean `SignOut`), checked against the source shape.
    ("signout-catch", "signout", EXIT,
     '    } catch {\n      incomplete = true;\n    }', '    } finally {\n      incomplete = true;\n    }'),
    ("signout-end-session", "signout", EXIT, '  step(() => endSession({ signOut: true }));\n', ''),
    ("signout-unwrapped", "signout", EXIT, '  step(clearFederationSession);', '  clearFederationSession();'),
    ("signout-lock-guard", "signout", EXIT,
     'if (vaultStore.isUnlocked() || vaultStore.getSnapshot().awaitingSecondStep) {',
     'if (vaultStore.isUnlocked()) {'),
)


def run(command: list[str], *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)


def assert_baseline(result: subprocess.CompletedProcess[str], label: str) -> None:
    output = result.stdout + result.stderr
    if result.returncode != 0 or not re.search(r"Tests\s+\d+ passed", output):
        raise RuntimeError(f"{label} failed (exit {result.returncode}):\n{output[-3000:]}")
    print(f"{label}: passed", flush=True)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    env = os.environ.copy()
    env["NO_COLOR"] = "1"
    env["FORCE_COLOR"] = "0"
    env.pop("OPENSESAME_AUTH_FORMAL_VECTORS", None)
    before = {name: digest(ROOT / name) for name in SOURCES}
    assert_baseline(run(["bash", str(RUNNER)], cwd=ROOT, env=env), "Live baseline")

    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="auth-negative-", dir=work) as directory:
        scratch = Path(directory)
        for relative in SOURCES:
            target = scratch / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        (scratch / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        # The storage correspondence migrates PGlite from the database package.
        (scratch / "packages/database").symlink_to(ROOT / "packages/database", target_is_directory=True)
        (scratch / "package.json").write_text('{"private": true, "type": "module"}\n')
        (scratch / "vitest.config.mjs").write_text(
            'import { defineConfig } from "vitest/config";\n'
            'export default defineConfig({ cacheDir: "./vite-cache", test: {'
            ' environment: "node", include: ["spec/formal/auth/*-conformance.test.ts"] } });\n'
        )
        vectors = scratch / "vectors.tsv"
        lean = env.get("OPENSESAME_LEAN_BIN", "lean")
        with vectors.open("w") as output:
            subprocess.run(["bash", str(ROOT / "spec/formal/check-axioms.sh"), lean,
                            str(AUTH / "AuthPolicy.lean")],  # appends AuthSession.lean
                           cwd=AUTH, env=env, stdout=output, check=True)
        trial_env = env | {"OPENSESAME_AUTH_FORMAL_VECTORS": str(vectors)}
        command = [str(ROOT / "node_modules/.bin/vitest"), "run", "--root", str(scratch),
                   "--config", str(scratch / "vitest.config.mjs"), "--maxWorkers=2"]
        assert_baseline(run(command, cwd=scratch, env=trial_env), "Scratch baseline")
        for name, category, relative, old, new in MUTATIONS:
            source = scratch / relative
            original = source.read_bytes()
            text = original.decode("utf8")
            if text.count(old) != 1:
                raise RuntimeError(f"{name}: mutation point is absent or ambiguous")
            try:
                source.write_text(text.replace(old, new, 1), encoding="utf8")
                result = run(command, cwd=scratch, env=trial_env)
            finally:
                source.write_bytes(original)
            output = result.stdout + result.stderr
            failing_case = re.search(
                rf"FAIL\s+.*(?:auth|session)-conformance\.test\.ts\s+>[^\n]*\b{category}\b", output)
            if result.returncode == 0 or "AssertionError" not in output or not failing_case:
                raise RuntimeError(f"{name}: expected a {category} correspondence assertion; "
                                   f"exit {result.returncode}:\n{output[-3000:]}")
            print(f"{name}: correspondence assertion detected the mutation", flush=True)
        assert_baseline(run(command, cwd=scratch, env=trial_env), "Restored scratch baseline")

    after = {name: digest(ROOT / name) for name in SOURCES}
    if after != before:
        raise RuntimeError("Active source or conformance suite changed during scratch checks")
    assert_baseline(run(["bash", str(RUNNER)], cwd=ROOT, env=env), "Restored live baseline")


if __name__ == "__main__":
    main()
