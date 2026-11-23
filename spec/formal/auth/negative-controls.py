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
)
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
        (scratch / "package.json").write_text('{"private": true, "type": "module"}\n')
        (scratch / "vitest.config.mjs").write_text(
            'import { defineConfig } from "vitest/config";\n'
            'export default defineConfig({ cacheDir: "./vite-cache", test: {'
            ' environment: "node", include: ["spec/formal/auth/auth-conformance.test.ts"] } });\n'
        )
        vectors = scratch / "vectors.tsv"
        lean = env.get("OPENSESAME_LEAN_BIN", "lean")
        with vectors.open("w") as output:
            subprocess.run(["bash", str(ROOT / "spec/formal/check-axioms.sh"), lean,
                            str(AUTH / "AuthPolicy.lean")],
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
            failing_case = re.search(rf"FAIL\s+.*auth-conformance\.test\.ts\s+>[^\n]*\b{category}\b", output)
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
