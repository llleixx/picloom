export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}
export class Conflict extends AppError {
  constructor(message = "Record conflicts with current data") {
    super("CONFLICT", message, 409);
  }
}
export function requireValue<T>(
  value: T | null | undefined,
  message = "Not found",
): T {
  if (value == null) throw new AppError("NOT_FOUND", message, 404);
  return value;
}

/** Task errors are codes, with optional failure context for a pipeline step. */
export function taskFailure(value: string | null): {
  code: string | null;
  step?: { id: string; name: string };
} {
  return value?.startsWith("{") ? JSON.parse(value) : { code: value };
}
