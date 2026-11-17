export class ProvisionalSessionEpochChangedError extends Error {
  override readonly name = "ProvisionalSessionEpochChangedError";

  constructor() {
    super("The principal session epoch changed during publication.");
  }
}
