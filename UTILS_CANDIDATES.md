# Utils candidates

Generic, non-AUT-specific helpers written in this repo that don't belong here —
they duplicate, or should be added alongside, functionality in `@controlium/utils`.
Logged here instead of just left inline so they get pulled out and added upstream
rather than forgotten. Add new candidates as they turn up.

## Add to `@controlium/utils`

Found reviewing `API_AUTWrapper.request()`'s completeness against
`APIUtils.HTTPRequest` — not missing helpers this time, missing *capability*
in `APIUtils.performHTTPOperation` itself that no amount of wrapper code in
this repo can work around:

- **Binary/multipart/raw-bytes request bodies are impossible.**
  `performHTTPOperation` always does `JSON.stringify(httpRequest.body)` for
  any non-string `body` (`APIUtils.js` — `const body = ... typeof
  httpRequest.body === 'string' ? httpRequest.body : JSON.stringify(httpRequest.body)`).
  There's no way to send a `Buffer`, a `FormData`/multipart payload, or any
  other raw byte content — every non-string body gets forced through JSON
  serialisation. A test suite for an AUT with a file-upload or
  binary-payload endpoint cannot exercise it through this framework at all.
- **No control over redirect-following.** `performHTTPOperation` hardcodes
  `redirect: 'follow'` in the underlying `fetch()` call. A test that wants to
  assert on a raw `3xx` response (status code, `Location` header) rather than
  the followed destination has no way to opt out.

Neither is fixable in `src/API_AUTWrapper.ts` — it just forwards whatever
`body`/request shape it's given straight to `performHTTPOperation`, so the
ceiling is set entirely by what that function accepts.

Separately, found reviewing the rest of `src/API_AUTWrapper.ts`'s private
helpers against the current `@controlium/utils` surface (2026-09-29):

- **`invokeHandler`'s generic core has no upstream equivalent.** Its own
  docstring already says "there's nothing AUT-specific here — it would work
  identically for any function," which is exactly this doc's own trigger
  condition for flagging something. It's more than `Utils.timeoutPromise`
  covers: validates the handler is callable first, catches a *synchronous*
  throw from invoking it (not just an async rejection) before the timeout
  race even starts, and funnels every failure path (not callable, threw,
  rejected, timed out) through one consistently-shaped message. A
  `funcName`/`paramName`-style upstream version (mirroring `assertType`'s own
  signature convention) would look roughly like:
  ```ts
  static async invokeWithTimeout<Args extends unknown[], Result>(
    handler: ((...args: Args) => Result | Promise<Result>) | undefined,
    funcName: string,
    paramName: string,
    timeoutMs: number,
    ...args: Args
  ): Promise<Result> {
    Utils.assertType(handler, 'function', funcName, paramName);
    let resultPromise: Promise<Result>;
    try {
      resultPromise = Promise.resolve((handler as (...args: Args) => Result | Promise<Result>)(...args));
    } catch (err) {
      const errText = `${funcName}: [${paramName}] threw: ${Utils.errorMessage(err)}`;
      Log.writeLine(LogLevels.Error, errText);
      throw new Error(errText);
    }
    return Utils.timeoutPromise(resultPromise, { timeoutMS: timeoutMs, friendlyName: paramName });
  }
  ```
  This repo's `invokeHandler` would then delegate to it (keeping the
  `appName`-aware `fail()` wrapping locally, same pattern as `requireObject`
  wrapping `assertShape`), rather than reimplementing the invoke-and-timeout
  logic itself.

- **`requireString`'s "no upstream equivalent" claim is only checked against
  `AssertShapeMap`, not against `assertType`.** `Utils.assertType(value,
  'string', funcName, paramName)` already does exactly "fails unless value is
  a string, empty allowed" — the same check `requireString` hand-rolls. This
  is the *same* open question as `requireFunction`'s entry below (both are
  blocked on a stated "double-logging" concern) — worth checking whether that
  concern actually holds, since `requireObject`/`requireNonEmptyString`/
  `requirePositiveNumber`/`requirePort` already delegate to `Utils.assertShape`
  as a single line with no `fail()` call after it and no double-log (`assertShape`
  logs-and-throws in one step, so there's nothing left to log again). The same
  one-line pattern looks like it would work identically for `requireFunction`/
  `requireString` delegating to `Utils.assertType` — flagging for
  re-examination rather than changing it, since this is a claim about *why*
  the code is written a certain way, not just what it does.

**Not a Utils candidate, despite looking like one at first:** the same
completeness review also turned up that `API_AUTWrapper.request()` doesn't
let a caller override `queryString`, `timeout`, or `proxy` per-request (only
session-level `aut.timeout`/`aut.proxy`, and no `queryString` support at
all). This is **not** missing from `@controlium/utils` — `APIUtils.HTTPRequest`
already has `queryString?: string`, `timeout?: number`, and `proxy?: string`
fields; `performHTTPOperation` already honours all three. It's purely a gap
in this repo's own `API_AUTWrapper.RequestOptions` interface not passing them
through. Logged here only so it isn't confused with the two genuine upstream
asks above — the fix for this one is adding three fields to `RequestOptions`
in `src/API_AUTWrapper.ts`, not touching `@controlium/utils` at all.

## Already exist in `@controlium/utils` — do not reimplement

Found while reviewing `src/API_AUTWrapper.ts` for what's actually generic. These
already covered functionality this repo had duplicated locally without checking
first:

- **`Utils.assertType(value, expectedType, funcName, paramName)`** — logged
  type-assertion helper, including a `'function'` case in `AssertTypeMap`.
  Very close to a hand-rolled `requireFunction()` in this repo. Still not
  adopted in place of `requireFunction` — calling it and then failing again
  ourselves via `fail()` would double-log the same failure. `requireFunction`
  stays as a thin, non-logging check; it now builds its message with
  `Utils.describeValue` (below) rather than a hand-rolled equivalent.
- **`Utils.timeoutPromise(promise, { timeoutMS, friendlyName })`** — races a
  promise against a timeout, with `Utils.promiseCount` tracking for
  end-of-test "did everything settle" checks. `src/API_AUTWrapper.ts`'s
  `invokeHandler` used to hand-roll the identical `Promise.race` + `setTimeout`
  + `clearTimeout` logic; now delegates to this directly (fixed 2026-09-29).
- **`Utils.describeValue(value)`** — safely describes an arbitrary value for
  inclusion in an error message; never throws. Landed in `@controlium/utils`
  1.0.2-alpha.7 and is now used directly by `assertType`'s own error message,
  and by this repo's `fail()` call sites and all the `require*` helpers above.
  Note: it deliberately **never** includes the value's own content (only
  type/shape) — content length is unbounded and may be sensitive, so this is a
  strict improvement over what this repo used to hand-roll, not just a dedupe
  (adopted 2026-09-29).
- **`Utils.errorMessage(err)`** — safely extracts a human-readable message
  from a caught value of unknown shape, without the `(err as Error).message`
  cast's `null`/`undefined` footgun. Landed in `@controlium/utils`
  1.0.2-alpha.7; this repo's private `errorMessage` was identical and has been
  deleted in favour of it (adopted 2026-09-29).
- **`Utils.assertShape(value, expectedShape, funcName, paramName)`** — landed
  2026-09-29, published as of `1.0.2-alpha.9`. Not the six separate
  `require*` functions originally proposed above — one sibling function to
  `Utils.assertType`, keyed by an `AssertShapeMap` (`'nonNullObject' |
  'nonEmptyString' | 'positiveNumber' | 'port'`), for the same reason
  `assertType` itself is one function keyed by a map rather than one function
  per JS type — collapses near-identical log/describe/throw boilerplate into
  one implementation instead of N. `requireObject`/`requireNonEmptyString`/
  `requirePositiveNumber`/`requirePort` in `src/API_AUTWrapper.ts` now delegate
  to it directly (adopted 2026-09-29, dependency bumped to `1.0.2-alpha.9`) —
  kept as same-named thin wrappers only so `requireObject` stays generic over
  `T` rather than widening to `assertShape`'s own `object`. One visible
  tradeoff from adopting it: `assertShape` logs-and-throws in one step (so
  wrapping it doesn't double-log), which means these four checks' error
  messages changed shape, from `[appName] port must be an integer between 1
  and 65535 — received ...` to `Cannot [appName] as [port] not a valid
  'port'. Is [...]` — `appName` is folded into `assertShape`'s `funcName` slot
  to stay traceable, but the wording is now visibly inconsistent with the
  checks that still go through this file's own `fail()` (see below).
  `requireString` was **not** ported — no upstream "any string, empty
  allowed" shape exists in `AssertShapeMap` (only `nonEmptyString`), and both
  its call sites (`resourcePath`, `resourcePathPreamble`) treat `''` as
  meaningfully different from "not provided." `requireProtocol` was **also
  not** ported — it's genuinely HTTP-domain-specific, not a generic shape, and
  `@controlium/utils`'s own `APIUtils.performHTTPOperation` now does this
  exact `'http'|'https'` check inline itself (2026-09-29) as domain-specific
  validation rather than a generic `Utils` primitive. Both stay private,
  `fail()`-based, and unchanged in `src/API_AUTWrapper.ts`.
- **`Utils.safeStringify(value, options?)`** — landed 2026-09-29, published as
  of `1.0.2-alpha.9`. Bounded-length (`options.maxLength`, default
  1000) and circular/`BigInt`-safe (falls back to `Utils.describeValue` on a
  `JSON.stringify` throw) — on **both** the success and failure paths, closing
  the gap this doc originally flagged (`safeStringifyHeaders`'s success path
  had no length cap at all). Lives on `Utils`, not `Logger` — `Logger` sits
  below `Utils` in the dependency graph and can't be imported back, exactly as
  predicted below. `safeStringifyHeaders` in `src/API_AUTWrapper.ts` has been
  deleted; `setHeaders`/`mergeHeaders` now call `Utils.safeStringify(headers)`
  directly (adopted 2026-09-29). One side effect: the old version pretty-printed
  with 2-space indentation (`JSON.stringify(headers, null, 2)`); `safeStringify`
  doesn't support an indent option, so header dumps in the log are now a
  single compact line rather than multi-line — traded for genuinely bounded,
  crash-safe output.

## Other changes in `@controlium/utils` relevant to this repo (not candidates)

Not local duplicates to port — genuine upstream changes to things this repo
already consumes, worth knowing about before the next dependency bump.

- **Node `>=22` is now enforced, not just documented.** As of `1.0.2-alpha.8`,
  `@controlium/utils` declares `"engines": { "node": ">=22" }` *and* throws
  immediately on import under an older runtime (an `engines` field alone only
  produces an install-time warning by default — this repo already requires
  Node 22+ in practice, so shouldn't be affected, but the enforcement is now
  real rather than assumed).
- **`APIUtils.performHTTPOperation`'s URL building got more correct**, as of
  `1.0.2-alpha.9`. `buildURL` switched from manual string concatenation
  (`.startsWith('/')`/`.endsWith('/')` checks) to Node's built-in `URL` class —
  fixes missing percent-encoding of special characters in `resourcePath`
  (e.g. a literal space previously produced an invalid raw URL string handed
  to `fetch`) and is now RFC-3986-conformant generally. This repo calls
  `performHTTPOperation` directly (`src/API_AUTWrapper.ts:545`), so this is a
  free correctness improvement on the next dependency bump — no code change
  needed here.

## Process going forward

Before writing a private helper in this repo that doesn't reference anything
AUT/test-framework-specific (no `Log`, no `appName`, no HTTP/transaction
concepts — just "given some input, produce some output"), check
`@controlium/utils` first (`Utils`, `JsonUtils`, `StringUtils`, `Logger`,
`APIUtils`, `Mock`). If it's not there and the helper really is generic, add
an entry to this file rather than just leaving it buried as a private
function — and consider whether it should go straight into `@controlium/utils`
instead of living here at all.
