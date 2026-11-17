#!/usr/bin/env bash
# The pinned REST provider can log authentication headers when Terraform logs
# are enabled. Suppress Terraform's plugin logging for every invocation.
set -euo pipefail

for variable in "${!TF_LOG@}"; do
  unset "$variable"
done
unset REST_API_DEBUG
export TF_LOG=OFF

exec "${AGENT37_TERRAFORM_BIN:-terraform}" "$@"
