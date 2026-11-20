"""Check reviewed authority sources and their bounded Cargo inputs."""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import re
import stat
import sys
import tempfile

root = Path(__file__).resolve().parents[3]

paths = [
    "crates/domain/Cargo.toml",
    "crates/domain/src/grant.rs",
    "crates/domain/src/grant_attenuation.rs",
    "crates/domain/src/grant_budgets.rs",
    "crates/domain/src/grant_lineage.rs",
    "crates/domain/src/ids.rs",
    "crates/time/Cargo.toml",
    "crates/time/README.md",
    "crates/time/src/datetime.rs",
    "crates/time/src/duration.rs",
    "crates/time/src/error.rs",
    "crates/time/src/format.rs",
    "crates/time/src/lib.rs",
    "crates/time/src/naive.rs",
    "crates/time/src/sqlx.rs",
    "crates/time/src/datetime/traits.rs",
    "crates/time/src/datetime/utc.rs",
    "crates/time/tests/compatibility.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/.cargo_vcs_info.json",
    "patches/vendor/sqlx-sqlite-0.9.0/Cargo.toml",
    "patches/vendor/sqlx-sqlite-0.9.0/Cargo.toml.orig",
    "patches/vendor/sqlx-sqlite-0.9.0/LICENSE-APACHE",
    "patches/vendor/sqlx-sqlite-0.9.0/LICENSE-MIT",
    "patches/vendor/sqlx-sqlite-0.9.0/src/any.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/arguments.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/column.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/database.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/error.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/lib.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/logger.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/migrate.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/query_result.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/regexp.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/row.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/transaction.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/type_checking.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/type_info.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/value.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/collation.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/describe.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/deserialize.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/establish.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/execute.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/executor.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/explain.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/handle.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/intmap.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/mod.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/preupdate_hook.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/connection/worker.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/options/auto_vacuum.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/options/connect.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/options/journal_mode.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/options/locking_mode.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/options/mod.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/options/parse.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/options/synchronous.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/statement/handle.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/statement/mod.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/statement/unlock_notify.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/statement/virtual.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/testing/mod.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/bool.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/bytes.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/chrono.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/float.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/int.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/json.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/mod.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/str.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/text.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/time.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/uint.rs",
    "patches/vendor/sqlx-sqlite-0.9.0/src/types/uuid.rs",
    "crates/domain/src/lib.rs",
    "spec/formal/authority/Cargo.toml",
    "spec/formal/authority/Cargo.lock",
    "spec/formal/authority/conformance.rs",
    "scripts/security/formal-cargo-isolation.py",
    "scripts/security/formal-cargo-freshness.py",
    "scripts/security/cargo-lock-projection.py",
    "scripts/security/cargo-workspace-projection.py",
]
root_package = "opensesame-domain"
TARGETS = {
    "crates/domain/Cargo.toml": {
        "package": "opensesame-domain", "lib": ("opensesame_domain", "src/lib.rs"),
    },
    "spec/formal/authority/Cargo.toml": {
        "package": "opensesame-formal-authority", "bin": {"authority-conformance": "conformance.rs"},
    },
}
crate_root_wiring_digest = "8b3f3bc845cc0ca24b75080aaf5c0143cb938104a9873801fbc53bb1a277f999"
# A build script can read or generate additional, otherwise unmapped sources.
# Enabling one requires a separately reviewed verifier and coverage extension.
reviewed_build_script_sha256 = None


def load_projection(verified):
    # The workspace helper imports its sibling. Give it only the two byte
    # arrays already checked against coverage, without ambient bytecode.
    with tempfile.TemporaryDirectory(prefix="opensesame-authority-helpers-") as directory:
        isolated = Path(directory)
        for name in ("cargo-lock-projection.py", "cargo-workspace-projection.py"):
            (isolated / name).write_bytes(verified[f"scripts/security/{name}"])
        helper = isolated / "cargo-workspace-projection.py"
        spec = importlib.util.spec_from_file_location("cargo_workspace_projection", helper)
        if spec is None or spec.loader is None:
            raise ValueError("workspace projection helper is unavailable")
        sys.dont_write_bytecode = True
        projection = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = projection
        exec(compile(verified["scripts/security/cargo-workspace-projection.py"],
                     str(helper), "exec", dont_inherit=True), projection.__dict__)
        return projection


def crate_root_tokens(source):
    # The crate root currently uses plain module declarations. Reject syntax
    # that could hide or generate a redirect instead of guessing at Rust ASTs.
    code = []
    index = 0
    depth = 0
    while index < len(source):
        if source.startswith("//", index):
            end = source.find("\n", index)
            index = len(source) if end < 0 else end
        elif source.startswith("/*", index):
            depth = 1
            index += 2
            while depth and index < len(source):
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise ValueError("unterminated crate root comment")
            code.append(" ")
        else:
            if source[index] in "\"'!":
                raise ValueError("unsupported crate root syntax for module wiring")
            code.append(source[index])
            index += 1
    return re.findall(r"[A-Za-z_][A-Za-z_0-9]*|\S", "".join(code))


def check_module_wiring(source):
    tokens = crate_root_tokens(source)
    encoded = json.dumps(tokens, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    if sha256(encoded).hexdigest() != crate_root_wiring_digest:
        raise ValueError("crate root module wiring tokens changed; review mappings first")
    top = []
    depth = 0
    for token in tokens:
        if token == "{":
            if depth == 0:
                top.append(token)
            depth += 1
        elif token == "}":
            depth -= 1
            if depth < 0:
                raise ValueError("malformed crate root scopes")
            if depth == 0:
                top.append(token)
        elif depth == 0:
            top.append(token)
    if depth:
        raise ValueError("malformed crate root scopes")
    names = ["frozen_intent", "grant", "grant_attenuation", "grant_budgets", "grant_lineage", "ids", "intent"]
    expected = [token for name in names for token in ("pub", "mod", name, ";")]
    matches = sum(top[i:i + len(expected)] == expected for i in range(len(top)))
    if matches != 1:
        raise ValueError("authority module wiring is not the reviewed canonical layout")


def check_crate_paths(package_document):
    package = package_document.get("package")
    if not isinstance(package, dict):
        raise ValueError("domain package manifest is malformed")
    build = package.get("build", True)
    if type(build) is not bool and build != "build.rs":
        raise ValueError("unsupported domain build-script path; extend reviewed mappings first")
    library = package_document.get("lib", {})
    if not isinstance(library, dict) or library.get("path", "src/lib.rs") != "src/lib.rs":
        raise ValueError("unsupported domain library path; extend reviewed mappings first")


def verify_harness_dependencies(production, harness):
    production_root = production.select(root_package)
    harness_root = harness.select(root_package)
    production_by_name = {}
    for dependency in production.edges[production_root]:
        production_by_name.setdefault(dependency.name, []).append(dependency)
    for dependency in harness.edges[harness_root]:
        matches = production_by_name.get(dependency.name, [])
        if (len(matches) != 1 or matches[0] != dependency or
                production.packages[matches[0]].checksum != harness.packages[dependency].checksum):
            raise ValueError(f"harness direct dependency differs from production: {dependency.name}")


def verify(manifest):
    if (not isinstance(manifest, dict) or manifest.get("version") != 2 or
            not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("reviewed_revision", ""))) or
            not isinstance(manifest.get("sources"), list) or
            any(not isinstance(entry, dict) or set(entry) != {"path", "sha256"} or
                not isinstance(entry["sha256"], str) or
                not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
                for entry in manifest["sources"]) or
            [entry["path"] for entry in manifest["sources"]] != paths):
        raise ValueError("invalid coverage manifest")
    verified = {}
    for entry in manifest["sources"]:
        path = root / entry["path"]
        for parent in path.parents:
            if parent == root:
                break
            if parent.is_symlink() or not parent.is_dir():
                raise ValueError(f"source path is not a regular directory: {entry['path']}")
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError(f"source is not a regular file: {entry['path']}")
        source = path.read_bytes()
        if sha256(source).hexdigest() != entry["sha256"]:
            raise ValueError(f"source drift in {entry['path']}")
        verified[entry["path"]] = source
    optional = manifest.get("optional_sources")
    if (not isinstance(optional, list) or len(optional) != 1 or
            not isinstance(optional[0], dict) or set(optional[0]) != {"path", "sha256"} or
            optional[0]["path"] != "crates/domain/build.rs" or
            (optional[0]["sha256"] is not None and
             (not isinstance(optional[0]["sha256"], str) or
              not re.fullmatch(r"[0-9a-f]{64}", optional[0]["sha256"])) )):
        raise ValueError("invalid optional source coverage")
    build = root / optional[0]["path"]
    if build.is_symlink() or (build.exists() and not stat.S_ISREG(build.lstat().st_mode)):
        raise ValueError("domain build script is not a regular file")
    build_hash = sha256(build.read_bytes()).hexdigest() if build.exists() else None
    if optional[0]["sha256"] != build_hash:
        raise ValueError("source drift in crates/domain/build.rs")
    if build_hash != reviewed_build_script_sha256:
        raise ValueError("domain build script requires separately reviewed verifier coverage")
    helper_name = "scripts/security/formal-cargo-isolation.py"
    scope = {"__name__": "reviewed_cargo_isolation", "__file__": str(root / helper_name)}
    exec(compile(verified[helper_name], scope["__file__"], "exec", dont_inherit=True), scope)
    scope["check_cargo_targets"](root, TARGETS, set(verified))
    projection = load_projection(verified)
    check_crate_paths(projection.read_toml(root / "crates/domain/Cargo.toml"))
    check_module_wiring((root / "crates/domain/src/lib.rs").read_text())
    graph = projection.lock_projection.read_lock(root / "Cargo.lock")
    lock = manifest.get("lock_projection")
    expected_lock = {
        "root": root_package,
        "algorithm": "cargo-lock-projection-v1-sha256",
        "sha256": projection.lock_projection.projection_sha256(graph, root_package),
    }
    if lock != expected_lock:
        raise ValueError("reviewed domain dependency graph drift")
    harness_graph = projection.lock_projection.read_lock(root / "spec/formal/authority/Cargo.lock")
    verify_harness_dependencies(graph, harness_graph)
    workspace = manifest.get("workspace_projection")
    document = projection.read_projection(root / "Cargo.toml", root / "crates/domain/Cargo.toml",
                                          root / "Cargo.lock", root_package, "crates/domain")
    expected_workspace = {
        "root": root_package,
        "package": "crates/domain/Cargo.toml",
        "algorithm": "cargo-workspace-projection-v1-sha256",
        "sha256": projection.digest(document),
    }
    if workspace != expected_workspace:
        raise ValueError("reviewed domain workspace inputs drift")


def main():
    try:
        manifest = json.loads((root / "spec/formal/authority/coverage.json").read_text())
        verify(manifest)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"authority-formal: {exc}; review the model before updating coverage.json") from exc
    print(f"authority-formal: covered sources and Cargo inputs match reviewed revision {manifest['reviewed_revision']}")


if __name__ == "__main__":
    main()
