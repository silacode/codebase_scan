import { constants as HTTP } from 'node:http2';

// Domain error: `code` for clients, `status` for the HTTP response, `retryable` marks
// errors the scan/queue may retry.
export class ScanError extends Error {
  code: string;
  retryable: boolean;
  status: number;
  constructor(
    code: string,
    message: string,
    retryable = false,
    status: number = HTTP.HTTP_STATUS_SERVICE_UNAVAILABLE,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** True when the error chain carries PostgreSQL unique_violation (SQLSTATE 23505). */
export function uniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && current.code === '23505') return true;
  }
  return false;
}
