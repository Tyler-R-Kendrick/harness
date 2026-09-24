export type Result<T, C extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: C; readonly message: string } };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<C extends string>(code: C, message: string): { readonly ok: false; readonly error: { readonly code: C; readonly message: string } } {
  return { ok: false, error: { code, message } };
}
