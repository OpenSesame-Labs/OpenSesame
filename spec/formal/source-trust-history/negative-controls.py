#!/usr/bin/env python3
"""Exercise history security regressions against isolated implementation mutants."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[3]
OVERLAY = (
    "apps/cli", "crates/gateway", "crates/human-vault", "crates/storage", "crates/spiffe-source",
    "crates/transport-security", "spec/formal/source-trust-history",
)
OVERLAY_FILES = ("Cargo.lock", "scripts/security/formal-proof-source-history.mjs", "spec/formal/check-axioms.sh")


@dataclass(frozen=True)
class Control:
    label: str
    path: str
    before: str
    after: str
    cargo: tuple[str, ...]
    test: str
    diagnostic: str


GATEWAY = ("-p", "opensesame-gateway", "--lib")
TRANSPORT = ("-p", "opensesame-transport-security", "--all-features", "--test", "source_history_reservation")
SPIFFE = ("-p", "opensesame-spiffe-source", "--all-features")

CONTROLS = (
    Control(
        "unattested initialization accepted",
        "crates/gateway/src/transport/source_history.rs",
        "if !attest_complete {", "if false && !attest_complete {", GATEWAY,
        "transport::source_history::tests::missing_requires_one_explicit_attestation_and_never_overwrites",
        "assertion failed:",
    ),
    Control(
        "union forgets existing names",
        "crates/gateway/src/transport/source_history.rs",
        "let mut names: BTreeSet<String> = history.names.iter().cloned().collect();",
        "let mut names: BTreeSet<String> = BTreeSet::new();", GATEWAY,
        "transport::source_history::tests::sqlite_restart_keeps_the_union_after_a_write_before_activation",
        "assertion `left == right` failed",
    ),
    Control(
        "pending source names forgotten at handoff",
        "crates/transport-security/src/source_trust.rs",
        "serial.source_profiles.extend(profiles.iter().cloned());\n        if conflict {",
        "if conflict {", TRANSPORT,
        "pending_names_survive_same_manager_owner_handoff",
        "assertion `left == right` failed",
    ),
    Control(
        "provisional wall deadline extended",
        "crates/transport-security/src/source_history_activation.rs",
        "deadline: Some(cert_deadline.min(wait_deadline)),",
        "deadline: Some(cert_deadline),",
        ("-p", "opensesame-transport-security", "--all-features", "--lib"),
        "generations::source_lifetime::source_history_activation::tests::a_paused_publication_keeps_the_wait_bound_until_owner_finalization",
        "assertion failed:",
    ),
    Control(
        "failed finalization leaves a generation published",
        "crates/spiffe-source/src/sink/transport.rs",
        "let _ = self\n                .generations\n                .withdraw_from_source(&self.owner, epoch, error.clone());",
        "let _ = epoch;", SPIFFE + ("--lib",),
        "sink::transport::tests::failed_finalization_with_no_previous_active_generation_withdraws_the_provisional_epoch",
        "assertion failed: generations.current().withdrawn.is_some()",
    ),
    Control(
        "unknown write outcome does not poison successor",
        "crates/gateway/src/transport/source_history/coordinator.rs",
        "self.hold.0.scope.poisoned.store(true, Ordering::SeqCst);",
        "self.hold.0.scope.poisoned.store(false, Ordering::SeqCst);", GATEWAY,
        "transport::source_history::coordinator::tests::dropping_an_unresolved_write_poison_fences_the_next_owner",
        "assertion failed:",
    ),
    Control(
        "stream stops observing events during a write",
        "crates/spiffe-source/src/source.rs",
        "item = stream.next() => {", "item = stream.next(), if pending.is_none() => {",
        SPIFFE + ("--test", "durable_history_supersession"),
        "observed_denial_withdraws_before_the_superseded_write_finishes",
        "expected prompt withdrawal",
    ),
    Control(
        "stored source name is not quarantined",
        "crates/gateway/src/transport_lifecycle/trust_activate.rs",
        "quarantined.insert(profile.profile.clone());", "let _ = &profile.profile;", GATEWAY,
        "transport_lifecycle::trust_generation_tests::history_tests::colliding_stored_name_is_quarantined_without_hiding_unrelated_trust",
        "called `Result::unwrap()` on an `Err` value",
    ),
    Control(
        "startup drops durable names before PEM transition",
        "crates/gateway/src/transport/source_history/coordinator.rs",
        ".seed_source_history(1, &history.names())", ".seed_source_history(1, &BTreeSet::new())", GATEWAY,
        "transport::source_history::coordinator::integration_tests::initialized_host_retains_source_names_across_restart_and_pem_transition",
        "a PEM bundle cannot take a previously source-owned name",
    ),
    Control(
        "cross-process lock names do not agree",
        "crates/gateway/src/transport/source_history/file_lock.rs",
        "let lease = HeldPrivateWriterLease::exclusive(Arc::new(directory), &identity)",
        'let lease = HeldPrivateWriterLease::exclusive(Arc::new(directory), &format!("{identity}-{}", std::process::id()))',
        ("-p", "opensesame-cli", "--test", "host_startup_security"),
        "configured_host_requires_offline_attestation_before_it_serves",
        "Host command did not exit",
    ),
    Control(
        "duplicate claim releases SQLite locks", "crates/gateway/src/transport/source_history/file_lock.rs",
        "if owned_identity(&metadata, &owners)? {",
        "if owned_identity(&metadata, &owners)? {\n                let _ = File::open(&candidate)?;",
        GATEWAY, "transport::source_history::coordinator::tests::duplicate_host_claim_preserves_the_sqlite_write_lock", "competing SQLite writer was not fenced",
    ),
)


def run(command: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    lock = int(env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"])
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True,
                          timeout=300, check=False, pass_fds=(lock,))


def copy_current_slice(scratch: Path, lock_fd: int) -> None:
    """Use committed workspace structure and the current reviewed slice."""
    proc = subprocess.Popen(["git", "-c", "index.threads=1", "-c", "core.preloadIndex=false",
                             "archive", "--format=tar", "HEAD"], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(lock_fd,))
    assert proc.stdout is not None and proc.stderr is not None
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as archive:
            archive.extractall(scratch, filter="data")
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        proc.stdout.close()
    error = proc.stderr.read().decode("utf-8", errors="replace")
    if proc.wait() != 0:
        raise RuntimeError(f"git archive failed: {error}")
    for name in OVERLAY:
        source = ROOT / name
        if source.is_symlink() or any(path.is_symlink() for path in source.rglob("*")):
            raise RuntimeError(f"unexpected symlink in {name}")
        target = scratch / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in OVERLAY_FILES:
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError(f"missing or non-regular overlay file: {name}")
        target = scratch / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def load_isolation(scratch: Path):
    name = "scripts/security/formal-cargo-isolation.py"
    trusted = (ROOT / name).read_bytes()
    candidate = scratch / name
    if candidate.is_symlink() or candidate.read_bytes() != trusted:
        raise RuntimeError("scratch isolation helper differs from the reviewed checkout")
    spec = importlib.util.spec_from_file_location("formal_cargo_isolation", candidate)
    if spec is None or spec.loader is None:
        raise RuntimeError("scratch isolation helper cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    exec(compile(trusted, str(candidate), "exec", dont_inherit=True), module.__dict__)
    return module


def verify(control: Control, scratch: Path, env: dict[str, str], isolation, mutant: bool) -> None:
    print(f"{control.label}: starting {'mutant' if mutant else 'baseline'}", flush=True)
    command = ["test", "--locked", *control.cargo, control.test, "--", "--exact", "--nocapture"]
    result = isolation.checked_cargo(
        scratch, env, [control.cargo[1]],
        Path("spec/formal/source-trust-history/check-drift.py"), command,
    )
    output = result.stdout + result.stderr
    if mutant:
        valid = (result.returncode == 101 and f"test {control.test} ... FAILED" in output
                 and "panicked at" in output and control.diagnostic in output)
    else:
        valid = result.returncode == 0 and f"test {control.test} ... ok" in output
    if not valid:
        stage = "mutant" if mutant else "baseline"
        raise RuntimeError(f"{control.label} ({stage}): unexpected exit {result.returncode}\n{output[-10000:]}")
    print(f"{control.label}: {'rejected' if mutant else 'baseline passed'}", flush=True)


def model_controls(scratch: Path, env: dict[str, str]) -> None:
    command = ["bash", "spec/formal/source-trust-history/verify.sh", "--model-only"]

    def check(label: str, diagnostic: str | None) -> None:
        result = run(command, scratch, env)
        output = result.stdout + result.stderr
        if diagnostic is None:
            counts = [sum(line.startswith(prefix) for line in result.stdout.splitlines())
                      for prefix in ("case\t", "stream\t", "coord\t", "file\t", "lifecycle\t")]
            valid = result.returncode == 0 and counts == [9, 2, 4, 2, 4]
        else:
            valid = result.returncode != 0 and diagnostic in output
        if not valid:
            raise RuntimeError(f"{label}: unexpected result {result.returncode}\n{output[-5000:]}")
        print(f"{label}: {'passed' if diagnostic is None else 'rejected'}", flush=True)

    check("model baseline", None)
    changes = (
        ("wrong Lean pin", "spec/formal/source-trust-history/lean-toolchain",
         "leanprover/lean4:v4.24.0", "leanprover/lean4:v0.0.0", "pinned Lean 4.24.0 is required"),
        ("wrong obligation count", "spec/formal/check-axioms.sh",
         "SourceTrustHistory.lean) suite=source-trust-history; required_count=25 ;;",
         "SourceTrustHistory.lean) suite=source-trust-history; required_count=24 ;;",
         "expected 24 required theorems, checked 25"),
        ("weakened theorem proposition", "spec/formal/source-trust-history/required-theorems.lean",
         "∀ (record : Option Record) (names : List Nat), bootstrap record false names = record",
         "True", "required theorem type mismatch: OpenSesame.SourceTrustHistory.unattested_initialization_refused"),
    )
    for label, name, before, after, diagnostic in changes:
        path = scratch / name
        original = path.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f"{label}: mutation target is not unique")
        try:
            path.write_text(original.replace(before, after, 1))
            check(label, diagnostic)
        finally:
            path.write_text(original)
    check("model restored", None)


def drift_controls(scratch: Path, env: dict[str, str], isolation) -> None:
    checker = Path("spec/formal/source-trust-history/check-drift.py")
    coverage = Path("spec/formal/source-trust-history/coverage.json")

    def check(label: str, expected: str, succeeds: bool = False) -> None:
        result = run([sys.executable, "-I", str(checker)], scratch, env)
        if (result.returncode == 0) != succeeds or expected not in result.stdout + result.stderr:
            raise RuntimeError(f"{label}: unexpected result {result.returncode}\n{result.stdout}{result.stderr}")
        print(f"{label}: {'accepted' if succeeds else 'rejected'}", flush=True)

    check("reviewed drift baseline", "reviewed sources", True)
    source = scratch / "crates/gateway/src/transport/source_history.rs"
    original = source.read_bytes()
    try:
        source.write_bytes(original + b"\n")
        check("unreviewed source", "review source drift: crates/gateway/src/transport/source_history.rs")
    finally:
        source.write_bytes(original)

    # A toolchain bump for this suite's own proofs must be re-reviewed, not
    # silently accepted because a sibling suite's pin still matches.
    toolchain = scratch / "spec/formal/source-trust-history/lean-toolchain"
    original_toolchain = toolchain.read_bytes()
    try:
        toolchain.write_bytes(original_toolchain.replace(b"v4.24.0", b"v0.2.40"))
        check("unreviewed Lean toolchain",
              "review source drift: spec/formal/source-trust-history/lean-toolchain")
    finally:
        toolchain.write_bytes(original_toolchain)

    # Even after its covered hash is changed, a different set of embedded
    # migrations must be explicitly reviewed before it can be executed.
    with isolation.mutated_coverage(
        scratch, coverage, Path("crates/storage/src/migrations.rs"),
        '("0001_init", include_str!("../migrations/0001_init.sql"))',
        '("0002_connections", include_str!("../migrations/0002_connections.sql"))', checker, env=env,
    ):
        check("rehashed migration list", "reviewed Host migration inventory changed")

    with isolation.mutated_coverage(
        scratch, coverage, Path("crates/storage/src/lib.rs"), "mod migrations;\n",
        'macro_rules! include_str { ($path:expr) => '
        '{ ::std::include_str!("../migrations/0001_init.sql") }; }\nmod migrations;\n',
        checker, env=env,
    ):
        check("rehashed macro shadow", "reviewed storage migration root changed")

    targets = (
        ("library", "crates/storage/Cargo.toml", "[package]\n",
         '[lib]\npath = "src/history-alternate.rs"\n\n[package]\n'),
        ("binary", "apps/cli/Cargo.toml", 'path = "src/main.rs"',
         'path = "src/history-alternate.rs"'),
        ("test", "crates/transport-security/Cargo.toml", "[package]\n",
         '[[test]]\nname = "source_history_reservation"\n'
         'path = "tests/history-alternate.rs"\n\n[package]\n'),
    )
    for label, manifest, before, after in targets:
        with isolation.mutated_coverage(scratch, coverage, Path(manifest), before, after, checker, env=env):
            kind = "bin" if label == "binary" else "lib" if label == "library" else label
            check(f"rehashed {label} target", f"reviewed Cargo {kind} target changed")

    unreferenced = scratch / "crates/storage/migrations/9999_unreferenced_history_probe.sql"
    created = False
    try:
        with unreferenced.open("x", encoding="utf-8") as file:
            created = True
            file.write("-- deliberately not included by the Host migration list\n")
        check("unreferenced migration", "reviewed sources", True)
        first = '    ("0001_init", include_str!("../migrations/0001_init.sql")),'
        mutations = (
            ("alternate concat include", first,
             first + '\n    ("9999_unreferenced_history_probe", '
             'include_str!(concat!("../migrations/", "9999_unreferenced_history_probe.sql"))),'),
            ("extra declaration", '];\n',
             '];\nconst EXTRA: &str = include_str!("../migrations/9999_unreferenced_history_probe.sql");\n'),
            ("noncanonical migration path", '../migrations/0001_init.sql',
             '../migrations/./0001_init.sql'),
        )
        for label, before, after in mutations:
            with isolation.mutated_coverage(
                scratch, coverage, Path("crates/storage/src/migrations.rs"), before, after, checker, env=env,
            ):
                check(label, "unsupported Host migration module")
    finally:
        if created:
            unreferenced.unlink(missing_ok=True)

    # An invented matching coverage hash must not let an implicit local build
    # script run. Verify this using the real suite runner and a Cargo marker.
    build = scratch / "crates/domain/build.rs"
    coverage_file = scratch / coverage
    original_coverage = coverage_file.read_bytes()
    fake_bin = scratch / "history-control-bin"
    fake_bin.mkdir()
    fake_cargo = fake_bin / "cargo"
    fake_cargo.write_text('#!/bin/sh\nprintf called > "$OPENSESAME_HISTORY_CARGO_MARKER"\n')
    fake_cargo.chmod(0o755)
    marker = fake_bin / "cargo-invoked"
    created = False
    try:
        with build.open("x", encoding="utf-8") as file:
            created = True
            file.write('fn main() { println!("cargo:rustc-cfg=unreviewed"); }\n')
        document = json.loads(original_coverage)
        entries = [entry for entry in document["optional_sources"] if entry["path"] == "crates/domain/build.rs"]
        if len(entries) != 1 or entries[0]["sha256"] is not None:
            raise RuntimeError("implicit build script did not have one absent coverage entry")
        entries[0]["sha256"] = hashlib.sha256(build.read_bytes()).hexdigest()
        coverage_file.write_text(json.dumps(document, indent=2) + "\n")
        controlled = env | {"PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                            "OPENSESAME_HISTORY_CARGO_MARKER": str(marker)}
        result = run(["bash", "spec/formal/source-trust-history/verify.sh"], scratch, controlled)
        if (result.returncode == 0 or marker.exists() or
                "local build script requires separately reviewed coverage" not in result.stdout + result.stderr):
            raise RuntimeError(f"rehashed build script: unexpected result {result.returncode}\n{result.stdout}{result.stderr}")
        print("rehashed implicit build script: rejected before Cargo", flush=True)
    finally:
        if created:
            build.unlink(missing_ok=True)
        coverage_file.write_bytes(original_coverage)
        shutil.rmtree(fake_bin)
    check("restored drift baseline", "reviewed sources", True)


def main() -> None:
    if sys.argv[1:] not in ([], ["--drift-only"]):
        raise RuntimeError("usage: negative-controls.py [--drift-only]")
    drift_only = sys.argv[1:] == ["--drift-only"]
    if not drift_only and shutil.which("cargo") is None:
        raise RuntimeError("activate the pinned Rust toolchain first")
    env = os.environ.copy() | {
        "CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true",
        "CARGO_BUILD_JOBS": "1", "RUST_TEST_THREADS": "1",
    }
    isolation = load_isolation(ROOT)
    with isolation.scratch_checkout(ROOT) as checkout:
        scratch = checkout.path
        env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(checkout.lock_fd)
        copy_current_slice(scratch, checkout.lock_fd)
        if not drift_only:
            model_controls(scratch, env)
        isolation = load_isolation(scratch)
        drift_controls(scratch, env, isolation)
        if drift_only:
            return
        checker = Path("spec/formal/source-trust-history/check-drift.py")
        coverage = Path("spec/formal/source-trust-history/coverage.json")
        for control in CONTROLS:
            path = scratch / control.path
            original = path.read_text()
            if original.count(control.before) != 1:
                raise RuntimeError(f"{control.label}: mutation target is not unique")
            verify(control, scratch, env, isolation, mutant=False)
            with isolation.mutated_coverage(
                scratch, coverage, Path(control.path), control.before, control.after, checker, env=env,
            ):
                verify(control, scratch, env, isolation, mutant=True)
            verify(control, scratch, env, isolation, mutant=False)
    print(f"{len(CONTROLS)} implementation mutants rejected in an isolated copy", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"source-history-negative-controls: {error}", file=sys.stderr)
        sys.exit(1)
