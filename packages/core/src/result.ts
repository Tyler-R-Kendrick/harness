export type Result<T, C extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: C; readonly message: string } };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/** Every error must explain itself: the message reaches clients and logs. */
export function err<C extends string>(code: C, message: string): { readonly ok: false; readonly error: { readonly code: C; readonly message: string } } {
  if (message === "") throw new Error(`error ${code} needs a message`);
  return { ok: false, error: { code, message } };
}
