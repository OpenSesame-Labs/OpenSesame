#!/usr/bin/env python3
"""Reject source and harness mutations in an isolated peer-domain checkout."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[3]
# The --reviewed-patch declarations of verify.sh's freshness init.
REVIEWED_PATCHES = ("sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0",)
FORMAL = "transport::spiffe_domain_formal_tests::lean_vectors_match_real_spiffe_service_admission"


def scratch_path(base: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise RuntimeError("invalid scratch path")
    relative = Path(name)
    if relative.is_absolute() or str(relative) != name or any(p in (".", "..") for p in relative.parts):
        raise RuntimeError(f"invalid scratch path: {name}")
    current = base
    for part in relative.parts[:-1]:
        current /= part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise RuntimeError(f"unsafe scratch parent: {name}")
    return base / relative


def run(command: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    raw = env.get("OPENSESAME_FORMAL_SCRATCH_LOCK_FD")
    fds = () if raw is None else (int(raw),)
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=600,
                          check=False, pass_fds=fds)


def archive(destination: Path, fds: tuple[int, ...] = ()) -> None:
    staged = subprocess.run(["git", "diff", "--cached", "--quiet", "--"], cwd=ROOT, check=False)
    if staged.returncode == 1:
        raise RuntimeError("scratch controls require an empty index")
    if staged.returncode != 0:
        raise RuntimeError("could not inspect the Git index")
    proc = subprocess.Popen(["git", "archive", "--format=tar", "HEAD"], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=fds)
    assert proc.stdout is not None and proc.stderr is not None
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as source:
            source.extractall(destination, filter="data")
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        proc.stdout.close()
    error = proc.stderr.read().decode("utf-8", errors="replace")
    if proc.wait() != 0:
        raise RuntimeError(f"git archive failed: {error}")
    coverage = scratch_path(ROOT, "spec/formal/spiffe-peer-domain/coverage.json")
    if coverage.is_symlink() or not coverage.is_file():
        raise RuntimeError("unreviewed scratch coverage path")
    manifest = json.loads(coverage.read_text())
    paths = [entry["path"] for entry in manifest["sources"] + manifest["optional_sources"]]
    commands = [["git", "diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
                ["git", "ls-files", "--others", "--exclude-standard", "-z"]]
    for command in commands:
        names = subprocess.run(command, cwd=ROOT, check=True, stdout=subprocess.PIPE).stdout.split(b"\0")
        paths.extend(os.fsdecode(name) for name in names if name)
    for name in dict.fromkeys(paths):
        relative = Path(name)
        source = scratch_path(ROOT, name)
        target = scratch_path(destination, name)
        if source.is_symlink():
            raise RuntimeError(f"unreviewed scratch source path: {relative}")
        if not source.exists():
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.exists():
                raise RuntimeError(f"unreviewed scratch target path: {relative}")
            continue
        if not source.is_file() or target.is_symlink():
            raise RuntimeError(f"unreviewed scratch source path: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def require_pass(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        raise RuntimeError(f"{label}: failed ({result.returncode})\n{(result.stdout + result.stderr)[-6000:]}")
    print(f"{label}: passed", flush=True)


def require_failure(result: subprocess.CompletedProcess[str], name: str, diagnostic: str, label: str) -> None:
    output = result.stdout + result.stderr
    if not (result.returncode == 101 and f"test {name} ... FAILED" in output and diagnostic in output):
        raise RuntimeError(f"{label}: unexpected result ({result.returncode})\n{output[-6000:]}")
    print(f"{label}: rejected", flush=True)


def main() -> None:
    env = os.environ.copy() | {"CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true"}
    env.pop("OPENSESAME_FORMAL_SCRATCH_LOCK_FD", None)
    lean = env.get("OPENSESAME_LEAN_BIN", "lean")
    if shutil.which("cargo") is None or shutil.which(lean) is None:
        raise RuntimeError("activate the pinned Rust and Lean toolchains first")
    require_pass(run([sys.executable, "-I", str(ROOT / "spec/formal/spiffe-peer-domain/test_snapshot.py")], ROOT, env),
                 "scratch snapshot controls")
    require_pass(run([sys.executable, "-I", "spec/formal/spiffe-peer-domain/check-drift.py"], ROOT, env),
                 "reviewed live baseline")
    live_helper = ROOT / "scripts/security/formal-cargo-isolation.py"
    lifecycle = {"__name__": "formal_cargo_isolation", "__file__": str(live_helper)}
    exec(compile(live_helper.read_bytes(), str(live_helper), "exec", dont_inherit=True), lifecycle)
    targets = [
        Path("crates/transport-security/src/bounded.rs"),
        Path("crates/domain/src/transport/attest.rs"),
        Path("crates/domain/src/transport/binding.rs"),
        Path("crates/transport-security/src/source_lifetime.rs"),
        Path("crates/transport-security/src/verify_spiffe.rs"),
        Path("crates/gateway/src/transport/source_trust_selection.rs"),
        Path("crates/transport-security/src/server.rs"),
    ]
    live = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in targets}
    try:
        with lifecycle["scratch_checkout"](ROOT) as lease:
            scratch = lease.path
            env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(lease.lock_fd)
            archive(scratch, (lease.lock_fd,))
            require_pass(run([sys.executable, "-I", "spec/formal/spiffe-peer-domain/check-drift.py"],
                             scratch, env), "reviewed scratch baseline")
            wrapper = subprocess.check_output(
                [sys.executable, "-I", str(scratch / "scripts/security/formal-cargo-isolation.py"), str(scratch)],
                text=True, pass_fds=(lease.lock_fd,),
            ).strip()
            env |= {"RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": wrapper}
            helper_path = scratch / "scripts/security/formal-cargo-isolation.py"
            helper = {"__name__": "formal_cargo_isolation", "__file__": str(helper_path)}
            exec(compile(helper_path.read_bytes(), str(helper_path), "exec", dont_inherit=True), helper)
            require_pass(run(["bash", "spec/formal/spiffe-peer-domain/verify.sh"], scratch, env), "unmodified suite")
            result = run(["bash", "spec/formal/check-axioms.sh", lean,
                          str(scratch / "spec/formal/spiffe-peer-domain/SpiffePeerDomain.lean")], scratch, env)
            require_pass(result, "vector generation")
            vectors = scratch / "vectors.tsv"
            vectors.write_text(result.stdout)
            test_env = env | {"OPENSESAME_SPIFFE_PEER_VECTORS": str(vectors)}
            mutations = [
                (targets[0], "verify_svid(end_entity, domain, None, SvidRole::Client, now)?;", "let _ = domain;",
                 "wrong inbound trust domain", "opensesame-transport-security", "spiffe_peer_domain",
                 "source_domain_is_checked_before_exact_spiffe_peer_evidence", False, "wrong_domain"),
                (targets[0], "verify_svid(end_entity, domain, None, SvidRole::Client, now)?;", "let _ = domain;",
                 "wrong domain reaches live service admission", "opensesame-transport-security", "spiffe_peer_domain",
                 "live_tls_spiffe_identity_is_required_for_service_admission", False, "is_err"),
                (targets[1], "let mut verified = self.into_verified()?;\n        verified\n            .identities\n            .retain(|id| matches!(id, PeerIdentitySelector::SpiffeId(_)))", "let mut verified = self.into_verified()?;\n        verified\n            .identities\n            .retain(|_| true)",
                 "thumbprint authorizes", "opensesame-domain", None, FORMAL, True, "selector vector"),
                (targets[2], "leaf_thumbprint: Some(peer.leaf_thumbprint_sha256())", "leaf_thumbprint: None",
                 "revocation ignored", "opensesame-domain", None, FORMAL, True, "selector vector"),
                (targets[1], "Ok(Some(ingress))", "{ let mut ingress = *ingress; ingress.identities.push(PeerIdentitySelector::LeafThumbprintSha256(ingress.leaf_thumbprint_sha256.clone())); Ok(Some(Box::new(ingress))) }",
                 "forwarding widens ingress", "opensesame-domain", None,
                 "transport::spiffe_attest_tests::forwarding_keeps_the_ingress_selectors_restricted", False, "assertion"),
                (targets[3], "&& source.spiffe_trust_domain() == proposed.spiffe_trust_domain()", "&& true",
                 "source trust domain relabeled", "opensesame-transport-security", "source_lifetime_edges",
                 "ordinary_activation_cannot_relabel_a_source_owned_spiffe_domain", False, "assertion"),
                (targets[4], "|| expected.trust_domain().as_str() != domain", "|| false",
                 "wrong outbound reference domain", "opensesame-transport-security", "servername",
                 "outbound_spiffe_reference_must_belong_to_explicit_bundle_domain", False, "assertion"),
                (targets[1], "if self.ingress.is_some() {\n            return Err(TransportError::ForwardedEvidenceUnverified);\n        }", "if let Some(raw) = &self.ingress { return Ok(Some(Box::new(raw.as_ref().clone().into_verified()?))); }",
                 "raw forwarded ingress accepted", "opensesame-domain", None,
                 "transport::spiffe_attest_tests::generic_constructor_refuses_raw_forwarded_ingress", False, "unwrap_err"),
                (targets[5], "&& actual_domain == Some(configured_domain)", "&& true",
                 "wrong configured source domain", "opensesame-gateway", None,
                 "transport::boot::source_trust_tests::generic_source_owner_cannot_override_the_configured_trust_domain", False, "unwrap_err"),
                (targets[6], "if disable_resumption || profile.policy.authenticates_client() {", "if disable_resumption {",
                 "authenticated TLS resumption enabled", "opensesame-transport-security", "spiffe_peer_rotation",
                 "spiffe_domain_rotation_requires_fresh_client_authentication", False, "assertion"),
            ]
            for path, before, after, label, package, integration, name, ignored, diagnostic in mutations:
                target = scratch / path
                original = target.read_text()
                if original.count(before) != 1:
                    raise RuntimeError(f"{label}: mutation target is not unique")
                command = ["cargo", "test", "--locked", "-p", package]
                if integration:
                    command += ["--all-features", "--test", integration]
                else:
                    command += ["--lib"]
                command += [name, "--"]
                if ignored:
                    command.append("--ignored")
                command.append("--exact")
                with helper["mutated_coverage"](
                    scratch, Path("spec/formal/spiffe-peer-domain/coverage.json"), path,
                    before, after, Path("spec/formal/spiffe-peer-domain/check-drift.py"),
                    env=env,
                ):
                    result = helper["checked_cargo"](
                        scratch, test_env, [package], Path("spec/formal/spiffe-peer-domain/check-drift.py"),
                        command[1:], reviewed_patches=REVIEWED_PATCHES,
                    )
                    require_failure(result, name, diagnostic, label)
            vectors.write_text("")
            empty = helper["checked_cargo"](
                scratch, test_env, ["opensesame-domain"], Path("spec/formal/spiffe-peer-domain/check-drift.py"),
                ["test", "--locked", "-p", "opensesame-domain", "--lib", FORMAL, "--", "--ignored", "--exact"],
                reviewed_patches=REVIEWED_PATCHES,
            )
            require_failure(empty, FORMAL, "incomplete formal selector matrix", "empty selector vectors")
            with helper["mutated_coverage"](
                scratch, Path("spec/formal/spiffe-peer-domain/coverage.json"),
                Path("crates/domain/src/transport/spiffe_domain_formal_tests.rs"),
                "fn lean_vectors_match_real_spiffe_service_admission() {",
                "fn renamed_spiffe_peer_correspondence() {",
                Path("spec/formal/spiffe-peer-domain/check-drift.py"),
                env=env,
            ):
                zero = run(["bash", "spec/formal/spiffe-peer-domain/verify.sh"], scratch, env)
            if (zero.returncode == 0 or "did not run and pass" not in zero.stderr or
                    "test result: ok. 0 passed; 0 failed; 0 ignored;" not in zero.stdout):
                raise RuntimeError(f"zero-test result not rejected\n{zero.stdout}\n{zero.stderr}")
            print("zero-test runner result: rejected", flush=True)
            require_pass(run(["bash", "spec/formal/spiffe-peer-domain/verify.sh"], scratch, env), "restored suite")
    finally:
        for name, expected in live.items():
            if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
                raise RuntimeError(f"live source changed during scratch controls: {name}")
    print("ten implementation mutants, empty vectors, and a zero-test result rejected", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"spiffe-peer-domain-negative-controls: {error}", file=sys.stderr)
        sys.exit(1)
