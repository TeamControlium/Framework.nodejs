import { Detokeniser, Log, Logger, LogLevels, Settings, Utils } from '@controlium/utils';

import { API_AUTWrapper } from './API_AUTWrapper.js';

/**
 * Resolves the configured logging level from settings (env var → npm config → profile
 * parameter → default) — the same multi-source resolution every other setting in this
 * ecosystem uses. Runner-agnostic: {@link beforeTest} calls this itself (so every driver
 * gets per-test log-level resolution automatically, with no wiring of its own needed), and
 * a driver's own mid-scenario "reset logging level to settings" step (e.g.
 * `@controlium/cucumber-driver`'s `housekeeping/logging.steps.ts`) calls the exact same
 * function, so the two can't drift apart into resolving it two different ways.
 *
 * Env var name (`TEST_LOG_LEVEL`), npm config name (`testLogLevel`), and default
 * (`'Framework Debug'`) are deliberately plain, runner-neutral names — nothing Cucumber- (or
 * any other runner-) specific about any of them.
 */
export function resolveLogLevelFromSettings(): string {
  const result = Settings.get<string>(LogLevels.FrameworkInformation, 'Log Level', {
    processEnvName: 'TEST_LOG_LEVEL',
    npmPackageConfigName: 'testLogLevel',
    profileParameterName: '$.logLevel',
    defaultValue: 'Framework Debug',
  });
  return result.value ?? 'Framework Debug';
}

/**
 * Resolves the configured default log `maxLines` from settings (env var → npm config →
 * profile parameter → default) — the same multi-source resolution as
 * {@link resolveLogLevelFromSettings}, and applied alongside it by {@link beforeTest}.
 * Default `200`, deliberately higher than `Logger`'s own built-in default of `55`, since a
 * full request/response dump at `TestInformation` (see `API_AUTWrapper`) routinely exceeds
 * that default, truncating exactly the detail that logging was asked for.
 *
 * @throws {Error} If the resolved value isn't an integer `>= 3` — `Logger.maxLines`'s own
 *   setter requires that (an env var/npm config value always comes back as a raw string,
 *   never an actual number, so it must be parsed and validated here rather than trusted as-is).
 */
export function resolveMaxLinesFromSettings(): number {
  const result = Settings.get<number>(LogLevels.FrameworkInformation, 'Log Max Lines', {
    processEnvName: 'TEST_LOG_MAX_LINES',
    npmPackageConfigName: 'testLogMaxLines',
    profileParameterName: '$.logMaxLines',
    defaultValue: 200,
  });
  const maxLines = typeof result.value === 'number' ? result.value : Number(result.value);
  if (!Number.isInteger(maxLines) || maxLines < 3) {
    throw new Error(
      `resolveMaxLinesFromSettings: resolved maxLines must be an integer >= 3 — received ${Utils.describeValue(result.value)} from ${result.source}.`
    );
  }
  return maxLines;
}

/**
 * Resolves a default per-test step/timeout value from settings (env var → npm config →
 * default) — the same resolution shape as {@link resolveLogLevelFromSettings}, generalised
 * to whatever name/default a particular runner's own convention wants. No
 * `profileParameterName` here (unlike the two resolvers above) — a per-test timeout is
 * normally a suite-wide constant set once at startup, before any profile/World context
 * would exist to resolve against, not something that varies per scenario.
 *
 * Every runner has some equivalent of "default timeout for a test/step" (Cucumber-JS's
 * `setDefaultTimeout`, Jest's `jest.setTimeout`, Vitest's `testTimeout` config) — this
 * resolves the *value*; applying it via whichever runner-specific API is each driver's own
 * job (e.g. `@controlium/cucumber-driver`'s `wireCucumberStepTimeout`).
 *
 * @param options - Setting-resolution overrides — a driver with its own established env
 *   var/npm-config naming (e.g. a pre-existing `CUCUMBER_STEP_TIMEOUT`) passes that through
 *   here rather than adopting this function's own generic defaults.
 *   - `processEnvName` — Environment variable checked first (default: `TEST_STEP_TIMEOUT`).
 *   - `npmPackageConfigName` — npm package config key checked second (default: `testStepTimeout`).
 *   - `defaultValue` — Fallback if neither source resolves (default: `30000`).
 * @throws {Error} If the resolved value isn't a positive finite number.
 */
export function resolveStepTimeoutFromSettings(options?: {
  processEnvName?: string;
  npmPackageConfigName?: string;
  defaultValue?: number;
}): number {
  const { value, source } = Utils.getSetting<number>(LogLevels.FrameworkInformation, 'Default Step Timeout', {
    processEnvName: options?.processEnvName ?? 'TEST_STEP_TIMEOUT',
    npmPackageConfigName: options?.npmPackageConfigName ?? 'testStepTimeout',
    defaultValue: options?.defaultValue ?? 30000,
  });

  // An env var or npm config value always comes back as a raw string, never an actual
  // number — must be parsed and validated here rather than trusted as-is.
  const timeoutMs = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `resolveStepTimeoutFromSettings: resolved step timeout must be a positive finite number — received ${Utils.describeValue(value)} from ${source}.`
    );
  }
  return timeoutMs;
}

/**
 * The runner-agnostic lifecycle contract test-runner drivers wire into their
 * runner's native hooks. See `docs/design/test-runner-interface.md` for the
 * design rationale: these are plain functions, not an interface anything
 * must implement — a Cucumber suite calls them from `BeforeAll`/`Before`/
 * `After`/`AfterAll`, a Jest suite from `beforeAll`/`beforeEach`/`afterEach`/
 * `afterAll`, and so on. `@controlium/framework` never imports or references
 * any test runner's types.
 */

/**
 * Called once before the whole test suite begins — i.e. before any test in it runs.
 *
 * Framework-suite-wide setup lives here. Currently just a logged marker: there is no
 * framework-wide state yet that needs suite-level setup, but the seam exists so a
 * driver's wiring can be verified end-to-end against a real test runner before there
 * is one.
 */
export function beforeSuite(): void {
  Log.writeLine(LogLevels.FrameworkInformation, 'Controlium framework: suite starting');
}

/**
 * Called once after the whole test suite ends — i.e. after every test in it has run.
 * See {@link beforeSuite}.
 */
export function afterSuite(): void {
  Log.writeLine(LogLevels.FrameworkInformation, 'Controlium framework: suite ending');
}

/**
 * Called before each individual test, to ensure a clean start.
 *
 * Resets {@link Utils.resetPromiseCount} so a `Utils.timeoutPromise`-wrapped operation
 * left outstanding by a previous test (or anything that ran before this wiring was in
 * place) can never bleed into this test's own count. Logs at `FrameworkDebug` (rather
 * than `FrameworkInformation`, as {@link beforeSuite} does) since this fires once per
 * test rather than once per suite — deliberately quieter to avoid flooding output
 * across a large suite, but still there for anyone debugging whether per-test wiring
 * is actually firing.
 *
 * Also runs two deliberately independent checks — each catches a failure mode the other
 * structurally can't, see their own doc comments for the full reasoning:
 * - {@link API_AUTWrapper.assertRegistryIsEmpty} — did the previous test's own
 *   `afterTest()` run to completion *at all*? Cheap, synchronous, in-memory; runs first.
 * - {@link API_AUTWrapper.assertNoKnownAUTsStillListening} — given that it did, did it
 *   actually free up every port it claimed to?
 *
 * Throws (aborting this test, loudly) if either finds a problem: silently continuing would
 * let this test run against stale state left over from the last one, which
 * [[feedback_test_atomicity_non_negotiable]] exists specifically to rule out. Deliberately
 * unconditional, not opt-in, for both — the whole point is catching this *before* it's ever
 * relied on being caught.
 *
 * Now async, for the same reason {@link afterTest} is — checking real socket connectivity is
 * inherently asynchronous — so a driver's `Before`/`beforeEach`-equivalent wiring must
 * `await` (or return) this.
 *
 * Also resolves and applies {@link Logger.loggingLevel}/{@link Logger.maxLines} fresh, via
 * {@link resolveLogLevelFromSettings}/{@link resolveMaxLinesFromSettings} — per-scenario, not
 * once at suite start, since parallel workers must each pick this up independently, not
 * share one value resolved once for the whole run. Runs first, before this function's own
 * "test starting" log line, so that line (and everything else this test does) is already
 * governed by the right level. Resolving `profileParameterName`-sourced settings correctly
 * requires `Settings`'s resolution context to already be bound to this test's own World/
 * parameters — a driver's `Before`/`beforeEach`-equivalent wiring must call
 * `Settings.setContext(...)` *before* calling this function, not after.
 */
export async function beforeTest(): Promise<void> {
  Logger.loggingLevel = resolveLogLevelFromSettings();
  Logger.maxLines = resolveMaxLinesFromSettings();
  API_AUTWrapper.assertRegistryIsEmpty();
  await API_AUTWrapper.assertNoKnownAUTsStillListening();
  Log.writeLine(LogLevels.FrameworkDebug, 'Controlium framework: test starting');
  Utils.resetPromiseCount();
}

/**
 * Called after each individual test, to ensure a clean end.
 *
 * Warns — rather than throwing — if any `Utils.timeoutPromise`-wrapped operation from
 * this test never settled, then resets the count regardless so the next test starts
 * clean either way. Deliberately a warning, not a failure: per
 * [[feedback_framework_primitives_not_policy]], this hook reports what it found, it
 * doesn't decide the test failed because of it — that's a policy call for the suite
 * (or its runner) to make, not the framework. Logs at `FrameworkDebug` on the
 * clean-exit path, matching {@link beforeTest}.
 *
 * **Also owns clearing every per-test, framework-level ambient static** — currently
 * `Settings`'s resolution context, `Logger`'s output callback, `Detokeniser` (its
 * `enabled` toggle, escape char, and any registered callbacks — `Detokeniser.reset()`
 * already restores all of these; see its own doc comment), every registered
 * `API_AUTWrapper` (closed and deregistered via `closeAllRegistered()` — see its own
 * doc comment for why this is safe/automatic rather than left to each test to remember),
 * and any staged-but-unconsumed one-shot "next request" header override (see
 * `API_AUTWrapper.clearNextRequestHeaders()` — this one's genuinely load-bearing, not
 * just tidiness: that override is global, not scoped to any AUT instance, so a test that
 * stages one and never triggers the request it was meant for — or whose request throws
 * before `request()` gets to consume it — would otherwise leak it into the very next
 * request made by *any* AUT in whatever test runs next), and any future equivalent (e.g.
 * a per-test recorded-data store, or — once it exists — a `Browser_AUTWrapper` registry
 * of its own, closed here the same way). Per [[feedback_test_atomicity_non_negotiable]]:
 * tests must be isolated and runnable in any order, so anything a test (or a driver's own
 * `Before`-side wiring) can set ambiently for the duration of one test MUST be cleared
 * here, unconditionally — not left to each driver to remember independently.
 * `Settings`/`Logger`'s own *setters* stay driver-specific (they need the runner's own
 * World/context, which this function structurally never receives — see
 * `docs/design/test-runner-interface.md`), but clearing needs nothing runner-specific, so
 * it belongs here, once, covering every current and future driver for free.
 *
 * Ordering is deliberate: `Settings.clearContext()` runs first (matching the ordering a
 * driver's own wiring previously handled by hand), the `API_AUTWrapper` statics
 * (`closeAllRegistered()`, `clearNextRequestHeaders()`) run next so their own log lines
 * are still captured by whatever attach-style callback is active, then the active-resources
 * diagnostic log (see below) runs against the post-cleanup state, and
 * `Logger.clearOutputCallback()` runs last of all, so this function's own log lines above
 * are too.
 *
 * Now async — closing a real AUT is inherently asynchronous — so a driver's `After`/
 * `afterEach`-equivalent wiring must `await` (or return) this.
 */
export async function afterTest(): Promise<void> {
  Settings.clearContext();
  Detokeniser.reset();
  await API_AUTWrapper.closeAllRegistered();
  API_AUTWrapper.clearNextRequestHeaders();

  // Diagnostic visibility only, for now — purely logged, nothing acted on. Uses the
  // documented process.getActiveResourcesInfo() (Node 17.3+/18+), not the undocumented
  // process._getActiveHandles()/_getActiveRequests() — this is read-only reporting, not
  // manipulation, so the stable public API is the right tool; no need to accept the
  // undocumented-internals risk for something that doesn't touch the handles at all.
  // Logged *before* Logger.clearOutputCallback() below, deliberately, so this still flows
  // through whatever attach-style callback is active, same as every other log line here —
  // logging it after clearing the callback would make it console-only, inconsistent with
  // the rest of this function's own log lines.
  const activeResources = process.getActiveResourcesInfo();
  Log.writeLine(
    LogLevels.TestInformation,
    `Controlium framework: active resources at end of test: ${activeResources.length === 0 ? '(none)' : activeResources.join(', ')}`
  );

  const outstanding = Utils.promiseCount;
  if (outstanding > 0) {
    Log.writeLine(
      LogLevels.Warning,
      `Controlium framework: ${outstanding} promise(s) still outstanding at end of test — a Utils.timeoutPromise-wrapped operation may not have settled`
    );
  } else {
    Log.writeLine(LogLevels.FrameworkDebug, 'Controlium framework: test ending');
  }
  Utils.resetPromiseCount();

  Logger.clearOutputCallback();
}
