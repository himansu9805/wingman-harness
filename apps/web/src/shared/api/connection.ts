import type { Connection } from "../contracts/types";

export class ApiError extends Error {
  /** Preserve the HTTP status so callers can distinguish rejection from transport uncertainty. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const defaultConnection: Connection = { url: "/api" };
