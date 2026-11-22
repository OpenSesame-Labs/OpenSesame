/** A drive answered with something other than the expected protocol. */
export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

/** How long a drive request may wait for response headers. */
export const DRIVE_TIMEOUT_MS = 15_000;
