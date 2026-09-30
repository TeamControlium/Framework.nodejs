import { Log, LogLevels, Utils } from '@controlium/utils';

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
 */
export function beforeTest(): void {
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
 */
export function afterTest(): void {
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
}
