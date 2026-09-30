# Test-runner interface — design discussion

**Status:** draft for discussion, not a spec. Nothing here is implemented.
This document exists to hash out the shape of a contract before writing any
code against it. This is Layer 4 of [architecture-overview.md](./architecture-overview.md)
— see that doc for how this fits alongside `@controlium/utils`, the rest of
`@controlium/framework`, and the not-yet-started browser-interaction plugin
layer.

## Why this now

`API_AUTWrapper` is at the point where a real test suite could start using it:
start an API-based app, stop it, and talk to its endpoints (`request()`,
`lastResponse`, `transactions`). That's a genuinely limited surface — no UI
automation, no assertion helpers, no step-definition machinery — but it's
enough that "how does a test suite actually wire this up" stops being
hypothetical.

The framing so far has been Cucumber (`Before`/`After` hooks, `Given`/`When`/`Then`
steps), because that's Mat's background and the likely first consumer. But
`@controlium/framework` itself must not assume Cucumber, or any other runner —
a Jest or Mocha suite should be able to use `API_AUTWrapper` (and whatever
`@controlium/framework` grows into) exactly as well.

## Non-goals (for this phase)

- Not designing step-definition syntax, Gherkin parsing, or assertion helpers.
  That would be the responsibility of the test runners.
- Not designing UI/browser automation — still API-only. That will come as we
  build this framework.
- Not actually building `@controlium/cucumber-driver` (or a Jest/Mocha
  equivalent) yet — this doc settles the shape a suite wires itself up
  against, not the convenience packages that could later wrap that wiring.
- Not designing parallel-execution/worker semantics — deferred to whatever the
  underlying runner already does (see [Design principle](#design-principle)).

## Design principle

[[feedback_framework_primitives_not_policy]] already governs `API_AUTWrapper`
itself ("expose primitives, let the caller decide" — no baked-in retries or
waits). The same principle governs this lifecycle contract: it describes
**when** hook points occur, not **what happens** if something fails inside
one, how retries work, or how parallelism is handled. Those stay fully owned
by whichever runner (Jest, Mocha, Cucumber-JS) is actually driving.

## The resolved model: plain functions, no interface

Earlier drafts of this doc designed a formal `TestRunnerAdapter` interface
that a "driver" package would have to implement, plus a `TestLifecycleParticipant`
listener shape on top of it. Both are gone. Neither is needed.

**A driver only ever needs to know two things: when a test suite starts/ends,
and when an individual test starts/ends.** That's it — nothing else a runner
could tell us actually changes what the framework does. So the entire
contract is four plain functions, exported directly from `@controlium/framework`,
with no interface for anything to satisfy:

```ts
function beforeSuite(): void | Promise<void> { /* framework startup */ }
function afterSuite():  void | Promise<void> { /* framework teardown */ }
function beforeTest():  void | Promise<void> { /* clean-start bookkeeping */ }
function afterTest():   void | Promise<void> { /* clean-end bookkeeping */ }
```

A test suite wires these into whatever hooks its own runner provides, directly:

```ts
// Cucumber-JS
import { BeforeAll, Before, After, AfterAll } from '@cucumber/cucumber';
import { beforeSuite, afterSuite, beforeTest, afterTest } from '@controlium/framework';

BeforeAll(beforeSuite);
Before(beforeTest);
After(afterTest);
AfterAll(afterSuite);
```

```ts
// Jest
import { beforeSuite, afterSuite, beforeTest, afterTest } from '@controlium/framework';

beforeAll(beforeSuite);
afterAll(afterSuite);
beforeEach(beforeTest);
afterEach(afterTest);
```

No `TestRunnerAdapter` to implement, no registration object, no participant.
`@controlium/framework` never imports or references any runner's types —
these are just functions, and "accept an arbitrary callback" is universal
across every mainstream JS runner (Jest, Mocha, Jasmine, AVA, Cucumber-JS all
work identically here).

### Real-world precedent

This isn't a new idea — it's already how the predecessor framework works in
production. `ea-e2e-utils`'s `CommonHooks.ts` exports `EACucumberBeforeHooks`/
`EACucumberAfterHooks`, and every consuming test suite's own hooks file
(e.g. `ea-myaccount-app/apps/myaccount-bff-e2e/hooks/Cucumber.hooks.ts`) calls
them by hand, at the right point, alongside its own custom hooks:

```ts
// Cucumber.hooks.ts — the test suite's own file
EACucumberBeforeHooks(Cucumber);   // MUST always be first

Cucumber.BeforeAll(function () { /* suite's own setup */ });
Cucumber.Before(function (this: EAWorld) { /* suite's own per-scenario setup */ });
Cucumber.AfterStep(() => { /* suite's own per-step check */ });

EACucumberAfterHooks(Cucumber);    // MUST Always be last
```

The one difference: the old functions take the live `@cucumber/cucumber`
module as a parameter and register themselves directly with it (hard-coded to
Cucumber — note the `typeof CucumberBefore` typing in its signature). Ours
don't need to — `beforeSuite`/`afterSuite`/`beforeTest`/`afterTest` are plain,
runner-agnostic functions the suite calls *from inside* its own native hook,
rather than functions that register a native hook themselves. That's what
makes ours genuinely runner-agnostic where the old ones were Cucumber-only.

### Nesting is not our concern

A Jest suite that wants `describe`-block-scoped setup already gets that for
free from Jest itself — nested `describe` blocks already scope `beforeAll`/
`beforeEach`/`afterEach`/`afterAll` correctly, natively, with zero help from
us. If a suite wants our framework behaviour to run at a nested level too, it
just calls the same plain functions again, from inside that nested block's
own native hook:

```ts
describe('checkout flow', () => {
  beforeAll(beforeSuite);   // or nothing, if the outer scope already called it
  afterAll(afterSuite);
  beforeEach(beforeTest);
  afterEach(afterTest);

  it('completes with a valid card', async () => { /* ... */ });
});
```

The framework doesn't need a `Group` concept, a `group()` method, or any
awareness of nesting depth at all — it just responds to being called,
however many times, from wherever the suite author's own runner-native
structure puts it. Cucumber has no equivalent nesting construct at all, which
is fine: it simply never arises there, not because our contract failed to
support it.

## `afterTest` deliberately has no outcome parameter yet

The obvious question: shouldn't `afterTest` know whether the test passed or
failed? Checked the actual prior art rather than assuming yes. In
`ea-e2e-utils/src/Cucumber/CommonHooks.ts`, `scenario.result?.status` is used
in exactly four places, and every *behavioural* one is screenshot-gating:
take an end-of-step screenshot only on a pass (else defer to end-of-test);
take an end-of-test screenshot only on a failure. The other two uses are pure
logging (status message, a timeout-diagnostic hint) riding along, not
separate decisions.

There's a second, larger consumer of "did the test pass" in that codebase —
Jira/Zephyr result reporting — but it turns out **not** to be wired through
the live hooks at all. It's a wholly separate, out-of-process script
(`jira-zephyr-control-file.ts`) that `spawnSync`s an entire isolated test run
per Jira test case, reads the **subprocess's OS exit code** after the whole
run finishes, and parses report files off disk. It never touches
`scenario.result` or any live hook.

So the only proven real use for a pass/fail outcome is screenshot-gating —
which doesn't apply yet, since `@controlium/framework` has no browser/UI
capability. Building an outcome parameter now would be solving a problem we
don't have. `afterTest()` stays argument-free for this phase; when UI
capability lands, this will need revisiting (see
[Other open questions](#other-open-questions)) — a neutral outcome shape
(`{ status: 'passed' | 'failed' | 'skipped' }` or similar) will need
designing at that point, translated by each suite's own wiring from whatever
its runner gives it (trivial from Cucumber's hook parameter; not uniformly
easy from Jest's `afterEach`, which has no native result access without
extra wiring — flagging now so it isn't a surprise later).

## "Drivers" are optional convenience, not a required contract

Nothing above requires a driver package to exist. A suite can always
hand-wire the four functions itself, in four lines, exactly like the old
`Cucumber.hooks.ts` does today. A driver package's only job is to save a
suite from writing that wiring by hand, and optionally add richer,
runner-specific extras on top:

```ts
// hypothetical @controlium/cucumber-driver — entirely optional
import type * as CucumberModule from '@cucumber/cucumber';
import { beforeSuite, afterSuite, beforeTest, afterTest } from '@controlium/framework';

export function wireCucumberHooks(cucumber: typeof CucumberModule): void {
  cucumber.BeforeAll(beforeSuite);
  cucumber.Before(beforeTest);
  cucumber.After(afterTest);
  cucumber.AfterAll(afterSuite);
}
```

A driver's absence never blocks using `@controlium/framework` with that
runner — it only means the suite writes the four-line wiring itself instead
of importing it. "Value-added" driver functionality (your example: a Jest
driver letting a `describe` block's setup modify a setting) becomes
additional, optional exports layered on top of the same base functions —
never something a suite needs in order to use the framework at all.

## Package boundaries

```
@controlium/framework        — this repo. API_AUTWrapper + future capabilities.
                                Exports beforeSuite/afterSuite/beforeTest/afterTest
                                as plain functions. Zero dependency on any test runner.

@controlium/cucumber-driver   — optional, separate project/package (not yet built).
                                Depends on @cucumber/cucumber + @controlium/framework.
                                Pre-wires the four functions into Cucumber's native
                                hooks. Thin — nothing beyond that wiring.

@controlium/jest-driver        — hypothetical, same pattern, not yet needed.
@controlium/mocha-driver        (only if/when a real consumer asks for one)
```

No separate "interface" package is needed — there's no interface. The four
functions live directly in `@controlium/framework` alongside `API_AUTWrapper`.

There's a third, distinct kind of package worth naming so it isn't confused
with the thin drivers above: a fuller, opinionated **test-controller** package
— e.g. a hypothetical `cucumber-tc` — that isn't just hook-wiring but a real,
reusable library: step definitions that call into `@controlium/framework`
internally, `World`/context conventions, maybe reporting integrations later.
From `@controlium/framework`'s point of view this is just another consumer,
no different in kind from a test suite writing its own hooks — it happens to
be reusable and packaged rather than written inline per-project. Whether it
depends on the thin `@controlium/cucumber-driver` for its wiring (once that
exists) or just wires the four functions inline itself (trivial, and it's
already Cucumber-specific anyway) is an implementation detail for whoever
builds it, not something this contract needs to decide.

## Other open questions

- **Hook ordering relative to a suite's own custom hooks.** The old code's
  `// MUST always [be] first` / `// MUST Always be last` comments hint at a
  real constraint: when a suite registers its *own* `Before`/`After` logic
  alongside ours, does the order those registrations happen in matter (most
  runners run `Before`-style hooks in registration order and `After`-style
  hooks in reverse)? Needs a clear, documented answer — e.g. "call
  `beforeTest` before your own per-test setup; call `afterTest` after your
  own per-test teardown" — rather than leaving suite authors to guess, the
  way the old comments imply was necessary there too.
- **Test outcome shape**, deferred above — will need a neutral
  `{ status: ... }`-style shape once UI/browser capability makes `afterTest`
  need to know pass/fail, and per-runner wiring code will need to translate
  into it (easy for Cucumber, not free for Jest).
- **Multiple simultaneous AUTs.** `API_AUTWrapper` already supports running
  several instances at once (independent transactions/headers/close per
  instance — see its own JSDoc "Multiple simultaneous AUTs" example). Nothing
  above needs to change for this — it's purely suite-authoring code's concern
  (multiple module-scope variables, one per AUT), invisible to
  `beforeSuite`/`afterSuite`/`beforeTest`/`afterTest`.

## Suggested next steps

1. Build one small throwaway spike, not more doc: wire the four plain
   functions into real Cucumber-JS, by hand, exactly as sketched above —
   confirms the model holds up against a real runner before anything is
   built around it.
2. Repeat the same suite-author code against Jest as the "does this
   genuinely generalise beyond Cucumber" check.
3. Resolve the hook-ordering question above with a documented answer.
4. Only then consider whether `@controlium/cucumber-driver` is worth building
   as a real convenience package.
