export class ConflictError extends Error {
  override readonly name = "ConflictError";
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  constructor(message: string) {
    super(message);
  }
}
