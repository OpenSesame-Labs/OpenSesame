/**
 * `@opensesame/wallet-budget` — pure budget journal for wallet spending
 * authority (Swarm LEDGER). No React, no network, no EVM.
 */

export {
  BUDGET_ERROR_CODES,
  BudgetError,
  type BudgetErrorCode,
  budgetErrorMessage,
} from "./errors.js";
export {
  type FeeExposureAssessment,
  type FeeExposureOk,
  type FeeExposureRefusal,
  reserveTransferAndFee,
  transferCapAllInLossLabel,
} from "./fee-exposure.js";
export type { BudgetJournal, JournalEntry } from "./journal.js";
export {
  type AllocateExclusiveInput,
  type AllocateExclusiveResult,
  type BudgetLedger,
  type BudgetLedgerTx,
  type OpenNodeInput,
  type ReserveInput,
  type SetCeilingInput,
  createBudgetLedger,
} from "./ledger.js";
export type { AttemptState, BudgetSnapshot, NodeState } from "./state.js";
export {
  type BudgetStore,
  type BudgetTx,
  InMemoryBudgetStore,
  createInMemoryBudgetStore,
} from "./store.js";
export {
  type AllocationStrategy,
  type AmountUnits,
  type BudgetNodeRef,
  type BudgetProjection,
  type HoldSlice,
  type PaymentAttemptId,
  type ReservationRecord,
  type ReservationState,
  assertAmountUnits,
  conserves,
  isAmountUnits,
  projectionTotal,
} from "./types.js";
