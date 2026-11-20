#!/usr/bin/env bash
# Prepare a musl C toolchain without changing the runner's installed packages.
# Hosted Ubuntu provides gcc. musl-tools is not on the image. The extracted
# musl-gcc specs point at /usr, so rewrite them into this directory.
set -euo pipefail
umask 077

command -v gcc >/dev/null
command -v python3 >/dev/null
command -v dpkg-deb >/dev/null
command -v apt-get >/dev/null

if [[ "$(uname -m)" != "x86_64" ]]; then
  printf 'prepare-musl.sh: expected x86_64, found %s\n' "$(uname -m)" >&2
  exit 1
fi

musl_root="${1:?usage: prepare-musl.sh <owned-output-directory>}"
mkdir -p "$musl_root"
musl_root="$(cd "$musl_root" && pwd -P)"
mkdir -p "$musl_root"/{lists/partial,cache/archives/partial,conf.d,log,packages,sysroot,bin}
printf 'Dir::Etc::parts "%s/conf.d";\n#clear APT::Update::Post-Invoke;\n#clear APT::Update::Post-Invoke-Success;\n' \
  "$musl_root" > "$musl_root/apt.conf"
apt_options=(
  -c "$musl_root/apt.conf"
  -o "Dir::State::lists=$musl_root/lists"
  -o "Dir::Cache=$musl_root/cache"
  -o "Dir::Log=$musl_root/log"
  -o "Dir::Etc::parts=$musl_root/conf.d"
  -o "APT::Sandbox::User=$(id -un)"
  -o "APT::Get::AllowUnauthenticated=false"
  -o "Acquire::AllowInsecureRepositories=false"
)
# The runner's configured sources and trusted keyrings still authenticate
# Release metadata and package hashes. System apt hooks are not executed.
APT_CONFIG="$musl_root/apt.conf" apt-get "${apt_options[@]}" update
# Download the same package set `install --no-install-recommends musl-tools`
# would resolve (musl-tools depends on musl-dev, which depends on musl).
# `apt-get download` usually writes into the current directory. On Ubuntu 26.04
# (resolute) runners apt may exit nonzero and leave archives under the sandbox
# cache instead of cwd — collect from both locations (same hermetic extract).
download_status=0
set +e
(
  cd "$musl_root/packages"
  APT_CONFIG="$musl_root/apt.conf" apt-get "${apt_options[@]}" download musl musl-dev musl-tools
)
download_status=$?
set -e
if ! compgen -G "$musl_root/packages/*.deb" >/dev/null \
  && ! compgen -G "$musl_root/cache/archives/*.deb" >/dev/null; then
  set +e
  APT_CONFIG="$musl_root/apt.conf" apt-get "${apt_options[@]}" \
    install --download-only --no-install-recommends -y musl-tools
  download_status=$?
  set -e
fi
shopt -s nullglob
musl_archives=("$musl_root/packages"/*.deb "$musl_root/cache/archives"/*.deb)
shopt -u nullglob
if ((${#musl_archives[@]} == 0)); then
  printf 'prepare-musl.sh: musl .deb missing under packages/ and cache/archives (apt exit %s)\n' \
    "$download_status" >&2
  exit 1
fi
for musl_archive in "${musl_archives[@]}"; do
  dpkg-deb --extract "$musl_archive" "$musl_root/sysroot"
done

triplet="x86_64-linux-musl"
specs="$musl_root/sysroot/usr/lib/$triplet/musl-gcc.specs"
test -f "$specs"
test -f "$musl_root/sysroot/usr/include/$triplet/stdio.h"
test -f "$musl_root/sysroot/usr/lib/$triplet/libc.a"
# Noble ships ld-musl under /lib; resolute's musl 1.2.5 records it under /usr/lib.
ld_musl="$musl_root/sysroot/lib/ld-musl-x86_64.so.1"
if [[ ! -e "$ld_musl" ]]; then
  ld_musl="$musl_root/sysroot/usr/lib/ld-musl-x86_64.so.1"
fi
test -f "$ld_musl"
python3 - "$specs" "$musl_root/sysroot" "$triplet" "$ld_musl" <<'PY'
from pathlib import Path
import sys
specs, sysroot, triplet, ld_musl = sys.argv[1:]
path = Path(specs)
text = path.read_text()
text = text.replace(f"/usr/include/{triplet}", f"{sysroot}/usr/include/{triplet}")
text = text.replace(f"/usr/lib/{triplet}", f"{sysroot}/usr/lib/{triplet}")
text = text.replace(
    "-dynamic-linker /lib/ld-musl-x86_64.so.1",
    f"-dynamic-linker {ld_musl}",
)
if " /usr/include/" in text or " /usr/lib/" in text or "-dynamic-linker /lib/" in text:
    raise SystemExit("musl specs still point at the system root")
path.write_text(text)
PY

gnu_gcc=$(command -v x86_64-linux-gnu-gcc || true)
if [[ -z "$gnu_gcc" ]]; then
  gnu_gcc=$(command -v gcc)
fi
gnu_gcc_q=$(printf '%q' "$gnu_gcc")
specs_q=$(printf '%q' "$specs")
cat > "$musl_root/bin/musl-gcc" <<EOF
#!/bin/sh
exec ${gnu_gcc_q} "\$@" -specs ${specs_q}
EOF
chmod 0755 "$musl_root/bin/musl-gcc"

printf 'int main(void){return 0;}\n' > "$musl_root/smoke.c"
"$musl_root/bin/musl-gcc" -static -o "$musl_root/smoke" "$musl_root/smoke.c"
"$musl_root/smoke"
ldd_out=$(ldd "$musl_root/smoke" 2>&1 || true)
case "$ldd_out" in
  *ld-linux*|*libc.so.6*)
    printf 'musl smoke binary is linked to glibc: %s\n' "$ldd_out" >&2
    exit 1
    ;;
esac
rm -f "$musl_root/smoke" "$musl_root/smoke.c"

printf 'export PATH=%q"${PATH:+:$PATH}"\n' "$musl_root/bin" > "$musl_root/env.sh"
printf 'export CC_x86_64_unknown_linux_musl=%q\n' "$musl_root/bin/musl-gcc" >> "$musl_root/env.sh"
printf 'export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=%q\n' \
  "$musl_root/bin/musl-gcc" >> "$musl_root/env.sh"
printf 'musl toolchain ready; source %s/env.sh for the build.\n' "$musl_root"
