# Architecture overview — design discussion

**Status:** draft for discussion, not a spec. Nothing here is implemented
beyond what's noted as "exists today." This is the big picture; see
[test-runner-interface.md](./test-runner-interface.md) for Layer 4 in detail.

## The four layers

```
Layer 1  @controlium/utils              — exists today
Layer 2  @controlium/framework          — exists today (API-only so far)
Layer 3  Browser interaction plugins    — not started
Layer 4  Test-runner layer              — not started (design only, see test-runner-interface.md)
```

### Layer 1 — `@controlium/utils`

Lowest level, as tool-agnostic as possible. Already exists: `Log`, `JsonUtils`,
`StringUtils`, `APIUtils`, `Mock`, general `Utils` primitives.

**`Mock` is already a proven example of the pattern this whole document is
built around**, worth understanding precisely before designing Layer 3:
`Mock` never intercepts a request itself. Its entry point,
`Mock.processInterceptedRequest(request)`, takes a plain, tool-agnostic
`{ url, method, headers, body }` object that *something else* has already
captured, evaluates it against registered listeners (JSONPath matchers), and
returns a decision: `{ action: 'fulfill', response }`, `{ action: 'block' }`,
or — in delegate mode — `{ action: 'passthrough', correlationId }` for the
caller to fetch for real and report back via `Mock.completePassthrough()`.
Even in local mode, when `Mock` *does* fetch a real response itself for a
`passthrough` listener, that's a plain `fetch()` call — not interception. The
interception (catching a request before it would naturally leave) is always
someone else's job: Playwright's `page.route()`, MSW's listener, or hand-rolled
WebDriver JS injection all feed `Mock` the same way.

So the "give every tool a common interface" pattern this document proposes
for Layer 3 already exists, fully realised, for the *mocking decision* piece
specifically — `Mock.Request`/`Mock.Response`/`Mock.InterceptResult` are that
common interface, and any browser plugin's mocking responsibility reduces to:
bridge its tool's native interception mechanism to `Mock.processInterceptedRequest`,
then translate the returned decision back into that tool's own native
fulfil/abort/continue call. What's genuinely new work for Layer 2/3 is the
*general* browser-interaction contract (navigate, click, type, screenshot,
wait) — `Mock` doesn't touch any of that.

### Layer 2 — `@controlium/framework`

Launches and works with AUTs. Exists today: `API_AUTWrapper`. Will grow a
browser-based equivalent — call it `Browser_AUTWrapper` for now, matching the
predecessor framework's naming — for an AUT that's:

- **Locally launched**, the browser equivalent of what `API_AUTWrapper`
  already does for an API app (start it, get its URL, stop it).
- **Remote** — point a browser at an already-running, non-localhost address,
  with no launch/teardown responsibility at all.

A single test suite can mix AUT types with independent lifecycles — e.g. one
long-lived, suite-scoped browser AUT started once at `beforeSuite`, alongside
API AUTs started and stopped dynamically within individual tests. Nothing
about this requires new design *here*: `API_AUTWrapper` already supports
multiple simultaneous, independently-lifecycled instances (see its own JSDoc
"Multiple simultaneous AUTs" example) — a `Browser_AUTWrapper` instance
coexisting alongside one or more `API_AUTWrapper` instances is the same
pattern, just with two different AUT *kinds* rather than several of the same
kind.

**Layer 2 owns the Layer 3 contract.** The framework defines the minimal
interface any browser-interaction tool needs a plugin to satisfy (navigate,
click, type, screenshot, wait — exact shape TBD when this work actually
starts), and handles all the calling/use of that interface itself —
mirroring exactly how `API_AUTWrapper` already defines and calls its own
`Bootstrapper`/`CloseHandler`/`GetUrlHandler` contract for API apps. Plugins
(Layer 3) are the ones implementing it, one per tool.

Layer 2 also owns the plain `beforeSuite`/`afterSuite`/`beforeTest`/`afterTest`
functions from [test-runner-interface.md](./test-runner-interface.md) — the
seam Layer 4 calls into.

### Layer 3 — Browser interaction plugins (not started)

Separate packages, one per underlying browser-automation tool (Playwright,
WebDriver, possibly others later), each implementing Layer 2's common
interaction interface. This is where the tools' actual capabilities diverge
sharply enough that a shared interface is *necessary*, not just convenient:

- **Interaction itself** — Playwright and WebDriver have structurally
  different APIs for the same actions (click, type, wait). A plugin's job is
  translating Layer 2's calls into whatever its specific tool needs.
- **Mocking** — a plugin bridges its tool's native interception mechanism (or
  lack of one) to `Mock.processInterceptedRequest` (Layer 1) and applies the
  returned decision back through the tool's own fulfil/abort/continue API.
  Playwright's `page.route()` is a natural fit for this. WebDriver has no
  native interception at all — that plugin would need to inject client-side
  JS (e.g. monkey-patching `fetch`/`XMLHttpRequest` in-page, or a Service
  Worker) just to get a capture point before it can call into `Mock` at all.

### Layer 4 — Test-runner layer (not started; design only)

See [test-runner-interface.md](./test-runner-interface.md) for the detailed
design. In short: wraps/depends on Layer 2, does test-runner-specific
hook-wiring plus (optionally) a reusable step-definition/test-authoring
library (e.g. a `cucumber-tc`-style package), and exposes an extension point
for a consuming test suite to plug in whichever Layer 3 browser plugin it
wants — without Layer 4 itself needing to know Playwright from WebDriver.

## Why Layer 2↔3 gets a formal interface but Layer 2↔4 doesn't

Worth being explicit about this, since it could look inconsistent otherwise.
[test-runner-interface.md](./test-runner-interface.md) deliberately rejected
a formal interface between the framework and test runners, in favour of four
plain functions — because literally every mainstream JS test runner already
accepts an arbitrary callback for hook registration. There was nothing for an
interface to standardise; the runners are already uniform at the one point
that matters.

Browser-automation tools are not uniform at the point that matters. Playwright
and WebDriver don't share a common "accept an arbitrary callback for this
action" shape the way test runners do for hooks — their actual interaction
APIs are structurally different, and (per the `Mock` discussion above) one has
native interception and the other doesn't. A formal interface is what makes
that divergence tractable for Layer 2, which is exactly why one is warranted
here and wasn't for Layer 4.

## Open questions

- **Does Layer 2's browser-interaction interface need to say anything about
  mocking**, or is wiring a plugin to `Mock` entirely the plugin's own
  business, invisible to Layer 2? Current lean, based on how `Mock` is built:
  the latter — `Mock` is a Layer 1 concern usable directly by whoever needs
  it, and Layer 2's interaction interface probably only needs to cover
  interaction (navigate/click/type/etc.), not mocking at all. Worth
  confirming once Layer 3 design actually starts rather than assuming now.
- **Shape of the Layer 3 interaction interface itself** — not sketched here
  at all yet; deliberately deferred until this work is actually picked up
  (see [Non-goals](./test-runner-interface.md#non-goals-for-this-phase) in
  the other doc: "still API-only... that will come as we build this
  framework").
- **`Browser_AUTWrapper`'s relationship to remote (non-localhost) AUTs** —
  `API_AUTWrapper` currently hard-requires `host === 'localhost'` ("controlled
  local execution" — see its own class doc). A browser AUT pointed at a
  remote address is a genuinely different mode (no bootstrapper/closeHandler
  at all, since there's nothing to launch or tear down) — likely a
  distinct code path within `Browser_AUTWrapper`, not a variant of the same
  `create()` shape, but not designed yet.
