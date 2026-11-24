# AGENTS.md — using @controlium/framework

> **Scope of this file — read this first.**
> This file is for an AI agent (or developer) building a test suite that *consumes* the
> published `@controlium/framework` package. It is **not** guidance for developing
> `@controlium/framework` itself — if you are working inside this framework's own repo
> (`controlium/framework`), ignore everything below; it does not apply to that work. This
> file lives under `docs/consumer/` specifically so it isn't picked up as blanket
> repo-wide instructions while hacking on the framework's own source.

> **Status: early draft, expect this to change.** Controlium is young — this file captures
> the current convention and current framework capability, not a settled contract. Parts
> of it are explicitly marked as undecided or unimplemented below; don't fill those gaps
> from guesswork without flagging that you did so.

## Goal

Given this file, an agent should be able to build a **functional regression test suite**
for a consuming app, end-to-end, with minimal human intervention — not just produce files
that look plausible, but scaffold something that actually runs and actually exercises the
target app. If you finish scaffolding and haven't run the suite to confirm it passes, you
are not done.

## Step 0 — work out which scenario applies

There are three shapes of target app. **Check current framework capability against each
before proceeding** — see the capability table immediately below; don't assume all three
are equally buildable today.

| Scenario | What it means | Buildable today? |
|---|---|---|
| **API-only** | Target is a backend service (BFF, REST API, etc.) with no browser UI to drive. | **Yes.** `@controlium/framework`'s `API_AUTWrapper` covers this fully. See "API-only suites" below. |
| **Browser-only** | Target is a UI app driven through a real browser. | **No — not yet.** `@controlium/framework` has no browser/UI equivalent of `API_AUTWrapper` yet. Its own design docs (`docs/design/architecture-overview.md`, framework repo) explicitly list browser interaction as "not started" (`Browser_AUTWrapper` is a *named, planned* class that does not exist in code yet). **Do not attempt to scaffold a browser suite against this framework version.** Do not guess a component-registration/harness-class shape to fill the gap — the planned architecture is materially different (a `Browser_AUTWrapper` plus separate per-tool "Layer 3" plugin packages for Playwright/WebDriver/etc.), and guessing at that shape now will produce something that has to be thrown away. |
| **Mixed** | A browser app plus one or more backend apps it depends on, tested together. | **No — blocked on Browser-only above, and the suite-shape itself is still undecided.** Current intent (not yet designed in detail): one unified suite, with the backend(s) mocked at the HTTP layer rather than run live (e.g. a step like `A [BFF] listener is on '...'`, pointing requests at a mock instead of a live backend). Treat this as a placeholder, not a spec. |

If the target is Browser-only or Mixed, stop and say so rather than improvising — that's
the correct outcome right now, not a failure to find the right approach.

## API-only suites — the procedure that actually works today

### 1. Dependencies

The target app's test suite needs, as direct dependencies:
- `@controlium/framework`
- `@controlium/cucumber-driver`
- `@cucumber/cucumber`
- `typescript`, `ts-node`, `@types/node`

These are published to an internal Verdaccio registry, not the public npm registry —
confirm the consuming project's `.npmrc` scopes `@controlium` to it before running
`npm install`; if there's no `.npmrc` doing that, ask rather than guessing a registry URL.

### 2. Folder layout

```
e2e/
├── config/
│   └── cucumber.js          # Cucumber-JS profile(s) — see below
├── hooks/
│   └── hooks.ts             # wireCucumberHooks + wireCucumberStepTimeout + AUT bootstrap
├── steps/
│   └── *.steps.ts
└── features/
    └── <domain>/*.feature   # grouped by business domain, not by endpoint
```

No `world/world.ts` is needed by default. `wireCucumberStepTimeout` covers setting a
default step timeout, and no custom World class is needed unless the suite genuinely
requires extra state/methods on it — don't add one reflexively "just in case."

### 3. `e2e/hooks/hooks.ts`

```ts
import * as Cucumber from '@cucumber/cucumber';
import { wireCucumberHooks, wireCucumberStepTimeout } from '@controlium/cucumber-driver';
import { API_AUTWrapper } from '@controlium/framework';

wireCucumberHooks(Cucumber);
wireCucumberStepTimeout(Cucumber);

let api: API_AUTWrapper<TargetAppHandle>; // TargetAppHandle = whatever the app's own bootstrap returns

Cucumber.Before(async function () {
  api = await API_AUTWrapper.create({
    appName: '<TargetApp>',
    port: 0, // pick a free port, or the app's configured port
    bootstrapper: async (port) => {
      // Find how THIS app is actually started (its main.ts/bootstrap.ts/server entrypoint)
      // and call that directly — do not invent a generic bootstrapper. Framework's own
      // API_AUTWrapper.d.ts has worked examples for NestJS and raw Express/http.Server.
    },
    closeHandler: (handle) => { /* however this app's handle is closed */ },
    getUrlHandler: (handle) => { /* however this app's handle exposes its URL */ },
  });
  this.api = api; // expose to steps via the World, if steps need it
});

Cucumber.After(async function () {
  await api?.close();
});
```

The bootstrapper/closeHandler/getUrlHandler are **app-specific by design** — read the
target app's actual entrypoint before writing these, don't guess a generic shape. See
`API_AUTWrapper`'s own class doc comment (`src/API_AUTWrapper.ts` in the framework repo,
or its shipped `.d.ts`) for full worked examples, including multiple simultaneous AUTs.

### 4. `e2e/config/cucumber.js`

```js
// This module's own `export default` value IS the "default" profile — cucumber-js's ESM
// config loader unwraps the default export once already. Nesting another "default: {...}"
// key inside it (an easy mistake — every real-world cucumber.js example predating v11 does
// this, because CJS's module.exports shape needs it) makes the loader look one level too
// deep and silently produce an empty config (paths/require both resolve to []), no error.
// Verified the hard way in @controlium/cucumber-driver's scratch-e2e/config/cucumber.js.
export default {
  paths: ['e2e/features/**/*.feature'],
  import: ['e2e/hooks/**/*.ts', 'e2e/steps/**/*.ts'],
  format: ['summary'],
};
```

**The `.ts` loading mechanism here is unverified.** Every consuming suite this file was
modelled on used CJS (`module.exports`, `requireModule: ['ts-node/register']`) — which
does not work in an ESM (`"type": "module"`) package at all (`module` is not defined; this
is a second, separate bug from the nesting one above). What actually replaces it for ESM
+ TypeScript (a `loader` entry, `ts-node/esm`, `tsx`, or something else) has **not been
tested**. `@controlium/cucumber-driver`'s own `scratch-e2e/` example deliberately sidesteps
this entirely by writing hooks/steps in plain `.js` — confirmed working end-to-end
(`npm run test:scratch-e2e` in that repo) — precisely because the TS-loader question
wasn't settled. If you need `.ts` hooks/steps for a real suite, verify the loader mechanism
actually works before committing to it; don't assume `requireModule`/`ts-node/register`
carries over from legacy.

Start with one profile. Don't front-load multiple named profiles (local/pipeline/manual/
CI variants, etc.) until there's an actual need for it.

### 5. Write features and steps

Steps call `this.api.request(method, path, options)` and assert on
`this.api.lastResponse`. Group `.feature` files by business domain, not by endpoint or
by page.

`@controlium/cucumber-driver` also ships a reusable step library (housekeeping, API
launch/header/request/validation steps — see that repo's `docs/design/
step-definition-structure.md` for the current breakdown) via `wireAllStepDefinitions`
and its per-category functions. **As of this writing most steps in it are stubs that
throw "...is registered but not implemented yet" if actually used** — don't wire these
into a real suite expecting them to work; write your suite's own steps against
`API_AUTWrapper` directly until that lands.

### 6. Editor intellisense for Gherkin steps (optional but recommended)

Verified 2026-09-30, for VS Code specifically: `@controlium/cucumber-driver` ships a
ready-made template. Copy both files into the suite's own `.vscode/` (merge rather than
overwrite if `.vscode/settings.json` already has content):

```
cp node_modules/@controlium/cucumber-driver/templates/vscode/settings.json .vscode/settings.json
cp node_modules/@controlium/cucumber-driver/templates/vscode/extensions.json .vscode/extensions.json
```

This wires the **Cucumber (Gherkin) Full Support** extension
(`alexkrechik.cucumberautocomplete`) to recognise both this suite's own steps and the ones
in `wireApiAutStepDefinitions`/`wireApiValidationStepDefinitions` — confirmed working
against real step patterns, including the fact that those steps are registered via
`cucumber.Given(...)` through a parameter rather than a bare imported `Given(...)`, which
was genuinely uncertain before testing it.

**For any other editor, this has not been verified — don't fabricate exact config syntax.**
The documented (but not independently tested by us) path for everything else: the official
`@cucumber/language-server` package implements the Language Server Protocol for
Gherkin/step intellisense, with client integrations for VS Code (`CucumberOpen.cucumber-official`
— a *different* extension from the one above), Neovim, and Emacs via their LSP clients. Its
settings are `cucumber.features` (glob for `.feature` files) and `cucumber.glue` (glob for
step definition source — same purpose as `cucumberautocomplete.steps` above); point
`cucumber.glue` at the same two paths used in the template. JetBrains IDEs (WebStorm/
IntelliJ) have their own built-in Cucumber.js step recognition configured through IDE
project settings rather than a shareable file — check current JetBrains docs rather than
guessing the UI path.

### 7. Verify — do not skip this

Run the suite for real:

```
npx cucumber-js --config e2e/config/cucumber.js
```

Confirm scenarios actually pass against the real, locally-bootstrapped app — not just that
the files parse or TypeScript compiles. If you want proof the framework wiring itself
fired correctly (not just that steps happened to pass), temporarily set
`Log.logToConsole = true` and `Log.loggingLevel = LogLevels.FrameworkDebug` (from
`@controlium/utils`) in `hooks.ts` and check for the framework's own lifecycle markers in
stdout — the same technique `@controlium/cucumber-driver`'s own `e2e-smoke` test uses to
prove its wiring against real Cucumber-JS rather than a mock of it.

## Not yet decided — don't treat these as settled

- **Feature-file naming.** No cross-suite standard yet — naming conventions this author
  has seen elsewhere vary widely (`Title Case With Spaces.feature`, `camelCase.feature`,
  `kebab-case.feature`). Pick something consistent *within* the suite you're building.
- **Browser-only and Mixed scenarios** — see the capability table above. Not buildable yet.
- **`config/cucumber.js` multi-profile conventions** (local vs. pipeline vs. manual) —
  a pattern for this exists in prior experience but hasn't been re-evaluated for
  Controlium.
- **CI/reporting conventions** (a report-generation script, an `html-report/` output
  folder, test-management-tool integration — all seen in prior experience) — not yet
  carried forward or redesigned here.
- **Editor intellisense beyond VS Code** — the `@cucumber/language-server` path (Neovim,
  Emacs, the official VS Code extension) and JetBrains' built-in support are documented
  above but not independently verified the way the VS Code community-extension template
  was. Lint config shape also not written up.
- **`wireApiAutStepDefinitions`/`wireApiValidationStepDefinitions`** exist but are stubs —
  see "Write features and steps" above. Don't build a suite that depends on them working.

## Why this file exists

The goal is a *consuming* suite an agent can stand up with minimal hand-holding, that
actually proves itself by running — not a suite that merely resembles the legacy examples
structurally. Where this file is honest about a gap (Browser-only, Mixed), that's
deliberate: better to say "not ready" than to scaffold something that looks complete but
silently doesn't work.
