#!/usr/bin/env python3
"""Test selector correspondence and runner guards against scratch mutations."""
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
SELECTOR = Path("crates/gateway/src/transport/source_trust_selection.rs")
REVIEWED_PATCHES = ("sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0",)  # verify.sh's --reviewed-patch
CORRESPONDENCE = "transport::boot::source_trust_selection::formal::lean_vectors_match_source_trust_selection"
EXACT = "transport::boot::source_trust_selection::formal::returns_exact_requested_source_bundle"


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

def rustc_wrapper(directory: Path, name: str) -> str:
    wrapper = directory / name
    wrapper.write_text('#!/bin/sh\nexec "$@"\n')
    wrapper.chmod(0o700)
    return str(wrapper.resolve())

def archive(destination: Path, fds: tuple[int, ...] = (), nats: bool = False) -> None:
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
    suite = Path("spec/formal/source-trust-selection")
    coverage = scratch_path(ROOT, str(suite / "coverage.json"))
    if coverage.is_symlink() or not coverage.is_file():
        raise RuntimeError("unreviewed scratch coverage path")
    manifest = json.loads(coverage.read_text())
    if nats:
        manifest = manifest["nats"]
    paths = [entry["path"] for entry in manifest["sources"] + manifest["optional_sources"]]
    paths += ["Cargo.lock", "rust-toolchain.toml", "spec/formal/check-axioms.sh",
              "spec/formal/required-theorem-command.lean"]
    for command in (["git", "diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
                    ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
        names = subprocess.run(command, cwd=ROOT, check=True, stdout=subprocess.PIPE).stdout.split(b"\0")
        paths.extend(os.fsdecode(name) for name in names if name)
    for name in dict.fromkeys(paths):
        source = scratch_path(ROOT, name)
        target = scratch_path(destination, name)
        if source.is_symlink():
            raise RuntimeError(f"unexpected symlink in {name}")
        if not source.exists():
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.exists():
                raise RuntimeError(f"unexpected scratch target in {name}")
            continue
        if not source.is_file() or target.is_symlink():
            raise RuntimeError(f"unexpected scratch source in {name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def require_pass(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        raise RuntimeError(f"{label}: failed ({result.returncode})\n{(result.stdout + result.stderr)[-6000:]}")
    print(f"{label}: passed", flush=True)

def require_failure(result: subprocess.CompletedProcess[str], test: str, diagnostic: str, label: str) -> None:
    output = result.stdout + result.stderr
    if not (result.returncode == 101 and f"test {test} ... FAILED" in output and diagnostic in output):
        raise RuntimeError(f"{label}: unexpected result ({result.returncode})\n{output[-6000:]}")
    print(f"{label}: rejected", flush=True)


def cargo_test(scratch: Path, env: dict[str, str], name: str, helper: dict,
               ignored: bool = False) -> subprocess.CompletedProcess[str]:
    command = ["cargo", "test", "--locked", "-p", "opensesame-gateway", "--lib", name, "--"]
    if ignored:
        command.append("--ignored")
    command.append("--exact")
    return helper["checked_cargo"](scratch, env, ["opensesame-gateway"],
                                   Path("spec/formal/source-trust-selection/check-drift.py"), command[1:], reviewed_patches=REVIEWED_PATCHES)


def nats_controls() -> None:
    env = os.environ.copy() | {"CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true", "OPENSESAME_FORMAL_NATS": "1",
                               "OPENSESAME_MTLS_FIXTURES": "1"}
    env.pop("OPENSESAME_FORMAL_SCRATCH_LOCK_FD", None)
    env.setdefault("OPENSESAME_MTLS_FIXTURE_DIR", str(ROOT / ".cache/mtls-fixtures"))
    lean = env.get("OPENSESAME_LEAN_BIN", "lean")
    require_pass(run([sys.executable, "-I", str(ROOT / "spec/formal/source-trust-selection/test_snapshot.py")], ROOT, env),
                 "NATS scratch snapshot controls")
    require_pass(run([sys.executable, "-I", str(ROOT / "spec/formal/source-trust-selection/test_drift.py"), "--nats"], ROOT, env),
                 "NATS scratch drift controls")
    require_pass(run(["bash", "scripts/mtls/mtls-fixtures.sh", "verify", "nats-server"], ROOT, env),
                 "pinned NATS fixture")
    listing = run(["bash", "scripts/mtls/mtls-fixtures.sh", "list"], ROOT, env)
    require_pass(listing, "fixture listing")
    rows = [line.split("\t") for line in listing.stdout.splitlines() if line.startswith("nats-server\t")]
    if len(rows) != 1 or len(rows[0]) != 6:
        raise RuntimeError("verified NATS fixture path is unavailable")
    env["OPENSESAME_MTLS_BIN_NATS_SERVER"] = str(Path(rows[0][2]).resolve())
    env["OPENSESAME_MTLS_FIXTURE_DIR"] = str(Path(env["OPENSESAME_MTLS_FIXTURE_DIR"]).resolve())
    checker, coverage = Path("spec/formal/source-trust-selection/check-drift.py"), Path("spec/formal/source-trust-selection/coverage.json")
    require_pass(run([sys.executable, "-I", str(checker), "--nats"], ROOT, env), "reviewed NATS baseline")
    live_helper = ROOT / "scripts/security/formal-cargo-isolation.py"
    lifecycle = {"__name__": "formal_cargo_isolation", "__file__": str(live_helper)}
    exec(compile(live_helper.read_bytes(), str(live_helper), "exec", dont_inherit=True), lifecycle)
    connection, rotation = "crates/task-bus/src/nats_connect.rs", "crates/task-bus/src/nats_rotation.rs"
    transport, env_source = "crates/task-bus/src/nats_transport.rs", "crates/task-bus/src/nats_transport_env.rs"
    verifier, bounded, client = "crates/transport-security/src/verify_spiffe.rs", "crates/transport-security/src/bounded.rs", "crates/transport-security/src/client.rs"
    targets = [connection, rotation, transport, env_source, verifier, bounded, client]
    live = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in targets}
    correspondence, identity = "nats::live_mixed::lean_vectors_match_nats_injection", "nats::live_roles::injected_kind_and_identity_must_match_configured_policy"
    client_svid = "nats::live_tests::injected_spiffe_client_matches_locator_and_profile"
    runtime, crls = "nats::live_delivery::accepted_material_and_view_follow_serialized_rotations", "nats::live_topology::injected_trust_enforces_configured_crls"
    env_test, flags = "nats::tests::security_bearing_env_settings_never_select_plaintext", "validate::tests::invalid_nats_security_booleans_fail_closed"
    downgrade = "validate::tests::explicit_plaintext_flag_cannot_disable_security_settings"
    health, conflicts = "tests::failed_and_old_connections_cannot_change_active_health", "tests::contradictory_nats_security_sources_are_refused"
    locators, stored_test = "tests::mutated_public_policy_cannot_ignore_security_locators", "tests::stored_tls_requirements_cannot_resolve_to_plaintext"
    reconnect, retry = "nats::live_routes::injected_sessions_fence_reconnect_and_rotation", "nats_transport_env::tests::nonassertive_env_cannot_override_stored_tls"
    retry_limit, drain = "validate::tests::lean_vectors_match_nats_reconnect_limit", "nats::rotation::tests::pending_old_session_drain_cannot_block_rotation"
    try:
        with lifecycle["scratch_checkout"](ROOT) as lease:
            scratch = lease.path
            env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(lease.lock_fd)
            archive(scratch, (lease.lock_fd,), nats=True)
            shared_target = Path(env.get("CARGO_TARGET_DIR", str(scratch / "shared-target")))
            env["CARGO_TARGET_DIR"] = str((ROOT / shared_target).resolve())
            require_pass(run([sys.executable, "-I", str(checker), "--nats"], scratch, env), "reviewed NATS scratch")
            helper_path = scratch / "scripts/security/formal-cargo-isolation.py"
            helper = {"__name__": "formal_cargo_isolation", "__file__": str(helper_path)}
            exec(compile(helper_path.read_bytes(), str(helper_path), "exec", dont_inherit=True), helper)
            drift_path = scratch / "spec/formal/source-trust-selection/test_drift.py"
            drift = {"__name__": "formal_drift_controls", "__file__": str(drift_path)}
            exec(compile(drift_path.read_bytes(), str(drift_path), "exec", dont_inherit=True), drift)
            runner = ["bash", "spec/formal/source-trust-selection/verify.sh", "--nats"]
            require_pass(run(runner, scratch, env), "unmodified NATS suite")
            model, vectors = str(scratch / "spec/formal/source-trust-selection/SourceTrustSelection.lean"), scratch / "vectors.tsv"
            generated = run(["bash", "spec/formal/check-axioms.sh", lean, model], scratch, env | {"OPENSESAME_NATS_VECTOR_MODE": "source"})
            require_pass(generated, "NATS vector generation")
            vectors.write_text(generated.stdout)
            client_result = run(["bash", "spec/formal/check-axioms.sh", lean, model], scratch, env | {"OPENSESAME_NATS_VECTOR_MODE": "client-svid"})
            require_pass(client_result, "client SVID vector generation")
            client_rows, client_vectors = client_result.stdout.splitlines(), scratch / "client-vectors.tsv"
            if len(client_rows) != 4: raise RuntimeError("unexpected client SVID vector count")
            client_vectors.write_text(client_result.stdout)
            handshake_result = run(["bash", "spec/formal/check-axioms.sh", lean, model], scratch, env | {"OPENSESAME_NATS_VECTOR_MODE": "handshake-fence"})
            require_pass(handshake_result, "handshake fence vector generation")
            handshake_rows, handshake_vectors = handshake_result.stdout.splitlines(), scratch / "handshake-vectors.tsv"
            if len(handshake_rows) != 2: raise RuntimeError("unexpected handshake vector count")
            handshake_vectors.write_text(handshake_result.stdout)
            retry_result = run(["bash", "spec/formal/check-axioms.sh", lean, model], scratch, env | {"OPENSESAME_NATS_VECTOR_MODE": "retry-limit"}); require_pass(retry_result, "retry vector generation")
            retry_rows, retry_vectors = retry_result.stdout.splitlines(), scratch / "retry-vectors.tsv"; retry_vectors.write_text(retry_result.stdout)
            if len(retry_rows) != 8: raise RuntimeError("unexpected retry vector count")
            invalid_mode = run(["bash", "spec/formal/check-axioms.sh", lean, model], scratch, env | {"OPENSESAME_NATS_VECTOR_MODE": "invalid"})
            if invalid_mode.returncode == 0 or "unsupported NATS vector mode" not in (invalid_mode.stdout + invalid_mode.stderr): raise RuntimeError("invalid NATS vector mode was not rejected")
            test_env = env | {"OPENSESAME_SOURCE_SELECTION_VECTORS": str(vectors), "OPENSESAME_NATS_CLIENT_VECTORS": str(client_vectors), "OPENSESAME_NATS_HANDSHAKE_VECTORS": str(handshake_vectors), "OPENSESAME_NATS_RETRY_VECTORS": str(retry_vectors)}
            mutations = [
                ("single-use handshake fence bypassed", bounded, [("self.used.swap(true, Ordering::AcqRel)", "self.used.swap(false, Ordering::AcqRel)")], reconnect, True, "spent handshake reconnected"),
                ("TLS resumption bypasses fence", client, [("config.resumption = Resumption::disabled();", "config.resumption = Resumption::default();")], reconnect, True, "spent handshake reconnected"),
                ("injected identity reconnects", connection, [("injected.trust.is_some() || injected.identity.is_some()", "injected.trust.is_some()")], reconnect, True, "spent handshake reconnected"),
                ("injected trust reconnects", connection, [("injected.trust.is_some() || injected.identity.is_some()", "injected.identity.is_some()")], reconnect, True, "spent handshake reconnected"),
                ("retry-only environment ignored", env_source, [("if max_reconnects.is_some() {", "if false {")], retry, False, "retry-only environment must be refused"),
                ("nonassertive environment silently selects plaintext", env_source, [("if !require_tls && require_flag.is_none() {", "if false {")], retry, False, "nonassertive environment must be refused"),
                ("injected reconnect cap ignored", transport, [("    if injected {\n        Some(1)\n    } else {\n        requested\n    }", "    if injected {\n        requested\n    } else {\n        requested\n    }")], retry_limit, True, "retry limit correspondence"),
                ("ordinary reconnect limit changed", transport, [("    if injected {\n        Some(1)\n    } else {\n        requested\n    }", "    if injected {\n        Some(1)\n    } else {\n        Some(1)\n    }")], retry_limit, True, "retry limit correspondence"),
                ("NATS connector ignores cap", connection, [(".max_reconnects(reconnect_limit(injected_session, spec.max_reconnects))", ".max_reconnects(reconnect_limit(false, spec.max_reconnects))")], reconnect, True, "reconnects did not terminate at the configured limit"),
                ("old-session drain not bounded", rotation, [("tokio::time::timeout(Duration::from_secs(2), drain).await", "tokio::time::timeout(Duration::from_secs(10), drain).await")], drain, False, "old drain exceeded its bound"),
                ("wrong profile accepted", connection, [("trust.profile().name != reference.name", "false")], correspondence, True, "environment vector"),
                ("wrong kind accepted", connection, [("trust.kind() != reference.kind", "false")], identity, False, "loaded trust kind must match the public policy"),
                ("PEM trust injection accepted", connection, [("if matches!(locator, Some(NativeTrustSpec::PemFile { .. })) {", "if false {")], identity, False, "PEM trust locator must reject injection even if matching"),
                ("PEM identity injection accepted", connection, [("        (Some(_), Some(NativeIdentitySpec::PemFiles { .. }), _) => {\n            return Err(TransportError::EnforcementUnsupported)\n        }\n", "")], identity, False, "PEM identity locator must reject injection"),
                ("wrong configured domain accepted", connection, [("bundle.spiffe_trust_domain() != Some(trust_domain.as_str())", "false")], correspondence, True, "environment vector"),
                ("stored expected domain ignored", verifier, [("|| expected.trust_domain().as_str() != domain", "|| false")], correspondence, True, "stored vector"),
                ("unrequested identity accepted", connection, [("injected.identity.is_some() && spec.transport.client_identity.is_none()", "false")], identity, False, "unrequested identity must not be presented"),
                ("wrong client SPIFFE ID accepted", connection, [("if expected.is_some_and(|expected| id.to_string() != expected) {", "if false {")], client_svid, True, "configured client ID and SVID profile"),
                ("invalid client SVID profile accepted", connection, [(".map_err(|_| TransportError::IdentityMissing)?;\n    Ok(())", ".map_err(|_| TransportError::IdentityMissing).ok();\n    Ok(())")], client_svid, True, "configured client ID and SVID profile"),
                ("stored client SVID profile ignored", connection, [("            check_spiffe_client(identity, None)?;\n", "")], client_svid, True, "stored SPIFFE identity requires a valid SVID profile"),
                ("implicit material lost", rotation, [("injected.unwrap_or_else(|| self.accepted().injected.clone())", "injected.unwrap_or_default()")], runtime, True, "implicit rotation"),
                ("concurrent openings overlap", rotation, [("let rotation = self.rotations.lock().await;", "let rotation = ();")], runtime, True, "a later opening ran before the older rotation committed"),
                ("delayed connection loses history", rotation, [("            accepted.saw_connected |= prior.saw_connected;\n", "")], health, False, "delayed event"),
                ("configured revocation ignored", connection, [('let with_crls = trust.with_crls(&pem)?;\n            if with_crls.crls().len() == prior_count {\n                return Err(TransportError::malformed("configured CRL file is empty"));\n            }\n            if with_crls.crls().len() > 1 {\n                return Err(TransportError::EnforcementUnsupported);\n            }\n            with_crls', 'let with_crls = trust.clone().with_crls(&pem)?;\n            if with_crls.crls().len() == prior_count {\n                return Err(TransportError::malformed("configured CRL file is empty"));\n            }\n            if with_crls.crls().len() > 1 {\n                return Err(TransportError::EnforcementUnsupported);\n            }\n            trust')], crls, True, "configured CRL revokes server"),
                ("truncated CRL silently discarded", connection, [("            check_crl_pem_envelopes(&pem)?;\n", "")], crls, True, "truncated CRL before another BEGIN must be refused"),
                ("multiple configured CRLs accepted", connection, [("if with_crls.crls().len() > 1 {", "if false {")], crls, True, "multiple configured CRLs must be refused"),
                ("multiple injected CRLs accepted", connection, [("if trust.crls().len() > 1 {", "if false {")], crls, True, "multiple injected CRLs must be refused"),
                ("empty configured CRL accepted", connection, [('            check_crl_pem_envelopes(&pem)?;\n            let with_crls = trust.with_crls(&pem)?;\n            if with_crls.crls().len() == prior_count {\n                return Err(TransportError::malformed("configured CRL file is empty"));\n            }\n', '            let with_crls = trust.with_crls(&pem)?;\n')], crls, True, "empty CRL refused"),
                ("missing configured CRL accepted", connection, [('            let pem = std::fs::read(path)\n                .map_err(|error| TransportError::malformed(format!("crl file: {error}")))?;\n            check_crl_pem_envelopes(&pem)?;\n            let with_crls = trust.with_crls(&pem)?;\n            if with_crls.crls().len() == prior_count {\n                return Err(TransportError::malformed("configured CRL file is empty"));\n            }\n', '            let pem = std::fs::read(path).unwrap_or_default();\n            let with_crls = trust.with_crls(&pem)?;\n')], crls, True, "missing CRL refused"),
                ("stored trust allows plaintext", transport, [("|| self.transport.server_trust.is_some()", "|| false")], stored_test, False, "assertion failed"),
                ("stored server name allows plaintext", transport, [("|| self.transport.server_name.is_some()", "|| false")], stored_test, False, "assertion failed"),
                ("stored minimum allows plaintext", transport, [("|| self.transport.min_version != TlsVersion::Tls13", "|| false")], stored_test, False, "assertion failed"),
                ("identity locator kind mismatch accepted", transport, [("identity.kind != identity_kind(locator)", "false")], identity, False, "identity locator kind must match the public policy"),
                ("trust locator kind mismatch accepted", transport, [("trust.kind != trust_kind(locator)", "false")], identity, False, "trust locator kind must match the public policy"),
                ("PEM trust kind misreported", env_source, [("NativeTrustSpec::PemFile { kind, .. } => *kind", "NativeTrustSpec::PemFile { .. } => TrustProfileKind::WebPkiDns")], identity, False, "PEM trust kind must be represented accurately"),
                ("SPIFFE trust kind misreported", env_source, [("NativeTrustSpec::SpiffeTrustDomain { .. } => TrustProfileKind::SpiffeTrustDomain", "NativeTrustSpec::SpiffeTrustDomain { .. } => TrustProfileKind::PrivateRoot")], correspondence, True, "SPIFFE trust kind must be represented accurately"),
                ("PEM identity kind misreported", env_source, [("NativeIdentitySpec::PemFiles { .. } => IdentitySourceKind::PemFiles", "NativeIdentitySpec::PemFiles { .. } => IdentitySourceKind::ManagedCertificate")], identity, False, "PEM identity kind must be represented accurately"),
                ("managed identity kind misreported", env_source, [("NativeIdentitySpec::ManagedCertificate { .. } => IdentitySourceKind::ManagedCertificate", "NativeIdentitySpec::ManagedCertificate { .. } => IdentitySourceKind::PemFiles")], identity, False, "managed identity kind must be represented accurately"),
                ("SPIFFE identity kind misreported", env_source, [("NativeIdentitySpec::Spiffe { .. } => IdentitySourceKind::SpiffeWorkloadApi", "NativeIdentitySpec::Spiffe { .. } => IdentitySourceKind::ManagedCertificate")], conflicts, False, "SPIFFE identity kind must be represented accurately"),
                ("anonymous policy ignores credential locator", transport, [("if self.locators.nkey_seed_file.is_some() || self.locators.creds_file.is_some() =>", "if false =>")], locators, False, "credential locator must not be silently ignored"),
                ("creds policy ignores nkey locator", transport, [("NatsAuth::Creds { .. } if self.locators.nkey_seed_file.is_some()", "NatsAuth::Creds { .. } if false")], locators, False, "credential locator kind must match the public policy"),
                ("nkey policy ignores creds locator", transport, [("NatsAuth::Nkey { .. } if self.locators.creds_file.is_some()", "NatsAuth::Nkey { .. } if false")], locators, False, "nkey policy must not ignore a creds locator"),
                ("plaintext policy ignores CRL locator", transport, [("|| self.locators.crl_file.is_some()", "|| false")], locators, False, "CRL locator must not be silently ignored"),
                ("plaintext policy ignores provisioning locator", transport, [("|| self.locators.provision.is_some()", "|| false")], locators, False, "provisioning credential locator must not be silently ignored"),
                ("server expectation allows plaintext", env_source, [("|| server.is_some()\n            || explicit_min_version\n            || auth.is_some()\n            || provision.is_some();", "|| false\n            || explicit_min_version\n            || auth.is_some()\n            || provision.is_some();")], downgrade, False, "security setting must imply TLS"),
                ("invalid TLS flag becomes false", env_source, [('Some(_) => Err(malformed(format!("{name} is not a valid boolean"))),', 'Some(_) => Ok(false),')], flags, False, "invalid security flag must be refused"),
                ("explicit minimum allows plaintext", env_source, [("|| explicit_min_version\n            || auth.is_some()\n            || provision.is_some();", "|| false\n            || auth.is_some()\n            || provision.is_some();")], downgrade, False, "security setting must imply TLS"),
                ("configured CRL allows plaintext", env_source, [("|| crl_file.is_some()\n            || server.is_some()\n            || explicit_min_version\n            || auth.is_some()\n            || provision.is_some();", "|| false\n            || server.is_some()\n            || explicit_min_version\n            || auth.is_some()\n            || provision.is_some();")], downgrade, False, "security setting must imply TLS"),
                ("identity name without source accepted", env_source, [("identity_name.is_some() || identity_companion", "identity_companion")], env_test, False, "identity name without its source must fail closed"),
                ("identity companion without source accepted", env_source, [("identity_name.is_some() || identity_companion", "identity_name.is_some()")], env_test, False, "without its source must fail closed"),
                ("trust name without source accepted", env_source, [("trust_name.is_some() && trust.is_none()", "false")], env_test, False, "trust name without its source must fail closed"),
                ("credential companion without source accepted", env_source, [("if seed.is_some() || creds.is_some() =>", "if false =>")], env_test, False, "without its source must fail closed"),
                ("conflicting identity sources accepted", env_source, [("if identity_conflict {", "if false {")], conflicts, False, "conflicting NATS source must be refused"),
                ("conflicting trust sources accepted", env_source, [("if trust_conflict {", "if false {")], conflicts, False, "conflicting NATS source must be refused"),
                ("nkey and creds accepted together", env_source, [("Some(\"nkey\") if creds.is_some()", "Some(\"nkey\") if false")], conflicts, False, "conflicting NATS source must be refused"),
                ("creds and nkey accepted together", env_source, [("Some(\"creds\") if seed.is_some()", "Some(\"creds\") if false")], conflicts, False, "conflicting NATS source must be refused"),
                ("provisioning credential allows plaintext", env_source, [("|| auth.is_some()\n            || provision.is_some();", "|| auth.is_some()\n            || false;")], downgrade, False, "security setting must imply TLS"),
            ]
            for label, name, edits, test, ignored, diagnostic in mutations:
                if len(edits) != 1:
                    raise RuntimeError(f"{label}: expected one declared replacement")
                before, after = edits[0]
                with helper["mutated_coverage"](
                    scratch, coverage, Path(name), before, after, checker, section="nats", env=env,
                ):
                    command = ["test", "--locked", "-p", "opensesame-task-bus", "--features", "live-tests", "--lib", test, "--"]
                    if ignored:
                        command.append("--ignored")
                    command.append("--exact")
                    result = helper["checked_cargo"](scratch, test_env, ["opensesame-task-bus"], checker, command, reviewed_patches=REVIEWED_PATCHES)
                    require_failure(result, test, diagnostic, label)
                    if label == "wrong profile accepted":
                        live_result = helper["checked_cargo"](ROOT, test_env, ["opensesame-task-bus"], checker, command, reviewed_patches=REVIEWED_PATCHES)
                        output = live_result.stdout + live_result.stderr
                        if (live_result.returncode != 0 or f"test {test} ... ok" not in output or
                                "test result: ok. 1 passed; 0 failed; 0 ignored;" not in output):
                            raise RuntimeError(f"live source reused scratch mutant\n{output[-6000:]}")
                        print("live correspondence in shared target after scratch mutant: passed", flush=True)
            vectors.write_text("")
            command = ["test", "--locked", "-p", "opensesame-task-bus", "--features", "live-tests", "--lib", correspondence, "--", "--ignored", "--exact"]
            result = helper["checked_cargo"](scratch, test_env, ["opensesame-task-bus"], checker, command, reviewed_patches=REVIEWED_PATCHES)
            require_failure(result, correspondence, "incomplete selector vector matrix", "empty NATS vectors")
            client_command = ["test", "--locked", "-p", "opensesame-task-bus", "--features", "live-tests", "--lib", client_svid, "--", "--ignored", "--exact"]
            for label, client_case, diagnostic in [
                ("empty client vectors", [], "incomplete client SVID vector matrix"), ("missing client vector", client_rows[:-1], "incomplete client SVID vector matrix"),
                ("duplicate client input", [client_rows[0], *client_rows], "duplicate client SVID input"), ("malformed client output", [client_rows[0].rsplit("\t", 1)[0] + "\tbogus", *client_rows[1:]], "invalid formal vector bit"),
            ]:
                client_vectors.write_text("\n".join(client_case) + ("\n" if client_case else ""))
                result = helper["checked_cargo"](scratch, test_env, ["opensesame-task-bus"], checker, client_command, reviewed_patches=REVIEWED_PATCHES)
                require_failure(result, client_svid, diagnostic, label)
            client_vectors.write_text(client_result.stdout)
            handshake_command = ["test", "--locked", "-p", "opensesame-task-bus", "--features", "live-tests", "--lib", reconnect, "--", "--ignored", "--exact"]
            for label, case, diagnostic in [("empty handshake vectors", [], "missing fresh handshake vector"), ("missing handshake vector", handshake_rows[:1], "missing spent handshake vector"), ("duplicate handshake vector", [handshake_rows[0], *handshake_rows], "duplicate handshake vector"), ("malformed handshake vector", ["handshake-fence\t0\tbogus", *handshake_rows[1:]], "invalid handshake vector")]:
                handshake_vectors.write_text("\n".join(case) + ("\n" if case else ""))
                result = helper["checked_cargo"](scratch, test_env, ["opensesame-task-bus"], checker, handshake_command, reviewed_patches=REVIEWED_PATCHES)
                require_failure(result, reconnect, diagnostic, label)
            handshake_vectors.write_text(handshake_result.stdout)
            drift["retry_vector_controls"](scratch, test_env, helper, checker, retry_rows, retry_vectors, retry_limit, require_failure)
            with helper["mutated_coverage"](scratch, coverage, Path("crates/task-bus/src/nats_live_mixed.rs"),
                "async fn lean_vectors_match_nats_injection() {", "async fn renamed_nats_injection_correspondence() {",
                checker, section="nats", env=env):
                zero = run(runner, scratch, env)
            if (zero.returncode == 0 or "did not run and pass" not in zero.stderr or
                    "test result: ok. 0 passed; 0 failed; 0 ignored;" not in zero.stdout):
                raise RuntimeError(f"zero-test NATS result not rejected\n{zero.stdout}\n{zero.stderr}")
            print("zero-test NATS runner result: rejected", flush=True)
            drift["fixture_controls"](scratch, env, runner, rows, run)
            require_pass(run(runner, scratch, env), "restored NATS suite")
    finally:
        for name, expected in live.items():
            if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
                raise RuntimeError(f"live source changed while scratch controls ran: {name}")
    print(f"{len(mutations)} NATS mutants, invalid vectors, zero tests, and missing/corrupt fixtures rejected", flush=True)


def main() -> None:
    env = os.environ.copy() | {"CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true"}
    env.pop("OPENSESAME_FORMAL_SCRATCH_LOCK_FD", None)
    env.update({"OPENSESAME_FORMAL_NATS": "0", "OPENSESAME_NATS_VECTOR_MODE": "source"})
    lean = env.get("OPENSESAME_LEAN_BIN", "lean")
    if shutil.which("cargo") is None or shutil.which(lean) is None:
        raise RuntimeError("activate the pinned Rust and Lean toolchains first")
    require_pass(run([sys.executable, "-I", str(ROOT / "spec/formal/source-trust-selection/test_snapshot.py")], ROOT, env),
                 "scratch snapshot controls")
    require_pass(run([sys.executable, "-I", "spec/formal/source-trust-selection/check-drift.py"], ROOT, env),
                 "reviewed live baseline")
    live_helper = ROOT / "scripts/security/formal-cargo-isolation.py"
    lifecycle = {"__name__": "formal_cargo_isolation", "__file__": str(live_helper)}
    exec(compile(live_helper.read_bytes(), str(live_helper), "exec", dont_inherit=True), lifecycle)
    original_hash = hashlib.sha256((ROOT / SELECTOR).read_bytes()).hexdigest()
    try:
        with lifecycle["scratch_checkout"](ROOT) as lease:
            scratch = lease.path
            env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(lease.lock_fd)
            archive(scratch, (lease.lock_fd,))
            require_pass(run([sys.executable, "-I", "spec/formal/source-trust-selection/check-drift.py"],
                             scratch, env), "reviewed scratch baseline")
            wrapper = subprocess.check_output(
                [sys.executable, "-I", str(scratch / "scripts/security/formal-cargo-isolation.py"), str(scratch)],
                text=True, pass_fds=(lease.lock_fd,),
            ).strip()
            env |= {"RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": wrapper}
            helper_path = scratch / "scripts/security/formal-cargo-isolation.py"
            helper = {"__name__": "formal_cargo_isolation", "__file__": str(helper_path)}
            exec(compile(helper_path.read_bytes(), str(helper_path), "exec", dont_inherit=True), helper)
            require_pass(run(["bash", "spec/formal/source-trust-selection/verify.sh"], scratch, env),
                         "unmodified suite")
            result = run(["bash", "spec/formal/check-axioms.sh", lean,
                          str(scratch / "spec/formal/source-trust-selection/SourceTrustSelection.lean")], scratch, env)
            require_pass(result, "vector generation")
            vectors = scratch / "vectors.tsv"
            vectors.write_text(result.stdout)
            test_env = env | {"OPENSESAME_SOURCE_SELECTION_VECTORS": str(vectors)}
            target = scratch / SELECTOR
            original = target.read_text()
            mutations = [
                ("wrong source entry", ".get(profile)", ".values().next()", EXACT, False, "TrustUnknown"),
                ("wrong kind accepted", "kind == TrustProfileKind::SpiffeTrustDomain", "true", CORRESPONDENCE, True, "selector predicate"),
                ("wrong profile accepted", "actual_profile == profile", "true", CORRESPONDENCE, True, "selector predicate"),
                ("stale source hidden", "source?", "source.unwrap_or_default()", CORRESPONDENCE, True, "GenerationStale"),
            ]
            for label, before, after, name, ignored, diagnostic in mutations:
                if original.count(before) != 1:
                    raise RuntimeError(f"{label}: mutation target is not unique")
                with helper["mutated_coverage"](
                    scratch, Path("spec/formal/source-trust-selection/coverage.json"),
                    SELECTOR, before, after, Path("spec/formal/source-trust-selection/check-drift.py"),
                    env=env,
                ):
                    require_failure(cargo_test(scratch, test_env, name, helper, ignored), name, diagnostic, label)
            vectors.write_text("")
            require_failure(cargo_test(scratch, test_env, CORRESPONDENCE, helper, True), CORRESPONDENCE,
                            "incomplete selector vector matrix", "empty vector matrix")
            with helper["mutated_coverage"](
                scratch, Path("spec/formal/source-trust-selection/coverage.json"),
                Path("crates/gateway/src/transport/source_trust_selection_formal.rs"),
                "fn lean_vectors_match_source_trust_selection() {",
                "fn renamed_source_selection_correspondence() {",
                Path("spec/formal/source-trust-selection/check-drift.py"),
                env=env,
            ):
                zero = run(["bash", "spec/formal/source-trust-selection/verify.sh"], scratch, env)
            if (zero.returncode == 0 or "required selector correspondence did not run and pass" not in zero.stderr or
                    "test result: ok. 0 passed; 0 failed; 0 ignored;" not in zero.stdout):
                raise RuntimeError(f"zero-test control not rejected\n{zero.stdout}\n{zero.stderr}")
            print("zero-test runner result: rejected", flush=True)
            require_pass(run(["bash", "spec/formal/source-trust-selection/verify.sh"], scratch, env),
                         "restored suite")
    finally:
        if hashlib.sha256((ROOT / SELECTOR).read_bytes()).hexdigest() != original_hash:
            raise RuntimeError("live selector changed while scratch controls ran")
    print("four implementation mutants, empty vectors, and a zero-test result rejected", flush=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--nats"]:
            nats_controls()
        elif not sys.argv[1:]:
            main()
        else:
            raise RuntimeError("expected no arguments or --nats")
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"source-trust-selection-negative-controls: {error}", file=sys.stderr)
        sys.exit(1)
