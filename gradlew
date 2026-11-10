#!/bin/sh
# Copyright 2026 Tyler Kendrick
# SPDX-License-Identifier: MIT
#
# Repository-root Gradle launcher. This replaces the binary Gradle wrapper
# (removed so the tree carries no binary artifacts); it delegates to a
# system Gradle 8.13 on PATH, pointed at the Android project.
set -eu

# $0 may be a symlink, or a chain of them (for example a copy linked into a
# bin directory). Walk readlink and pwd -P until the path stops changing so
# APP_HOME is the repository root, not the link's directory.
app_path=$0
while :; do
  app_dir=$(CDPATH= cd -- "$(dirname -- "$app_path")" && pwd -P)
  resolved=$app_dir/$(basename -- "$app_path")
  if [ -h "$resolved" ]; then
    link=$(readlink "$resolved")
    case $link in
      /*) next=$link ;;
      *) next=$app_dir/$link ;;
    esac
  else
    next=$resolved
  fi
  if [ "$next" = "$app_path" ]; then
    break
  fi
  app_path=$next
done
APP_HOME=$(dirname -- "$app_path")

if ! command -v gradle >/dev/null 2>&1; then
  echo "gradlew: gradle 8.13 on PATH is required (https://gradle.org/install/)" >&2
  exit 1
fi

version=$(gradle --version 2>/dev/null | sed -n 's/^Gradle //p' | head -n 1)
case "$version" in
  8.13*) ;;
  *)
    echo "gradlew: expected Gradle 8.13, found '${version:-unknown}'" >&2
    exit 1
    ;;
esac

exec gradle --project-dir "$APP_HOME/apps/android/android" "$@"
