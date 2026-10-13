export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Throws a 400 (or `status`) with a message the browser shows as-is. */
export function check(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new HttpError(status, message);
}

export function int(value: unknown, label: string, min: number, max: number): number {
  const n = Number(value);
  check(Number.isInteger(n) && n >= min && n <= max, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function num(value: unknown, label: string, min: number, max: number): number {
  const n = Number(value);
  check(Number.isFinite(n) && n >= min && n <= max, `${label} must be between ${min} and ${max}.`);
  return n;
}
