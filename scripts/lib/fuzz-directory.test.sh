#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fixture="$(mktemp -d /tmp/opensesame-fuzz-test.XXXXXXXX)"
ROOT="$fixture/checkout"
mkdir -p "$ROOT/scripts/lib" "$ROOT/tests/fuzz/cargo/corpus/example" "$ROOT/tests/fuzz/cargo/regressions/example"
cp "$HERE/audit-directory.sh" "$ROOT/scripts/lib/audit-directory.sh"
cp "$HERE/extract-fuzz-seeds.py" "$ROOT/scripts/lib/extract-fuzz-seeds.py"
mkdir -p "$ROOT/tests/fuzz/cargo/seed-archives"
python3 - "$ROOT/tests/fuzz/cargo/seed-archives/example.zip" <<'PYTHON'
import stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    info = zipfile.ZipInfo("a" * 40)
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    z.writestr(info, b"archived-seed")
PYTHON
git -C "$ROOT" init --quiet
git -C "$ROOT" add tests/fuzz/cargo/seed-archives/example.zip
printf public-seed > "$ROOT/tests/fuzz/cargo/corpus/example/seed"
printf public-regression > "$ROOT/tests/fuzz/cargo/regressions/example/seed"
git -C "$ROOT" add tests/fuzz/cargo/corpus/example/seed tests/fuzz/cargo/regressions/example/seed
printf unreviewed-input > "$ROOT/tests/fuzz/cargo/corpus/example/untracked"
unset OPENSESAME_AUDIT_DIR
source "$HERE/fuzz-directory.sh"
opensesame_fuzz_corpus example
[[ "$corpus" != "$ROOT/"* && "$(stat -c %a "$corpus")" == 700 ]]
[[ "$(cat "$corpus/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")" == archived-seed ]]
cmp "$ROOT/tests/fuzz/cargo/corpus/example/seed" "$corpus/corpus-seed"
cmp "$ROOT/tests/fuzz/cargo/regressions/example/seed" "$corpus/regression-seed"
[[ ! -e "$corpus/corpus-untracked" ]]
printf private-growth > "$corpus/growth"
[[ ! -e "$ROOT/tests/fuzz/cargo/corpus/example/growth" && ! -e "$ROOT/tests/fuzz/cargo/artifacts" ]]
if opensesame_fuzz_corpus ../escape; then exit 1; fi
python3 - "$fixture/invalid.zip" <<'PYTHON'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("../escape", "bad")
PYTHON
if python3 "$HERE/extract-fuzz-seeds.py" "$fixture/invalid.zip" "$fixture/invalid-output" 2>/dev/null; then exit 1; fi
[[ ! -e "$fixture/escape" ]]
for gate in fuzz-pr-gate.sh fuzz-batch.sh jazzer-gate.sh; do
  bash -n "$HERE/../fuzz/$gate"
done
for gate in fuzz-pr-gate.sh fuzz-batch.sh; do
  # CORPUS belongs to cargo-fuzz before '--', or it adds its writable default.
  grep -F -- 'fuzz run "$target" --fuzz-dir tests/fuzz/cargo "$corpus" --' "$HERE/../fuzz/$gate" >/dev/null
done
printf 'fuzz-directory contracts passed; private fixtures retained at %s\n' "$fixture"
# Exercise the real single-target runner with the committed archive. The shim
# records the corpus argument without requiring nightly Rust or cargo-fuzz.
repo="$(cd "$HERE/../.." && pwd)"
mkdir -p "$fixture/bin" "$fixture/audits"
chmod 700 "$fixture/audits"
cat > "$fixture/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == +nightly && "$2" == fuzz && "$3" == run && "$4" == capability_algebra && "$5" == --fuzz-dir && "$6" == tests/fuzz/cargo && "$8" == -- ]]
printf '%s' "$7" > "$FUZZ_TEST_CORPUS_PATH"
CARGO
chmod +x "$fixture/bin/cargo"
PATH="$fixture/bin:$PATH" OPENSESAME_AUDIT_DIR="$fixture/audits" FUZZ_TEST_CORPUS_PATH="$fixture/corpus-path" bash "$repo/scripts/fuzz/fuzz-one.sh" capability_algebra
python3 - "$(cat "$fixture/corpus-path")" <<'PYTHON'
import hashlib, pathlib, sys
# Computed independently from the 559 Git blobs at baseline 42414e648:
# SHA-256 of sorted (UTF-8 filename + NUL + raw SHA-256(content)).
expected = '5e80ce349ad6efdac3870f2c8765a6b58bbdf66fa7a2c70c3a41ce411f01dbef'
seeds = pathlib.Path(sys.argv[1])
paths = sorted(seeds.iterdir(), key=lambda p: p.name)
assert len(paths) == 559 and all(p.is_file() and not p.is_symlink() for p in paths)
digest = hashlib.sha256()
for p in paths:
    digest.update(p.name.encode() + b'\0' + hashlib.sha256(p.read_bytes()).digest())
assert digest.hexdigest() == expected, 'committed corpus inventory or bytes changed'
print('single-target runner exposes all 559 reviewed seeds directly to cargo-fuzz')
PYTHON
