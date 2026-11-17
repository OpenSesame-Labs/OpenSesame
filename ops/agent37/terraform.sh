#!/usr/bin/env bash
# The pinned REST provider can log authentication headers when Terraform logs
# are enabled. Suppress Terraform's plugin logging for every invocation.
set -euo pipefail

for variable in "${!TF_LOG@}"; do
  unset "$variable"
done
# Only the bearer key belongs to this configuration. Other provider defaults
# inherited from a shell can disable TLS verification or change API methods.
for variable in "${!REST_API_@}"; do
  if [[ "$variable" != REST_API_BEARER ]]; then
    unset "$variable"
  fi
done
export TF_LOG=OFF

# Version 3.0.0 imports objects with request debugging enabled in state.
# Refuse that command before starting Terraform so an accidental import cannot
# create an unsafe state that exposes the bearer key in a later invocation.
for argument in "$@"; do
  case "$argument" in
    -chdir=*) continue ;;
    import)
      printf '%s\n' 'Agent37: terraform import is disabled because REST provider 3.0.0 enables request debugging. See ops/agent37/README.md for recovery guidance.' >&2
      exit 2
      ;;
    *) break ;;
  esac
done

exec "${AGENT37_TERRAFORM_BIN:-terraform}" "$@"
