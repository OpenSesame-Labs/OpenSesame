#!/usr/bin/env python3
"""Exercise full proof runners against isolated skipped/renamed tests and empty reports."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SUITES = {
    "auth": {
        "runner": "scripts/test/auth-formal.sh",
        "test": "spec/formal/auth/auth-conformance.test.ts",
        "skip": (
            'it.each(sessions)(',
            'it.skip.each(sessions)(',
        ),
        "rename": ('contains every declared abstract case exactly once', 'renamed inventory'),
    },
    "oauth": {
        "runner": "spec/formal/oauth/verify.sh",
        "test": "spec/formal/oauth/legacy-conformance.test.ts",
        "skip": ('it.each(provenance)(', 'it.skip.each(provenance)('),
        "rename": ('legacy provenance %s %s %s %s %s', 'renamed legacy provenance %s %s %s %s %s'),
    },
    "webauthn": {
        "runner": "spec/formal/webauthn/verify.sh",
        "test": "spec/formal/webauthn/approval-conformance.test.ts",
        "skip": ('it.each(vectors)(', 'it.skip.each(vectors)('),
        "rename": ('approval %s %s %s %s %s %s', 'renamed approval %s %s %s %s %s %s'),
    },
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def invoke(root: Path, runner: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", runner], cwd=root, env=env, text=True, capture_output=True, timeout=180, check=False)


def require_pass(root: Path, suite: str, env: dict[str, str]) -> None:
    result = invoke(root, SUITES[suite]["runner"], env)
    if result.returncode != 0 or f"formal-vitest-report: {suite} correspondence checks passed" not in result.stdout:
        raise RuntimeError(f"{suite} baseline did not pass: {result.returncode}\n{(result.stdout + result.stderr)[-6000:]}")
    print(f"{suite}: unmodified runner passed", flush=True)


def require_guard_failure(root: Path, suite: str, mutation: str, env: dict[str, str]) -> None:
    result = invoke(root, SUITES[suite]["runner"], env)
    output = result.stdout + result.stderr
    if result.returncode == 0 or "formal-vitest-report:" not in output or "correspondence checks passed" in output:
        raise RuntimeError(f"{suite}/{mutation}: expected report-verifier failure, exit {result.returncode}\n{output[-6000:]}")
    if mutation == "skip" and "skipped" not in output:
        raise RuntimeError(f"{suite}/{mutation}: report did not show skipped tests\n{output[-6000:]}")
    if mutation == "empty report" and "JSON" not in output:
        raise RuntimeError(f"{suite}/{mutation}: report was not empty or malformed\n{output[-6000:]}")
    if mutation.startswith("duplicate "):
        expected_count = "6147 passed" if suite == "webauthn" else "2180 passed"
        group = "approval" if suite == "webauthn" else mutation.removeprefix("duplicate ").removesuffix("s")
        if expected_count not in output.replace(",", "") or f"{suite} {group} tests" not in output:
            raise RuntimeError(f"{suite}/{mutation}: expected all tests to pass and duplicate-key rejection\n{output[-6000:]}")
    if mutation == "subset cases" and ("4 passed" not in output or "incomplete" not in output):
        raise RuntimeError(f"{suite}/{mutation}: expected a passing subset and incomplete-report rejection\n{output[-6000:]}")
    if mutation == "malformed output" and "vector has invalid output" not in output:
        raise RuntimeError(f"{suite}/{mutation}: malformed output was not rejected by the verifier\n{output[-6000:]}")
    print(f"{suite}: {mutation} rejected by full runner", flush=True)


def observe_callback_limit(root: Path, group: str, env: dict[str, str]) -> None:
    result = invoke(root, SUITES["auth"]["runner"], env)
    output = result.stdout + result.stderr
    if result.returncode != 0 or "2180 passed" not in output or "formal-vitest-report: auth correspondence checks passed" not in output:
        raise RuntimeError(f"auth/{group} callback observation changed; review the documented boundary\n{output[-6000:]}")
    print(f"auth: {group} callback ignored tuples while all titles passed (documented limitation)", flush=True)


def main() -> None:
    if shutil.which("node") is None or shutil.which(os.environ.get("OPENSESAME_LEAN_BIN", "lean")) is None:
        raise RuntimeError("activate the pinned Node and Lean toolchains first")
    inputs = [data["test"] for data in SUITES.values()]
    before = {name: digest(ROOT / name) for name in inputs}
    env = os.environ.copy()
    env["NO_COLOR"] = "1"
    env["FORCE_COLOR"] = "0"
    for name in ("OPENSESAME_OAUTH_MUTANT", "OPENSESAME_APPROVAL_MUTANT"):
        env.pop(name, None)

    try:
        with tempfile.TemporaryDirectory(prefix="formal-vitest-report-negative-") as directory:
            scratch = Path(directory)
            (scratch / "spec/formal").mkdir(parents=True)
            (scratch / "scripts/test").mkdir(parents=True)
            for suite in SUITES:
                shutil.copytree(ROOT / f"spec/formal/{suite}", scratch / f"spec/formal/{suite}", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for relative in ["spec/formal/check-axioms.sh", "spec/formal/required-theorem-command.lean", "spec/formal/proof-registry.json", "scripts/test/auth-formal.sh", "scripts/test/auth-formal-drift.mjs", "scripts/test/formal-vitest-report.mjs", "scripts/test/formal-vitest-report-matrices.mjs", "scripts/test/auth-formal-drift.test.mjs", "scripts/test/auth-formal-snapshot-fixture.mjs"]:
                shutil.copy2(ROOT / relative, scratch / relative)
            (scratch / "scripts/lib").symlink_to(ROOT / "scripts/lib", target_is_directory=True)
            (scratch / "packages").symlink_to(ROOT / "packages", target_is_directory=True)
            # The auth drift check reads reviewed revisions from git: give the
            # scratch tree a repository that borrows ROOT's objects at ROOT's HEAD.
            subprocess.run(["git", "init", "-q", str(scratch)], check=True)
            common = subprocess.check_output(
                ["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                text=True).strip()
            (scratch / ".git/objects/info/alternates").write_text(f"{common}/objects\n")
            head = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True)
            (scratch / ".git/HEAD").write_text(head)
            # The auth drift check reads the register and AUTH-C1's snapshot sources.
            for linked in ("docs", "apps"):
                (scratch / linked).symlink_to(ROOT / linked, target_is_directory=True)
            # The auth sign-out check parses session-exit.ts with these helpers.
            (scratch / "spec/auth-verification").symlink_to(ROOT / "spec/auth-verification", target_is_directory=True)
            # The hosted test runs from the linked control-plane checkout. Run
            # its unchanged checker there as well so both resolve the same path.
            hosted_checker = scratch / "spec/formal/oauth/check-hosted-flow-report.mjs"
            hosted_checker.unlink()
            hosted_checker.symlink_to(ROOT / "spec/formal/oauth/check-hosted-flow-report.mjs")
            modules = scratch / "node_modules"
            modules.symlink_to((ROOT / "node_modules").resolve(), target_is_directory=True)

            for suite in SUITES:
                require_pass(scratch, suite, env)
            for suite, data in SUITES.items():
                path = scratch / data["test"]
                original = path.read_text()
                for mutation in ("skip", "rename"):
                    before_text, after_text = data[mutation]
                    if original.count(before_text) != 1:
                        raise RuntimeError(f"{suite}/{mutation}: mutation point is not unique")
                    try:
                        path.write_text(original.replace(before_text, after_text, 1))
                        require_guard_failure(scratch, suite, mutation, env)
                    finally:
                        path.write_text(original)

                if suite == "auth":
                    for group in ("sessions", "projects"):
                        before_text = f'it.each({group})('
                        after_text = f'it.each({group}.map(() => {group}[0]))('
                        if original.count(before_text) != 1:
                            raise RuntimeError(f"auth/duplicate {group}: mutation point is not unique")
                        try:
                            path.write_text(original.replace(before_text, after_text, 1))
                            require_guard_failure(scratch, suite, f"duplicate {group}", env)
                        finally:
                            path.write_text(original)

                    # A report cannot inspect callback semantics. Preserve every
                    # generated title but deliberately make each callback use
                    # the first tuple, and record the resulting limitation.
                    callback_arguments = {
                        "sessions": "_kind, prefix, mapped, present, expiryValue, unrevoked, principalValue, cleanup, withdrawal, expected",
                        "projects": "_kind, present, stateValue, expiryValue, roleValue, expectedRole, expectedMember, expectedAdmin, expectedOwner",
                    }
                    for group, arguments in callback_arguments.items():
                        lines = "".join(f"      {argument},\n" for argument in arguments.split(", "))
                        before_text = f"async (...[\n{lines}    ]) => {{"
                        after_text = f"async (..._ignored) => {{\n      const [{arguments}] = {group}[0];"
                        if original.count(before_text) != 1:
                            raise RuntimeError(f"auth/{group} callback observation point is not unique")
                        try:
                            path.write_text(original.replace(before_text, after_text, 1))
                            observe_callback_limit(scratch, group, env)
                        finally:
                            path.write_text(original)

                if suite == "webauthn":
                    before_text = 'it.each(vectors)('
                    for mutation, replacement in (
                        ("subset cases", 'it.each(vectors.slice(0, 1))('),
                        ("duplicate cases", 'it.each(vectors.map(() => vectors[0]))('),
                    ):
                        if original.count(before_text) != 1:
                            raise RuntimeError(f"webauthn/{mutation}: mutation point is not unique")
                        try:
                            path.write_text(original.replace(before_text, replacement, 1))
                            require_guard_failure(scratch, suite, mutation, env)
                        finally:
                            path.write_text(original)

                if suite in ("auth", "oauth"):
                    model_name = "AuthSession.lean" if suite == "auth" else "PendingIntegrity.lean"
                    model = scratch / f"spec/formal/{suite}/{model_name}"
                    original_model = model.read_text()
                    bit = 'def bit (b : Bool) : String := if b then "1" else "0"' if suite == "auth" else 'private def bit (value : Bool) : String := if value then "1" else "0"'
                    value = '{bit (resolves ⟨p, m, pr, u, e, prin, cl, w⟩ 0)}' if suite == "auth" else '{bit (acceptsProvenance provider byo org source)}'
                    poisoned_value = value.replace('bit ', 'poison ', 1)
                    if original_model.count(bit) != 1 or original_model.count(value) != 1:
                        raise RuntimeError(f"{suite}/malformed output: mutation point is not unique")
                    try:
                        poisoned = original_model.replace(bit, bit + '\nprivate def poison (b : Bool) : String := if b then "1" else "bogus"', 1)
                        model.write_text(poisoned.replace(value, poisoned_value, 1))
                        require_guard_failure(scratch, suite, "malformed output", env)
                    finally:
                        model.write_text(original_model)

                # A successful test process that produces no JSON must fail the
                # same normal runner, rather than pass because its exit was zero.
                modules.unlink()
                try:
                    (modules / ".bin").mkdir(parents=True)
                    fake = modules / ".bin/vitest"
                    fake.write_text("#!/bin/sh\nexit 0\n")
                    fake.chmod(0o755)
                    require_guard_failure(scratch, suite, "empty report", env)
                finally:
                    shutil.rmtree(modules)
                    modules.symlink_to((ROOT / "node_modules").resolve(), target_is_directory=True)
            for suite in SUITES:
                require_pass(scratch, suite, env)
    finally:
        changed = [name for name, value in before.items() if digest(ROOT / name) != value]
        if changed:
            raise RuntimeError(f"live tests changed during controls: {', '.join(changed)}")
    print("15 isolated runner controls passed; two callback limitations reproduced; live test files unchanged", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"formal-vitest-negative-controls: {error}", file=sys.stderr)
        sys.exit(1)
