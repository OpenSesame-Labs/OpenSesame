#!/usr/bin/env python3
"""Demonstrate that the real SPIFFE checks reject isolated Rust mutants."""
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[3]
CRATE = Path("crates/spiffe-source")
FORMAL_TEST = "source::formal_tests::lean_vectors_match_the_sdk_classifier_and_outage_deadlines"
LIVE_TREES = (CRATE, Path("crates/domain"), Path("crates/transport-security"), Path("spec/formal/spiffe"))
LIVE_FILES = (
    Path("Cargo.toml"),
    Path("Cargo.lock"),
    Path("rust-toolchain.toml"),
    Path("spec/formal/check-axioms.sh"),
    Path("spec/formal/required-theorem-command.lean"),
    Path("scripts/security/cargo-lock-projection.py"),
    Path("scripts/security/formal-cargo-isolation.py"),
    Path("scripts/security/formal-cargo-freshness.py"),
)


@dataclass(frozen=True)
class Witness:
    name: str
    arguments: tuple[str, ...]
    diagnostic: str


@dataclass(frozen=True)
class Mutation:
    name: str
    source: str
    before: str
    after: str
    witnesses: tuple[Witness, ...]


def vector(case: str) -> Witness:
    return Witness(
        FORMAL_TEST,
        ("--lib", FORMAL_TEST, "--", "--ignored", "--exact"),
        case,
    )


def integration(test_file: str, test_name: str, diagnostic: str) -> Witness:
    return Witness(test_name, ("--test", test_file, test_name, "--", "--exact"), diagnostic)


MUTATIONS = (
    Mutation(
        "permission-denial-becomes-outage",
        "src/source_policy.rs",
        'WorkloadApiError::PermissionDenied(_) => ApiAction::Denied("workload_api_denied"),',
        "WorkloadApiError::PermissionDenied(_) => ApiAction::Outage,",
        (
            vector("classify\tpermission_denied\tpermission_denied"),
            integration("withdrawal_policy", "permission_denied_on_the_stream_withdraws_and_recovers", "expected prompt withdrawal"),
        ),
    ),
    Mutation(
        "unauthenticated-becomes-outage",
        "src/source_policy.rs",
        'if status.code() == GrpcStatusCode::Unauthenticated =>\n        {\n            ApiAction::Denied("workload_api_denied")\n        }',
        "if status.code() == GrpcStatusCode::Unauthenticated =>\n        {\n            ApiAction::Outage\n        }",
        (
            vector("classify\tunauthenticated\tunauthenticated"),
            integration("withdrawal_policy", "unauthenticated_on_reconnect_withdraws_the_active_generation", "expected prompt withdrawal"),
        ),
    ),
    Mutation(
        "unparseable-snapshot-becomes-outage",
        "src/source_policy.rs",
        '_ => ApiAction::Withdraw(\n            TransportError::malformed("workload API snapshot could not be parsed"),\n            "workload_api_message",\n        ),',
        "_ => ApiAction::Outage,",
        (
            vector("classify\tmalformed_field\tmalformed"),
            integration("withdrawal_policy", "omitted_gateway_with_unparseable_worker_withdraws", "expected prompt withdrawal"),
        ),
    ),
    Mutation(
        "present-domain-hides-removed-anchor",
        "src/bundles.rs",
        "anchors.iter().all(|anchor| current.contains(anchor))",
        "anchors.iter().all(|_| !current.is_empty())",
        (
            vector("trust\t1\t2\t0"),
            integration("trust_reduction_policy", "rejected_profile_with_removed_anchor_withdraws", "expected prompt withdrawal"),
        ),
    ),
    Mutation(
        "source-compares-new-trust-to-itself",
        "src/source_loop.rs",
        "incoming.contains_all(&active.bundles)",
        "incoming.contains_all(&incoming)",
        (integration("trust_reduction_policy", "rejected_profile_with_removed_anchor_withdraws", "expected prompt withdrawal"),),
    ),
    Mutation(
        "status-allows-equal-deadline",
        "src/status.rs",
        "if now >= bounded_deadline(not_after, self.retain_until) =>",
        "if now > bounded_deadline(not_after, self.retain_until) =>",
        (
            vector("source_formal_tests.rs:"),
            Witness(
                "status::tests::credential_status_expires_at_the_earlier_boundary_including_equality",
                ("--lib", "status::tests::credential_status_expires_at_the_earlier_boundary_including_equality", "--", "--exact"),
                "assertion `left == right` failed",
            ),
        ),
    ),
    Mutation(
        "retry-extends-retention",
        "src/source_loop.rs",
        "s.retain_until = Some(s.retain_until.map_or(r, |cur| cur.min(r)));",
        "s.retain_until = Some(s.retain_until.map_or(r, |cur| cur.max(r)));",
        (
            vector("source_formal_tests.rs:"),
            integration("outage_policy", "invalid_profile_after_reconnect_cannot_end_the_outage_or_extend_its_deadline", "assertion failed"),
        ),
    ),
    Mutation(
        "stalled-rpc-ignores-outage-deadline",
        "src/source_loop.rs",
        ".map(|active| bounded_deadline(active.not_after, self.status.borrow().retain_until))",
        ".map(|active| active.not_after)",
        (integration("outage_policy", "stalled_rpc_opening_cannot_extend_the_outage_deadline", "expected prompt withdrawal"),),
    ),
    Mutation(
        "correspondence-test-renamed",
        "src/source_formal_tests.rs",
        "fn lean_vectors_match_the_sdk_classifier_and_outage_deadlines() {",
        "fn renamed_lean_vectors_match_the_sdk_classifier_and_outage_deadlines() {",
        (
            Witness(
                "verify.sh rejects zero matched correspondence tests",
                ("verify",),
                "spiffe-formal: required Lean correspondence test did not run and pass",
            ),
        ),
    ),
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def live_fingerprint() -> dict[str, str]:
    files = set(LIVE_FILES)
    for tree in LIVE_TREES:
        files.update(
            path.relative_to(ROOT)
            for path in (ROOT / tree).rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
        )
    return {str(path): digest(ROOT / path) for path in sorted(files)}


def run(command: list[str], *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    raw = env.get("OPENSESAME_FORMAL_SCRATCH_LOCK_FD")
    fds = () if raw is None else (int(raw),)
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=300,
                          check=False, pass_fds=fds)


def require_success(command: list[str], *, cwd: Path, env: dict[str, str], label: str) -> None:
    result = run(command, cwd=cwd, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"{label}: exited {result.returncode}\n{(result.stdout + result.stderr)[-8000:]}")
    print(f"{label}: passed", flush=True)


def archive_workspace(destination: Path, fds: tuple[int, ...] = ()) -> None:
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, pass_fds=fds).strip()
    archive = subprocess.Popen(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        pass_fds=fds,
    )
    assert archive.stdout is not None and archive.stderr is not None
    try:
        with tarfile.open(fileobj=archive.stdout, mode="r|") as source:
            source.extractall(destination, filter="data")
    except BaseException:
        archive.kill()
        archive.wait()
        raise
    finally:
        archive.stdout.close()
    error = archive.stderr.read().decode("utf-8", errors="replace")
    if archive.wait() != 0:
        raise RuntimeError(f"git archive failed: {error}")

    # The active suite can be an uncommitted later stack slice. Copy its real
    # implementation, local dependency crates, and proof files into scratch.
    for relative in LIVE_TREES:
        source = ROOT / relative
        if any(path.is_symlink() for path in source.rglob("*")):
            raise RuntimeError(f"unexpected symlink in {relative}; refusing scratch copy")
        target = destination / relative
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for relative in LIVE_FILES:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)

    # The reviewed-revision anchor and blob checks need a real repository in
    # the scratch: origin/main for the ancestor assertion, and a local commit
    # so `git cat-file blob` resolves every reviewed blob.
    origin_url = subprocess.check_output(
        ["git", "-C", str(ROOT), "remote", "get-url", "origin"],
        text=True,
        pass_fds=fds,
    ).strip()
    subprocess.run(["git", "init", "-q"], cwd=destination, check=True)
    subprocess.run(["git", "remote", "add", "origin", origin_url], cwd=destination, check=True)
    subprocess.run(
        ["git", "fetch", "-q", "origin", "refs/heads/main:refs/remotes/origin/main"],
        cwd=destination,
        check=True,
        pass_fds=fds,
    )
    subprocess.run(["git", "add", "-A"], cwd=destination, check=True)
    # Local commit records the archived bytes. Do not sign: a caller with
    # commit.gpgsign set must still be able to build this disposable repo.
    subprocess.run(
        [
            "git",
            "-c",
            "user.email=negative-controls@example.invalid",
            "-c",
            "user.name=negative-controls",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "negative-controls scratch",
        ],
        cwd=destination,
        check=True,
    )


def assert_caught(mutation: Mutation, witness: Witness, *, scratch: Path, env: dict[str, str], helper: dict) -> None:
    if witness.arguments == ("verify",):
        result = run(["bash", "spec/formal/spiffe/verify.sh"], cwd=scratch, env=env)
        output = result.stdout + result.stderr
        if (
            result.returncode != 1
            or witness.diagnostic not in output
            or "test result: ok. 0 passed; 0 failed; 0 ignored;" not in output
        ):
            raise RuntimeError(
                f"{mutation.name}: expected the zero-test guard, got exit {result.returncode}\n"
                f"{output[-10000:]}"
            )
        print(f"{mutation.name}: caught by {witness.name}", flush=True)
        return
    command = ["cargo", "test", "--locked", "-p", "opensesame-spiffe-source", "--all-features", *witness.arguments]
    result = helper["checked_cargo"](
        scratch, env, ["opensesame-spiffe-source"],
        Path("spec/formal/spiffe/check-drift.py"), command[1:],
    )
    output = result.stdout + result.stderr
    if (
        result.returncode != 101
        or f"test {witness.name} ... FAILED" not in output
        or "panicked at" not in output
        or witness.diagnostic not in output
    ):
        raise RuntimeError(
            f"{mutation.name}/{witness.name}: expected the named assertion failure, "
            f"got exit {result.returncode}\n{output[-10000:]}"
        )
    print(f"{mutation.name}: caught by {witness.name}", flush=True)


def main() -> None:
    if shutil.which("cargo") is None:
        raise RuntimeError("cargo not on PATH; activate the repository toolchain first")
    lean = os.environ.get("OPENSESAME_LEAN_BIN", "lean")
    if shutil.which(lean) is None:
        raise RuntimeError("Lean not found; activate the pinned Lean toolchain first")
    env = os.environ.copy()
    env.pop("OPENSESAME_FORMAL_SCRATCH_LOCK_FD", None)
    env.pop("CARGO_TARGET_DIR", None)
    env["CARGO_INCREMENTAL"] = "0"
    env["CARGO_NET_OFFLINE"] = "true"
    require_success([sys.executable, "-I", "spec/formal/spiffe/check-drift.py"],
                    cwd=ROOT, env=env, label="reviewed live baseline")
    live_helper = ROOT / "scripts/security/formal-cargo-isolation.py"
    lifecycle = {"__name__": "formal_cargo_isolation", "__file__": str(live_helper)}
    exec(compile(live_helper.read_bytes(), str(live_helper), "exec", dont_inherit=True), lifecycle)
    original_hashes = live_fingerprint()
    try:
        with lifecycle["scratch_checkout"](ROOT) as lease:
            scratch = lease.path
            env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(lease.lock_fd)
            archive_workspace(scratch, (lease.lock_fd,))
            require_success([sys.executable, "-I", "spec/formal/spiffe/check-drift.py"],
                            cwd=scratch, env=env, label="reviewed scratch baseline")
            wrapper = subprocess.check_output(
                [sys.executable, "-I", str(scratch / "scripts/security/formal-cargo-isolation.py"), str(scratch)],
                text=True, pass_fds=(lease.lock_fd,),
            ).strip()
            env |= {"RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": wrapper}
            helper_path = scratch / "scripts/security/formal-cargo-isolation.py"
            helper = {"__name__": "formal_cargo_isolation", "__file__": str(helper_path)}
            exec(compile(helper_path.read_bytes(), str(helper_path), "exec", dont_inherit=True), helper)
            require_success(["bash", "spec/formal/spiffe/verify.sh"], cwd=scratch, env=env, label="unmodified suite before mutations")
            vectors = scratch / "spiffe-vectors.tsv"
            with vectors.open("w") as output:
                result = subprocess.run(
                    ["bash", "spec/formal/check-axioms.sh", lean, str(scratch / "spec/formal/spiffe/SpiffePolicy.lean")],
                    cwd=scratch,
                    env=env,
                    stdout=output,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=120,
                    check=False,
                    pass_fds=(lease.lock_fd,),
                )
            if result.returncode != 0:
                raise RuntimeError(f"cannot generate checked Lean vectors: {result.stderr}")
            mutant_env = env | {"OPENSESAME_SPIFFE_VECTORS": str(vectors)}
            for mutation in MUTATIONS:
                path = scratch / CRATE / mutation.source
                original = path.read_text()
                if original.count(mutation.before) != 1:
                    raise RuntimeError(f"{mutation.name}: mutation target is not unique")
                with helper["mutated_coverage"](
                    scratch, Path("spec/formal/spiffe/coverage.json"), CRATE / mutation.source,
                    mutation.before, mutation.after, Path("spec/formal/spiffe/check-drift.py"),
                    env=env,
                ):
                    for witness in mutation.witnesses:
                        assert_caught(mutation, witness, scratch=scratch, env=mutant_env, helper=helper)
            require_success(["bash", "spec/formal/spiffe/verify.sh"], cwd=scratch, env=env, label="unmodified suite after mutations")
    finally:
        after = live_fingerprint()
        changed = sorted(name for name in original_hashes.keys() | after.keys() if original_hashes.get(name) != after.get(name))
        if changed:
            raise RuntimeError(f"live implementation changed during the controls: {', '.join(changed)}")
    print(f"{len(MUTATIONS)} isolated mutants rejected; live test inputs unchanged", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"spiffe-negative-controls: {error}", file=sys.stderr)
        sys.exit(1)
