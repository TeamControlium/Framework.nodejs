import { Utils, Log, LogLevels } from '@controlium/utils';

/**
 * Every runtime argument guard `API_AUTWrapper` calls on its own constructor/setter/method
 * arguments before trusting them, plus the two generic building blocks everything else in
 * this file (and `_startAUT`/`_closeAUT`/`resolveURL`) is built from: {@link logAndThrow} and
 * {@link callHandlerWithTimeout}. Kept together because every one of these exists purely to
 * defend `API_AUTWrapper`'s own public surface against a caller passing the wrong shape —
 * a compile-time `string`/`object`/function type is a promise the compiler makes, never a
 * runtime guarantee, especially for a plain-JS consumer or one bypassing types with `any`.
 */

/**
 * Builds a `[appName] message` string, logs it at Error level, and throws it. The single
 * place every user-facing failure in `API_AUTWrapper` goes through, so wording/logging stays
 * consistent regardless of what failed.
 */
export function logAndThrow(appName: string, message: string): never {
  const errText = `[${appName}] ${message}`;
  Log.writeLine(LogLevels.Error, errText);
  throw new Error(errText);
}

/**
 * Generic guard: fails unless `value` is a non-null, non-array object — i.e. something it's
 * actually safe to spread or read named properties off. A `null`/array/primitive spreads
 * silently (`{...null}` → `{}`, `{...'ab'}` → `{0:'a',1:'b'}`) rather than throwing, which is
 * worse than a crash: it corrupts state quietly instead of telling the caller they made a
 * mistake.
 *
 * Delegates to `@controlium/utils`'s `Utils.assertShape` (added upstream 2026-09-29
 * specifically to absorb this and its siblings below — see `UTILS_CANDIDATES.md`) rather than
 * hand-rolling the check. `Utils.assertShape` logs and throws in one step, so — unlike
 * {@link logAndThrow}-based checks elsewhere in this file — there is no separate log call here
 * to double up with; the `appName` is folded into `assertShape`'s `funcName` argument (rendered
 * as `[appName]`) so the failure can still be traced to a specific AUT. Kept as a thin
 * same-named wrapper (rather than calling `Utils.assertShape` directly at every call site)
 * purely so callers keep the original generic type `T` — `assertShape`'s own
 * `AssertShapeMap['nonNullObject']` is the widened `object`, which would force a cast.
 */
export function requireNonNullObject<T extends object>(value: T | null | undefined, appName: string, label: string): asserts value is T {
  Utils.assertShape(value, 'nonNullObject', `[${appName}]`, label);
}

/**
 * Fails unless `value` is a `string` (empty allowed). No upstream equivalent: unlike its
 * siblings above/below, `@controlium/utils`'s `AssertShapeMap` has no permissive "any string,
 * including empty" entry — only `nonEmptyString` — so this one stays local and
 * {@link logAndThrow}-based rather than delegating. Deliberately permissive because both call
 * sites (`resourcePath`, `resourcePathPreamble`) treat `''` as meaningfully different from
 * "not provided", not as an error case.
 */
export function requireAnyString(value: unknown, appName: string, label: string): asserts value is string {
  if (typeof value !== 'string') {
    logAndThrow(appName, `${label} must be a string — received ${Utils.describeValue(value)}`);
  }
}

/** Fails unless `value` is a non-empty `string`. Delegates to `Utils.assertShape` — see {@link requireNonNullObject}. */
export function requireNonEmptyString(value: unknown, appName: string, label: string): asserts value is string {
  Utils.assertShape(value, 'nonEmptyString', `[${appName}]`, label);
}

/** Fails unless `value` is a finite number greater than zero. Delegates to `Utils.assertShape` — see {@link requireNonNullObject}. */
export function requirePositiveNumber(value: unknown, appName: string, label: string): asserts value is number {
  Utils.assertShape(value, 'positiveNumber', `[${appName}]`, label);
}

/** Fails unless `value` is an integer in the valid TCP port range (1–65535). Delegates to `Utils.assertShape` — see {@link requireNonNullObject}. */
export function requireValidPort(value: unknown, appName: string, label: string): asserts value is number {
  Utils.assertShape(value, 'port', `[${appName}]`, label);
}

/**
 * Fails unless `value` is exactly `'http'` or `'https'`. Stays local rather than delegating to
 * `Utils.assertShape` — this is genuinely HTTP-domain-specific (not a generic shape), and
 * `@controlium/utils`'s own `APIUtils.performHTTPOperation` now does this exact check inline
 * as domain-specific validation rather than a generic `Utils` primitive. See
 * `UTILS_CANDIDATES.md`.
 */
export function requireHttpOrHttps(value: unknown, appName: string, label: string): asserts value is 'http' | 'https' {
  if (value !== 'http' && value !== 'https') {
    logAndThrow(appName, `${label} must be 'http' or 'https' — received ${Utils.describeValue(value)}`);
  }
}

/**
 * Generic guard: fails unless `value` is callable. Knows nothing about what the value is
 * supposed to be — `label` is just text for the error message, and TypeScript gives no runtime
 * guarantee that a `value` typed as a function actually is one at runtime (a plain-JS
 * consumer, or one bypassing types with `any`, can pass anything — including `null`/`undefined`
 * explicitly, not just by omission).
 *
 * Deliberately does NOT delegate to `@controlium/utils`'s `Utils.assertType(value, 'function',
 * ...)`, even though that exists and does almost the same check — using it here would
 * double-log the failure, since `assertType` already calls `Log.writeLine` itself before
 * {@link logAndThrow} logs again.
 *
 * Currently only called for `API_AUTWrapper`'s three AUT lifecycle handlers (`bootstrapper`,
 * `closeHandler`, `getUrlHandler`), but there's nothing handler-specific about it.
 */
export function requireCallableFunction(value: unknown, appName: string, label: string): void {
  if (typeof value !== 'function') {
    logAndThrow(appName, `${label} must be a function — received ${Utils.describeValue(value)}`);
  }
}

/**
 * Generic defensive function invocation: verifies `handler` is callable, catches a synchronous
 * throw, and enforces `timeoutMs` in case it never resolves/rejects (e.g. a `close()` waiting
 * forever on a connection that never ends) — the timeout race itself is `@controlium/utils`'s
 * `Utils.timeoutPromise`, not reimplemented here. Every failure path — not a function, threw,
 * rejected, or timed out — goes through {@link logAndThrow}, so callers always get a
 * `[appName] label ...` error with enough detail to know what happened. There's nothing
 * AUT-specific here — it would work identically for any function.
 *
 * `args` is forwarded to `handler` as-is — a handler may take one argument, several, or none;
 * this doesn't assume any particular arity. `handler`'s declared type only exists to let
 * `Args`/`Result` be inferred from the real handler type at each call site — at runtime it's
 * treated as `unknown` and verified by {@link requireCallableFunction}, since the actual value
 * may not match its declared type at all (a consumer can pass anything, including past
 * `any`/casts).
 *
 * Currently only called for `API_AUTWrapper`'s three AUT lifecycle handlers (`bootstrapper`,
 * `closeHandler`, `getUrlHandler`) — see the call sites in `_startAUT`, `_closeAUT`, and
 * `resolveURL`.
 */
export async function callHandlerWithTimeout<Args extends unknown[], Result>(
  handler: ((...args: Args) => Result | Promise<Result>) | undefined,
  appName: string,
  label: string,
  timeoutMs: number,
  ...args: Args
): Promise<Result> {
  requireCallableFunction(handler, appName, label);
  const fn = handler as (...args: Args) => Result | Promise<Result>;

  let resultPromise: Promise<Result>;
  try {
    resultPromise = Promise.resolve(fn(...args));
  } catch (err) {
    logAndThrow(appName, `${label} threw: ${Utils.errorMessage(err)}`);
  }

  try {
    return await Utils.timeoutPromise(resultPromise, { timeoutMS: timeoutMs, friendlyName: label });
  } catch (err) {
    logAndThrow(appName, `${label} threw: ${Utils.errorMessage(err)}`);
  }
}
