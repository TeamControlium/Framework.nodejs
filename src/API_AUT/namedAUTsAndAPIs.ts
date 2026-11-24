import { StringUtils, Utils } from '@controlium/utils';

import type { API_AUTWrapper } from './API_AUTWrapper.js';
import { logAndThrow } from './requireValidArguments.js';

/**
 * The two name→instance lookup tables backing `API_AUTWrapper`'s whole "find it again later by
 * name" story (`startNewApplication`/`prepareApplication`/`startApplication`/`stopApplication`/
 * `getApplication`/`registerAPI`/`prepareAPI`/`findAUTOrAPIByTargetText`) — one for AUTs, one
 * for APIs, deliberately kept separate (see {@link assertNameNotUsedByOtherKind}): there is
 * no legitimate reuse case for one name meaning both an AUT and an API at once.
 *
 * Both are deliberately type-erased (`Map<string, API_AUTWrapper>`, no generic) — different
 * named apps can have entirely different `Handle` types, and nothing reading from either
 * registry needs to know what it is.
 */
const autRegistry = new Map<string, API_AUTWrapper>();
const apiRegistry = new Map<string, API_AUTWrapper>();

/** Files `wrapper` into the AUT registry under `appName`. Replaces whatever was there before. */
export function registerAUT(appName: string, wrapper: API_AUTWrapper): void {
  autRegistry.set(appName, wrapper);
}

/** Files `wrapper` into the API registry under `appName`. Replaces whatever was there before. */
export function registerAPI(appName: string, wrapper: API_AUTWrapper): void {
  apiRegistry.set(appName, wrapper);
}

/** Bare lookup — `undefined` if nothing is registered as an AUT under `appName`. */
export function findAUTByName(appName: string): API_AUTWrapper | undefined {
  return autRegistry.get(appName);
}

/** Bare lookup — `undefined` if nothing is registered as an API under `appName`. */
export function findAPIByName(appName: string): API_AUTWrapper | undefined {
  return apiRegistry.get(appName);
}

/** `true` if `appName` is currently registered as an AUT. */
export function isNameTakenAsAUT(appName: string): boolean {
  return autRegistry.has(appName);
}

/** `true` if `appName` is currently registered as an API. */
export function isNameTakenAsAPI(appName: string): boolean {
  return apiRegistry.has(appName);
}

/**
 * Fails if `appName` is already registered in the *other* registry (AUT vs API) —
 * unconditionally, regardless of whether that other entry is still running. Called before
 * `startNewApplication`/`prepareApplication`/`registerAPI`/`prepareAPI` each register
 * anything. There is no legitimate reuse case for one name meaning both an AUT and an API at
 * once — this is deliberately stricter than either registry's own same-registry collision
 * rule (that one only ever blocks a still-running entry; this one blocks unconditionally,
 * regardless of running state).
 */
export function assertNameNotUsedByOtherKind(appName: string, kindBeingRegistered: 'aut' | 'api'): void {
  const otherRegistry = kindBeingRegistered === 'aut' ? apiRegistry : autRegistry;
  const otherKindLabel = kindBeingRegistered === 'aut' ? 'an API' : 'an AUT';
  if (otherRegistry.has(appName)) {
    logAndThrow(appName, `is already registered as ${otherKindLabel} — an application name cannot be both an AUT and an API. Choose a different name.`);
  }
}

/** Shared "resolve the single registered entry" logic behind both bare-keyword cases of
 * {@link findAUTOrAPIByTargetText} (`'AUT'` and `'API'`) — not exported on its own, since
 * there's deliberately no public lookup for "the one API" to mirror `API_AUTWrapper.getApplication()`'s
 * own no-name resolution (see {@link findAUTOrAPIByTargetText}'s own doc comment for why). */
function findOnlyRegistered(registry: Map<string, API_AUTWrapper>, label: 'AUT' | 'API'): API_AUTWrapper {
  const registered = [...registry.entries()];
  if (registered.length === 0) {
    const entryPoints = label === 'AUT' ? 'startNewApplication()/prepareApplication()' : 'registerAPI()/prepareAPI()';
    logAndThrow(label, `cannot resolve — no ${label}'s registered (${entryPoints} run first?)`);
  }
  if (registered.length > 1) {
    logAndThrow(label, `cannot resolve — ${registered.length} ${label}s registered ([${registered.map(([name]) => name).join(', ')}]); specify which one by name`);
  }
  return registered[0][1];
}

/** Resolves "the single registered AUT" — backs `API_AUTWrapper.getApplication()`'s own
 * no-name resolution. */
export function findOnlyRegisteredAUT(): API_AUTWrapper {
  return findOnlyRegistered(autRegistry, 'AUT');
}

/** Resolves "the single registered API" — backs {@link findAUTOrAPIByTargetText}'s bare
 * `'API'` case. Deliberately not mirrored by a public `getAPI()` — see
 * {@link findAUTOrAPIByTargetText}'s own doc comment. */
export function findOnlyRegisteredAPI(): API_AUTWrapper {
  return findOnlyRegistered(apiRegistry, 'API');
}

/**
 * Resolves a step/runner's `AUT` / `API` / `[name]` target text into the registered
 * `API_AUTWrapper` instance it refers to — runner-agnostic, so `@controlium/cucumber`'s (and
 * any future runner's) step-defs just call it rather than duplicating this three-way dispatch
 * themselves.
 *
 * - `'AUT'` → {@link findOnlyRegisteredAUT}.
 * - `'API'` → {@link findOnlyRegisteredAPI} (no public equivalent — see its own doc
 *   comment for why).
 * - Anything else is treated as a `[name]`-bracketed reference: brackets stripped, then
 *   resolved by checking **both** registries directly for membership (not a try/catch cascade).
 *   Cross-registry collisions are already blocked at registration time (see
 *   {@link assertNameNotUsedByOtherKind}), so a name should never appear in both — but this
 *   is a just-in-time re-check at the point of use, not an assumption: exactly one match is
 *   required, loudly, every time. Finding the name in *both* registries throws a distinct
 *   "should be impossible" error rather than silently picking one, since that would mean the
 *   registration-time guard was somehow bypassed — a defect worth surfacing immediately, not
 *   masking.
 *
 * @throws {Error} If the bracketed name is registered as neither; if it is (impossibly)
 *   registered as both; or any of the usual zero/ambiguous-registration errors
 *   {@link findOnlyRegisteredAUT}/{@link findOnlyRegisteredAPI} themselves throw for the
 *   unqualified `'AUT'`/`'API'` cases.
 */
export function findAUTOrAPIByTargetText(targetText: string): API_AUTWrapper {
  if (targetText === 'AUT') return findOnlyRegisteredAUT();
  if (targetText === 'API') return findOnlyRegisteredAPI();

  const name = StringUtils.trimChar(StringUtils.trimChar(targetText, '['), ']');

  const inAUTRegistry = isNameTakenAsAUT(name);
  const inAPIRegistry = isNameTakenAsAPI(name);

  if (inAUTRegistry && inAPIRegistry) {
    logAndThrow(
      name,
      'is registered as BOTH an AUT and an API — this should be impossible (cross-registry ' +
      'registration is blocked at startNewApplication()/prepareApplication()/registerAPI()/prepareAPI() ' +
      'time); the registration-time guard has been bypassed somewhere.'
    );
  }
  if (inAUTRegistry) return findAUTByName(name) as API_AUTWrapper;
  if (inAPIRegistry) return findAPIByName(name) as API_AUTWrapper;

  logAndThrow(name, 'is registered as neither an AUT nor an API — nothing to find (did startNewApplication()/prepareApplication()/registerAPI()/prepareAPI() run for this name?)');
}

/**
 * Closes every currently-registered AUT and clears both registries entirely, regardless of
 * whether each AUT was ever actually started (`close()` already safely no-ops for one that
 * wasn't). Backs `API_AUTWrapper.closeAllAUTsAndAPIs()`, called automatically by
 * `@controlium/framework`'s own `afterTest()` so a test never has to remember to close what it
 * registered, and so no registered AUT can ever leak into whatever test runs next.
 *
 * Both registries are cleared *before* any `close()` call settles, not after — so even if
 * closing one AUT throws, the next test still starts with zero AUTs/APIs registered. Every
 * failure is still collected and reported (not just the first) so a flaky/broken
 * `closeHandler` is never silently swallowed.
 *
 * APIs never have a handle/closeHandler — nothing to await-close, just drop the registration
 * itself, so one test's API can never leak into the next either.
 *
 * @throws {Error} If any registered AUT's `close()` throws — the error lists every AUT that
 *   failed, by name, not just the first.
 */
export async function closeAndForgetEveryAUTAndAPI(): Promise<void> {
  const entries = [...autRegistry.entries()];
  autRegistry.clear();
  apiRegistry.clear();

  const results = await Promise.allSettled(entries.map(([, wrapper]) => wrapper.close()));
  const failures = results
    .map((result, index) => (result.status === 'rejected' ? `[${entries[index][0]}]: ${Utils.errorMessage(result.reason)}` : undefined))
    .filter((failure): failure is string => !Utils.isUndefined(failure));

  if (failures.length > 0) {
    logAndThrow('AUT', `failed to close ${failures.length} AUT(s) during teardown:\n${failures.join('\n')}`);
  }
}

/**
 * Verifies both registries are empty at the very start of the *next* test — backs
 * `API_AUTWrapper.assertNoAUTsOrAPIsStillRegistered()`, a genuinely independent check from
 * `assertNoManagedAUTPortsOpen`, catching a different failure mode entirely:
 *
 * - This one: did the previous test's own {@link closeAndForgetEveryAUTAndAPI} (called by
 *   `@controlium/framework`'s `afterTest()`) run *at all*? It always clears both registries
 *   unconditionally, *before* awaiting a single `close()` call, specifically so one failing
 *   `close()` could never leave them half-populated — so either registry can only still have
 *   entries here if `afterTest()` itself never ran to completion (the process was killed
 *   mid-test, an uncaught exception escaped before the hook fired, etc.), a catastrophic
 *   failure, not an ordinary teardown bug.
 * - `assertNoManagedAUTPortsOpen`: given that teardown *did* run, did it actually free up the
 *   port it claimed to?
 *
 * This one is a pure in-memory check (no socket I/O) and fires for *every* registered name,
 * including one never started at all (see `API_AUTWrapper.prepareApplication`'s external-target
 * pattern) — `assertNoManagedAUTPortsOpen` only ever has something to say about a name this
 * process actually bootstrapped, so it would stay silent for exactly the case this one exists
 * to catch: a stale, never-started registration surviving into the next test even though
 * nothing is "still open" for that name at all.
 *
 * @throws {Error} listing every `appName` still present in either registry, if any are.
 */
export function assertNothingLeftRegisteredFromLastTest(): void {
  const staleAUTNames = [...autRegistry.keys()];
  const staleAPINames = [...apiRegistry.keys()];
  if (staleAUTNames.length > 0 || staleAPINames.length > 0) {
    logAndThrow(
      'AUT',
      `${staleAUTNames.length} application(s) still registered at test start — the previous ` +
      `test's afterTest()/closeAllAUTsAndAPIs() never ran to completion: [${staleAUTNames.join(', ')}]` +
      (staleAPINames.length > 0
        ? ` (plus ${staleAPINames.length} API(s) still registered: [${staleAPINames.join(', ')}])`
        : '')
    );
  }
}
