import type { JsonObject } from "@opensesame/os-domain";
import type { LocalBackupTarget } from "./backup-target-local.js";

export type PutBackupTargetInput = {
  kind?: string;
  providerId?: string;
  connectionId?: string;
  integrationId?: string;
  installationId?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  enabled?: boolean;
  config?: JsonObject;
};

export function trimInput(value: string | undefined): string {
  if (value === undefined) return "";
  return value.trim();
}

function pickTrimmed(
  primary: string | undefined,
  fallback: string | undefined,
  defaultValue = "",
): string {
  const first = trimInput(primary);
  if (first !== "") return first;
  const second = trimInput(fallback);
  if (second !== "") return second;
  return defaultValue;
}

function pickNullable(
  primary: string | undefined,
  fallback: string | null | undefined,
): string | null {
  const first = trimInput(primary);
  if (first !== "") return first;
  if (fallback === undefined || fallback === null) return null;
  const second = fallback.trim();
  return second === "" ? null : second;
}

export function resolveProviderId(
  input: PutBackupTargetInput,
  kindHint: string,
): string {
  const fromInput = trimInput(input.providerId);
  if (fromInput !== "") return fromInput;
  if (kindHint === "git_remote") return "";
  return "github";
}

function assertBackupFields(
  kind: string,
  owner: string,
  repo: string,
  installationId: string,
  connectionId: string | null,
): void {
  if (owner === "" || repo === "") {
    throw new Error("Backup needs an owner/repo.");
  }
  if (kind === "github_app" && installationId === "") {
    throw new Error("Backup needs a GitHub App installation.");
  }
  if (kind === "git_remote" && connectionId === null) {
    throw new Error("Backup needs a git remote connection.");
  }
}

function pickEnabled(
  input: boolean | undefined,
  prior: boolean | undefined,
  kind: string,
): boolean {
  if (input !== undefined) return input;
  if (prior !== undefined) return prior;
  return kind !== "github_app";
}

function pickPriorString(prior: string | undefined, fallback: string): string {
  if (prior !== undefined && prior !== "") return prior;
  return fallback;
}

function pickPriorNullable(prior: string | null | undefined): string | null {
  if (prior === undefined) return null;
  return prior;
}

function pickConfig(
  input: JsonObject | undefined,
  prior: JsonObject | null | undefined,
): JsonObject | null {
  if (input !== undefined) return input;
  if (prior !== undefined && prior !== null) return prior;
  return null;
}

function sameBackupBinding(
  prior: LocalBackupTarget | null,
  next: LocalBackupTarget,
): boolean {
  if (!prior) return false;
  return (
    prior.kind === next.kind &&
    prior.providerId === next.providerId &&
    prior.connectionId === next.connectionId &&
    prior.integrationId === next.integrationId &&
    prior.installationId === next.installationId &&
    prior.owner === next.owner &&
    prior.repo === next.repo &&
    prior.branch === next.branch
  );
}

function withGithubBindingConfirmation(
  prior: LocalBackupTarget | null,
  next: LocalBackupTarget,
): LocalBackupTarget {
  if (next.kind === "github_app" && !sameBackupBinding(prior, next))
    return {
      ...next,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      pendingEvents: 0,
    };
  return next;
}

function buildBackupBinding(
  input: PutBackupTargetInput,
  previous: LocalBackupTarget | null,
  providerId: string,
  kind: string,
) {
  const installationId = pickTrimmed(
    input.installationId,
    previous?.installationId,
  );
  const connectionId = pickNullable(input.connectionId, previous?.connectionId);
  const owner = pickTrimmed(input.owner, previous?.owner);
  const repo = pickTrimmed(input.repo, previous?.repo);
  assertBackupFields(kind, owner, repo, installationId, connectionId);
  return {
    kind,
    providerId,
    connectionId,
    integrationId: pickTrimmed(input.integrationId, previous?.integrationId),
    installationId,
    owner,
    repo,
    branch: pickTrimmed(input.branch, previous?.branch, "main"),
  };
}

export function buildLocalBackupTarget(
  input: PutBackupTargetInput,
  prior: LocalBackupTarget | null,
  providerId: string,
  kind: string,
): LocalBackupTarget {
  const previous = prior?.kind === kind ? prior : null;
  const next: LocalBackupTarget = {
    ...buildBackupBinding(input, previous, providerId, kind),
    enabled: pickEnabled(input.enabled, previous?.enabled, kind),
    status: pickPriorString(previous?.status, "pending"),
    lastCommitSha: pickPriorNullable(previous?.lastCommitSha),
    lastSyncedAt: pickPriorNullable(previous?.lastSyncedAt),
    lastError: pickPriorNullable(previous?.lastError),
    config: pickConfig(input.config, previous?.config),
    pendingEvents: previous?.pendingEvents ?? 0,
  };
  return withGithubBindingConfirmation(prior, next);
}
