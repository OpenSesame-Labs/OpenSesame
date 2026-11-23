import { isHostReceiptId } from "./receipt-outcome.js";

export interface FrozenIntentContext {
  intentId: string;
  intentDigest: string;
  operation: string;
  resource: string;
  audience: string;
  canonicalArguments: unknown;
  reservedReceiptId?: string;
}

/** Private recovery handles after uncertain delivery; never projected to agents. */
export interface PendingInvocationRecovery {
  intentId: string;
  intentDigest: string;
  operation: string;
  resource: string;
  audience: string;
  reservedReceiptId?: string;
}

export interface TaskContext {
  taskRunId: string;
  stateVersion: number;
  frozenIntent?: FrozenIntentContext;
  pendingInvocationRecovery?: PendingInvocationRecovery;
}

export interface TaskResponse {
  task_run_id?: string;
  state_version?: number;
}

export interface TaskUpdateOptions {
  adopt: boolean;
}

let current: TaskContext | null = null;

export function getTaskContext(): TaskContext | null {
  return current;
}

export function setTaskContext(ctx: TaskContext | null): void {
  current = ctx;
}

export function requireTaskRunId(): string {
  if (!current?.taskRunId) {
    throw new Error("task_context_required");
  }
  return current.taskRunId;
}

export function requireFrozenIntent(): FrozenIntentContext {
  if (!current?.frozenIntent) {
    throw new Error("frozen_intent_required");
  }
  return current.frozenIntent;
}

/** Forget a spent intent while staying on the same task. */
export function clearFrozenIntent(): void {
  if (!current) return;
  const { frozenIntent: _spent, ...rest } = current;
  current = rest;
}

/** Keep recovery material for intent-opening after dispatch begins. */
export function recordPendingInvocationRecovery(
  intent: FrozenIntentContext,
): void {
  if (!current) return;
  const pendingInvocationRecovery: PendingInvocationRecovery = {
    intentId: intent.intentId,
    intentDigest: intent.intentDigest,
    operation: intent.operation,
    resource: intent.resource,
    audience: intent.audience,
  };
  if (intent.reservedReceiptId !== undefined) {
    pendingInvocationRecovery.reservedReceiptId = intent.reservedReceiptId;
  }
  current = {
    ...current,
    pendingInvocationRecovery,
  };
}

export function noteReservedReceiptId(
  taskRunId: string,
  receiptId: string,
): void {
  if (!current || current.taskRunId !== taskRunId) return;
  if (!current.pendingInvocationRecovery) return;
  if (!isHostReceiptId(receiptId)) return;
  current = {
    ...current,
    pendingInvocationRecovery: {
      ...current.pendingInvocationRecovery,
      reservedReceiptId: receiptId,
    },
  };
}

/**
 * Adopt the task a response describes, or merely refresh the one already active.
 *
 * `adopt` belongs to the call that created the task. A read must not be able to
 * repoint the active context: `task_status` takes a task_run_id from the model,
 * and if reading someone else's task made it the current one, a look would become
 * a move.
 */
export function updateTaskFromResponse(
  body: TaskResponse,
  options: TaskUpdateOptions = { adopt: true },
): void {
  if (!body.task_run_id || body.state_version === undefined) {
    return;
  }
  if (!options.adopt && current?.taskRunId !== body.task_run_id) {
    return;
  }
  const next: TaskContext = {
    taskRunId: body.task_run_id,
    stateVersion: body.state_version,
  };
  if (current?.taskRunId === body.task_run_id) {
    if (current.frozenIntent) next.frozenIntent = current.frozenIntent;
    if (current.pendingInvocationRecovery) {
      next.pendingInvocationRecovery = current.pendingInvocationRecovery;
    }
  }
  current = next;
}
