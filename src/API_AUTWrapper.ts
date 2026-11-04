import { existsSync } from 'node:fs';
import net from 'node:net';

import { config as loadDotenvFile } from 'dotenv';

import { APIUtils, Detokeniser, JsonUtils, Log, LogLevels, Settings, Utils, ValueExpression } from '@controlium/utils';
import type { LogLevel } from '@controlium/utils';

/**
 * Wrapper around an Application Under Test (AUT) for API-level automated testing.
 *
 * Each instance manages the full lifecycle of one locally-running HTTP service —
 * starting it, sending requests, recording transactions, and shutting it down.
 * Multiple instances can run simultaneously, each independently controlling its
 * own AUT.
 *
 * The wrapper never touches the AUT handle itself — it's opaque (type `Handle`). All
 * three lifecycle operations are supplied by the caller as plain functions:
 * `bootstrapper` starts the AUT and returns a handle of whatever shape the AUT
 * naturally has (a NestJS `INestApplication`, a raw `http.Server`, a Fastify
 * instance, anything); `closeHandler` and `getUrlHandler` are given that same
 * handle back and do whatever is needed to close it / determine its URL. This
 * keeps `API_AUTWrapper` genuinely framework-agnostic — it never assumes the
 * handle has particular methods on it.
 *
 * ### Typical usage — single AUT (e.g. in a Cucumber hook file)
 *
 * ```typescript
 * import { API_AUTWrapper } from '@controlium/framework';
 * import { NestFactory }     from '@nestjs/core';
 * import { AppModule }       from '../src/app.module';
 *
 * let api: API_AUTWrapper<INestApplication>;
 *
 * Before(async () => {
 *   api = await API_AUTWrapper.create({
 *     appName: 'MyAPI',
 *     port: 3000,
 *     bootstrapper: async (port) => {
 *       const app = await NestFactory.create(AppModule);
 *       await app.listen(port);
 *       return app;
 *     },
 *     closeHandler:  (app) => app.close(),
 *     getUrlHandler: (app) => app.getUrl(),
 *   });
 *
 *   // Optionally set session-wide headers (e.g. auth token)
 *   api.setHeaders({ Authorization: `Bearer ${token}` });
 * });
 *
 * When('I GET /users', async () => {
 *   await api.request('GET', '/users');
 * });
 *
 * Then('the response status is {int}', (status: number) => {
 *   expect(api.lastResponse.status).toBe(status);
 * });
 *
 * After(async () => {
 *   await api.close();
 * });
 * ```
 *
 * ### A handle with no built-in close()/getUrl() at all (e.g. raw Express)
 *
 * ```typescript
 * const api = await API_AUTWrapper.create({
 *   appName: 'ExpressAPI',
 *   port: 3000,
 *   bootstrapper: async (port) => {
 *     const server = createServer(expressApp);
 *     await new Promise<void>((resolve) => server.listen(port, resolve));
 *     return server; // the raw http.Server — no adapter object needed
 *   },
 *   closeHandler: (server) => new Promise<void>((resolve, reject) =>
 *     server.close((err) => (err ? reject(err) : resolve()))
 *   ),
 *   getUrlHandler: (server) => {
 *     const addr = server.address();
 *     const port = typeof addr === 'object' && addr ? addr.port : undefined;
 *     return `http://localhost:${port}`;
 *   },
 * });
 * ```
 *
 * ### Multiple simultaneous AUTs
 *
 * ```typescript
 * let authApi:  API_AUTWrapper;
 * let orderApi: API_AUTWrapper;
 *
 * Before(async () => {
 *   authApi  = await API_AUTWrapper.create({ appName: 'AuthAPI',  port: 3001, ...authAutHandlers });
 *   orderApi = await API_AUTWrapper.create({ appName: 'OrderAPI', port: 3002, ...orderAutHandlers });
 * });
 *
 * When('I place an order as an authenticated user', async () => {
 *   await authApi.request('POST', '/login', { body: credentials });
 *   const token = JSON.parse(authApi.lastResponse.body).token;
 *
 *   orderApi.setHeaders({ Authorization: `Bearer ${token}` });
 *   await orderApi.request('POST', '/orders', { body: order });
 * });
 *
 * After(async () => {
 *   await authApi.close();
 *   await orderApi.close();
 * });
 * ```
 *
 * ### Named, settings-driven applications — config in `Before`, start from a step
 *
 * {@link create} starts the AUT immediately and takes its config inline. For a suite that
 * wants config resolved from settings (per-environment profiles, env vars, npm package
 * config — see {@link loadSettings}) and the AUT's actual start to be its own visible,
 * logged test action — e.g. a Cucumber step — use {@link prepareApplication} and
 * {@link startApplication} instead:
 *
 * ```typescript
 * Before(function () {
 *   // Resolves config for 'MyAPI' from settings; does NOT start it yet.
 *   API_AUTWrapper.prepareApplication('MyAPI', {
 *     bootstrapper: async (port) => { const app = await NestFactory.create(AppModule); await app.listen(port); return app; },
 *     closeHandler: (app) => app.close(),
 *   });
 * });
 *
 * Given('Application [{word}] is running', async (appName: string) => {
 *   await API_AUTWrapper.startApplication(appName); // actually starts it
 * });
 *
 * After(async () => {
 *   await API_AUTWrapper.stopApplication('MyAPI');
 * });
 * ```
 */
export class API_AUTWrapper<Handle = unknown> {

  // ─── Instance configuration ───────────────────────────────────────────────

  private _appName: string;
  private _host: string;
  private _port?: number;
  private _protocol: 'http' | 'https';
  private _requestTimeout: number;
  private _proxy?: string;
  private _resourcePathPreamble?: string;
  // The "fixed" preamble value — what resourcePathPreamble gets recomputed FROM whenever a
  // named preamble is selected (see useResourcePathPreamble), kept separate from
  // _resourcePathPreamble itself (the EFFECTIVE value request() reads) specifically so
  // switching named preambles never accumulates onto a previous selection — each switch
  // recomputes fresh from this same base, never from whatever the last switch left behind.
  private _resourcePathPreambleBase?: string;
  private _namedResourcePathPreambles: Record<string, string> = {};
  private _autHandlerTimeout: number;
  private _headers: APIUtils.HTTPHeaders = {};
  private _queryParams: APIUtils.QueryParams = {};

  // ─── Instance state ───────────────────────────────────────────────────────

  private _bootstrapper?: API_AUTWrapper.Bootstrapper<Handle>;
  private _closeHandler?: API_AUTWrapper.CloseHandler<Handle>;
  private _getUrlHandler?: API_AUTWrapper.GetUrlHandler<Handle>;
  private _isControlled: boolean = false;
  private _transactions: API_AUTWrapper.Transaction[] = [];
  private _handle?: Handle;

  // ─── Static factory ───────────────────────────────────────────────────────

  /**
   * Creates, configures, and starts a new AUT instance.
   *
   * This is the primary entry point. The returned instance is ready to receive
   * requests immediately. Call {@link close} on the instance when done — or let
   * `@controlium/framework`'s own `afterTest()` do it automatically via
   * {@link closeAllRegistered}, since this method registers the result the same way
   * {@link prepareApplication} does (see {@link getApplication}/{@link closeAllRegistered}).
   *
   * The caller is responsible for choosing `port` — including offsetting it to
   * avoid collisions when tests run in parallel (e.g. multiple Cucumber/Vitest
   * workers each starting their own copy of the AUT). Loading any `.env` file
   * the bootstrapper depends on is also the caller's responsibility, before
   * calling `create()`.
   *
   * @param details.appName - Name this AUT is registered under (see {@link getApplication}),
   *   and the display name used in log output. Defaults to `'AUT'` when omitted — fine for
   *   a suite controlling exactly one AUT, where nothing needs to address it by a more
   *   specific name.
   * @param details.port - Port the AUT will listen on.
   * @param details.bootstrapper - Function that starts the AUT and returns a handle of type `Handle`.
   *   The handle's shape is entirely up to the caller — it's never inspected by the wrapper.
   * @param details.closeHandler - Given the handle, closes the AUT. Required whenever
   *   `bootstrapper` is provided — without it {@link close} cannot tear the AUT down and
   *   it would leak (port stays bound, process keeps running).
   * @param details.getUrlHandler - Given the handle, returns the AUT's URL. Optional —
   *   only needed if the caller will use {@link autURL} or {@link isLive}.
   * @param details.host - Hostname to use (must be `'localhost'`). Defaults to `'localhost'`.
   * @param details.protocol - `'http'` or `'https'`. Defaults to `'http'`.
   * @param details.requestTimeout - Request timeout in ms. Defaults to `30_000`.
   * @param details.proxy - Optional proxy URL.
   * @param details.autHandlerTimeout - Maximum time in ms to wait for `bootstrapper`,
   *   `closeHandler`, or `getUrlHandler` to settle before treating them as hung.
   *   Defaults to `30_000`.
   * @returns A started {@link API_AUTWrapper} instance.
   * @throws {Error} if `bootstrapper` or `closeHandler` is missing or not a function,
   *   `getUrlHandler` is provided but not a function, no port is set, host is not
   *   localhost, `bootstrapper` throws, rejects, resolves with `null`/`undefined`,
   *   does not settle within `autHandlerTimeout`, or `appName` is already registered
   *   and currently running (`close()` it first).
   */
  public static async create<Handle = unknown>(details: API_AUTWrapper.CreateDetails<Handle> | null): Promise<API_AUTWrapper<Handle>> {
    // `details` is the very first thing any caller touches — validate before reading a
    // single property off it. `appName` isn't known yet (that's what we're validating),
    // so error messages up to this point use the fixed 'AUT' label.
    requireObject(details, 'AUT', 'create() details');
    const wrapper = new API_AUTWrapper<Handle>({
      appName:  details.appName,
      port:     details.port,
      host:     details.host,
      protocol: details.protocol,
      requestTimeout:  details.requestTimeout,
      proxy:    details.proxy,
      autHandlerTimeout: details.autHandlerTimeout,
    });

    // Same collision rule as prepareApplication: a name already registered and still
    // running is a caller error (two live AUTs fighting over one name), not something to
    // silently clobber — but a name registered and already closed (or never started) is
    // fine to replace outright.
    const existingEntry = API_AUTWrapper._registry.get(wrapper.appName);
    if (!Utils.isUndefined(existingEntry) && existingEntry.isControlled) {
      fail(wrapper.appName, 'is already running — close() it before calling create() again with the same name');
    }

    wrapper._closeHandler  = details.closeHandler;
    wrapper._getUrlHandler = details.getUrlHandler;
    await wrapper._startAUT(details.bootstrapper);
    API_AUTWrapper._registry.set(wrapper.appName, wrapper as unknown as API_AUTWrapper);
    API_AUTWrapper._rememberEndpoint(wrapper.appName, wrapper.host, wrapper.port);
    return wrapper;
  }

  // ─── Named application registry ────────────────────────────────────────────

  /**
   * Named-application registry used by {@link create}/{@link prepareApplication}/
   * {@link startApplication}/{@link stopApplication}/{@link getApplication}/
   * {@link closeAllRegistered}. Keyed by `appName` (defaulting to `'AUT'` when a caller
   * doesn't give one — see {@link create}). Every AUT this class creates or prepares ends
   * up in here, regardless of which of those two entry points built it, so
   * {@link getApplication} can always find it by name afterwards and
   * {@link closeAllRegistered} can always close it at the end of a test — a caller is still
   * always free to hold onto the instance a method returns directly instead of looking it
   * up again by name.
   */
  private static _registry = new Map<string, API_AUTWrapper>();

  /**
   * Every AUT name this process has itself actually **bootstrapped** — i.e. a real
   * `bootstrapper` was supplied and genuinely invoked for it — with its resolved `host`/
   * `port`. Additive only, deliberately **never** cleared by {@link closeAllRegistered}
   * (unlike {@link _registry} itself), so {@link assertNoKnownAUTsStillListening} has
   * something to check against at the start of the *next* test, after this test's own
   * teardown has already wiped {@link _registry} clean.
   *
   * Deliberately **not** every name {@link create}/{@link prepareApplication} has ever
   * registered — only this narrower set. A name `prepareApplication`d (or settings-only,
   * never `startApplication`d) purely to reach a genuinely external/already-running target
   * — see {@link prepareApplication}'s own doc comment — was never started by this process
   * in the first place, so there is nothing for "is it still listening" to mean anything
   * about: that target being reachable is the correct, desired state, not evidence of a
   * leaked teardown. Including it here would make {@link assertNoKnownAUTsStillListening}
   * fail permanently, every test, the moment any test ever touches such a target.
   */
  private static _everKnownEndpoints = new Map<string, { host: string; port: number }>();

  /**
   * Records `appName`'s resolved `host`/`port` into {@link _everKnownEndpoints}, if `port`
   * is actually known yet — called by {@link create} unconditionally (a real `bootstrapper`
   * is always required there, enforced by {@link _startAUT} before this is ever reached) and
   * by {@link prepareApplication} only when a `bootstrapper` was actually supplied (see
   * {@link _everKnownEndpoints}'s own doc comment for why that guard matters there
   * specifically).
   */
  private static _rememberEndpoint(appName: string, host: string, port: number | undefined): void {
    if (!Utils.isUndefined(port)) {
      API_AUTWrapper._everKnownEndpoints.set(appName, { host, port });
    }
  }

  /**
   * Resolves a named application's configuration entirely from settings (see
   * {@link loadSettings}) and registers the resulting **not-yet-started** instance under
   * `appName`, so {@link startApplication}/{@link stopApplication} can reach it later by
   * name. Deliberately synchronous and side-effect-free beyond config resolution — it never
   * invokes `handlers.bootstrapper`; only {@link startApplication} does that.
   *
   * Splitting "resolve config and register the handler functions" from "actually start the
   * process" exists so a suite can prepare every named application it needs up front (e.g.
   * once per scenario, in a `Before` hook) while leaving *when* each one actually starts to
   * something more granular and visible — e.g. a Cucumber step like
   * `Given Application [<name>] is running`, where the step itself is what starts the AUT,
   * rather than a hook silently doing it ahead of time.
   *
   * Unlike {@link create}, `host`/`port`/`protocol`/`requestTimeout`/`proxy`/`autHandlerTimeout`/
   * `resourcePathPreamble` are never supplied inline here — they come exclusively from a
   * mandatory settings block for this `appName` (see {@link loadSettings} for exactly how,
   * and why that's mandatory rather than falling back to defaults). Only the handler
   * *functions* are supplied directly, since those are code, not data, and can't
   * meaningfully come from a settings/profile system.
   *
   * Use {@link create} directly instead, with inline configuration, for an AUT that
   * genuinely needs no settings-driven configuration at all.
   *
   * `handlers` with no `bootstrapper` at all (e.g. `{}`) is a legitimate, intentional way to
   * use this — not just "prepared, start it later" but "this process will *never* start it":
   * registering a genuinely external/already-running target purely to resolve its
   * settings-driven `host`/`port`/`protocol` under a name, so {@link request} can reach it
   * exactly like any self-bootstrapped AUT, without this process ever claiming to own its
   * lifecycle. Such an instance is deliberately excluded from
   * {@link assertNoKnownAUTsStillListening}'s domain (see {@link _everKnownEndpoints}'s own
   * doc comment) — this process never started it, so it has nothing to verify was stopped.
   *
   * @param appName - Name this application is registered under, and the key used to look
   *   up its settings block. Required, non-empty — there is no default name.
   * @param handlers - The lifecycle handler functions — same meaning as on {@link create}.
   * @returns The prepared, not-yet-started {@link API_AUTWrapper} instance. Capturing it is
   *   optional; {@link startApplication}/{@link stopApplication} can reach the same instance
   *   by name instead.
   * @throws {Error} if `appName` is missing, if this name is already registered **and
   *   currently running** (stop it via {@link stopApplication} before preparing it again —
   *   re-preparing a running app would resolve new configuration without anything actually
   *   re-binding to it), or if {@link loadSettings} finds no settings configured for
   *   `appName`.
   */
  public static prepareApplication<Handle = unknown>(
    appName: string,
    handlers: API_AUTWrapper.PrepareApplicationHandlers<Handle> | null
  ): API_AUTWrapper<Handle> {
    requireNonEmptyString(appName, 'AUT', 'appName');
    requireObject(handlers, appName, 'prepareApplication handlers');

    const existing = API_AUTWrapper._registry.get(appName);
    if (!Utils.isUndefined(existing) && existing.isControlled) {
      fail(appName, 'is already running — stopApplication() it before preparing it again');
    }

    const wrapper = new API_AUTWrapper<Handle>({ appName });
    wrapper.loadSettings();
    wrapper._bootstrapper  = handlers.bootstrapper;
    wrapper._closeHandler  = handlers.closeHandler;
    wrapper._getUrlHandler = handlers.getUrlHandler;

    // The registry is deliberately type-erased (`Map<string, API_AUTWrapper>`, no generic) —
    // different named apps can have entirely different `Handle` types, and nothing reading
    // from the registry (just startApplication's/stopApplication's own calls) needs to know
    // what it is.
    API_AUTWrapper._registry.set(appName, wrapper as unknown as API_AUTWrapper);
    // Only remember this endpoint for assertNoKnownAUTsStillListening's sake when a real
    // bootstrapper was actually supplied — i.e. this process might genuinely start it later.
    // Without one, startApplication() can never be called for this name at all ever (it
    // would fail with "no bootstrapper set"), so this process will never own stopping it
    // either — see _everKnownEndpoints' own doc comment for why that distinction matters.
    if (!Utils.isUndefined(handlers.bootstrapper)) {
      API_AUTWrapper._rememberEndpoint(appName, wrapper.host, wrapper.port);
    }
    Log.writeLine(LogLevels.FrameworkDebug, `[${appName}] prepared — not yet started`);
    return wrapper;
  }

  /**
   * Starts the named application previously configured by {@link prepareApplication} —
   * invokes its bootstrapper and brings it up. Separate from {@link prepareApplication} so
   * "this AUT is now running" can be a visible, logged test action in its own right (e.g. a
   * Cucumber step) rather than something a hook already did silently before the test even
   * began.
   *
   * Calling this again for an already-running app restarts it — {@link _startAUT} already
   * closes-and-restarts internally when a handle is already present, so nothing extra is
   * needed here for that.
   *
   * @param appName - The name passed to {@link prepareApplication}.
   * @returns The started {@link API_AUTWrapper} instance.
   * @throws {Error} if `appName` is missing or was never prepared (did
   *   {@link prepareApplication} run for this name first?), or for the same
   *   bootstrapper/closeHandler/port-related reasons as {@link create}.
   */
  public static async startApplication<Handle = unknown>(appName: string): Promise<API_AUTWrapper<Handle>> {
    requireNonEmptyString(appName, 'AUT', 'appName');
    const wrapper = API_AUTWrapper._registry.get(appName);
    if (Utils.isUndefined(wrapper)) {
      fail(appName, 'is not prepared — call prepareApplication() first (did your suite wire this app up in Before?)');
    }
    await wrapper._startAUT();
    return wrapper as API_AUTWrapper<Handle>;
  }

  /**
   * Stops the named application previously started by {@link startApplication} —
   * equivalent to calling {@link close} directly on the instance, for callers that only
   * have the name, not the instance itself.
   *
   * Deliberately leaves the application **registered** (still prepared) after stopping, so
   * {@link startApplication} can restart it by name without a fresh
   * {@link prepareApplication} call — stopping and starting are each other's inverse; only
   * {@link prepareApplication} itself re-resolves configuration or replaces the handler
   * functions.
   *
   * @param appName - The name passed to {@link prepareApplication}.
   * @throws {Error} if no application is currently registered under `appName`. Deliberately
   *   not a silent no-op (unlike {@link close}, which is always safe to call): a name that
   *   was never prepared is far more likely a typo or a logic bug in the caller than
   *   something to swallow quietly.
   */
  public static async stopApplication(appName: string): Promise<void> {
    requireNonEmptyString(appName, 'AUT', 'appName');
    const wrapper = API_AUTWrapper._registry.get(appName);
    if (Utils.isUndefined(wrapper)) {
      fail(appName, 'is not registered — nothing to stop (did prepareApplication()/startApplication() run for this name?)');
    }
    await wrapper.close();
  }

  /**
   * Finds an already-registered {@link API_AUTWrapper} instance by name — the same instance
   * {@link create}/{@link prepareApplication} returned, found by name rather than by holding
   * onto the reference directly. Purely a lookup: never starts, stops, or changes anything,
   * so it's always safe to call, as many times as needed.
   *
   * @param appName - The name to look up (the one passed to `create`/`prepareApplication`,
   *   or `'AUT'` if neither gave one explicitly). Omit entirely — or pass `undefined` — to
   *   mean "the AUT": this resolves to the single currently-registered instance, which only
   *   works when exactly one is registered. With zero or more than one, there is nothing a
   *   bare "AUT" could mean unambiguously, so this throws rather than guessing which one —
   *   e.g. for a Cucumber step wired to accept either `AUT` or `[<name>]` as its target.
   * @returns The registered instance.
   * @throws {Error} If `appName` is given but nothing is registered under that name; or if
   *   `appName` is omitted and zero, or more than one, AUT is currently registered.
   */
  public static getApplication<Handle = unknown>(appName?: string): API_AUTWrapper<Handle> {
    if (Utils.isUndefined(appName)) {
      const registered = [...API_AUTWrapper._registry.entries()];
      if (registered.length === 0) {
        fail('AUT', 'cannot resolve — no AUT is currently registered (did create()/prepareApplication() run first?)');
      }
      if (registered.length > 1) {
        fail('AUT', `cannot resolve — ${registered.length} AUTs are currently registered ([${registered.map(([name]) => name).join(', ')}]); specify which one by name`);
      }
      return registered[0][1] as API_AUTWrapper<Handle>;
    }
    requireNonEmptyString(appName, 'AUT', 'appName');
    const wrapper = API_AUTWrapper._registry.get(appName);
    if (Utils.isUndefined(wrapper)) {
      fail(appName, 'is not registered — nothing to find (did create()/prepareApplication() run for this name?)');
    }
    return wrapper as API_AUTWrapper<Handle>;
  }

  /**
   * Closes every currently-registered AUT and clears the registry entirely, regardless of
   * whether each one was ever actually started ({@link close} already safely no-ops for one
   * that wasn't). Called automatically by `@controlium/framework`'s own `afterTest()` so a
   * test never has to remember to close what it registered, and so — per
   * [[feedback_test_atomicity_non_negotiable]] — no registered AUT can ever leak into
   * whatever test runs next, regardless of whether that test ever calls `create()`/
   * `prepareApplication()` itself.
   *
   * The registry is cleared *before* any `close()` call settles, not after — so even if
   * closing one AUT throws, the next test still starts with zero AUTs registered. Every
   * failure is still collected and reported (not just the first) so a flaky/broken
   * `closeHandler` is never silently swallowed; this class still never touches *how* an AUT
   * actually closes, same as everywhere else — that's still entirely the suite's own
   * `closeHandler` callback, invoked by each instance's own {@link close}.
   *
   * @throws {Error} If any registered AUT's `close()` throws — the error lists every AUT
   *   that failed, by name, not just the first.
   */
  public static async closeAllRegistered(): Promise<void> {
    const entries = [...API_AUTWrapper._registry.entries()];
    API_AUTWrapper._registry.clear();

    const results = await Promise.allSettled(entries.map(([, wrapper]) => wrapper.close()));
    const failures = results
      .map((result, index) => (result.status === 'rejected' ? `[${entries[index][0]}]: ${Utils.errorMessage(result.reason)}` : undefined))
      .filter((failure): failure is string => !Utils.isUndefined(failure));

    if (failures.length > 0) {
      fail('AUT', `failed to close ${failures.length} AUT(s) during teardown:\n${failures.join('\n')}`);
    }
  }

  /**
   * Verifies {@link _registry} itself is empty at the very start of the *next* test — a
   * genuinely independent check from {@link assertNoKnownAUTsStillListening}, catching a
   * different failure mode entirely, not a stronger/weaker version of the same one:
   *
   * - This one: did the previous test's own {@link closeAllRegistered} (called by
   *   `@controlium/framework`'s `afterTest()`) run *at all*? {@link closeAllRegistered}
   *   always clears {@link _registry} unconditionally, *before* awaiting a single `close()`
   *   call, specifically so one failing `close()` could never leave it half-populated — so
   *   {@link _registry} can only still have entries here if `afterTest()` itself never ran
   *   to completion (the process was killed mid-test, an uncaught exception escaped before
   *   the hook fired, etc.), a catastrophic failure, not an ordinary teardown bug.
   * - {@link assertNoKnownAUTsStillListening}: given that teardown *did* run, did it actually
   *   free up the port it claimed to?
   *
   * Each catches what the other structurally can't: this one is a pure in-memory check (no
   * socket I/O) and fires for *every* registered name, including one never started at all
   * (see {@link prepareApplication}'s external-target pattern) — {@link
   * assertNoKnownAUTsStillListening} only ever has something to say about a name this
   * process actually bootstrapped (see {@link _everKnownEndpoints}'s own doc comment), so it
   * would stay silent for exactly the case this one exists to catch: a stale, never-started
   * registration (with its own stale `transactions`/`headers`/session state) surviving into
   * the next test even though nothing is "still listening" for that name at all.
   *
   * @throws {Error} listing every `appName` still present in the registry, if any are.
   */
  public static assertRegistryIsEmpty(): void {
    const staleNames = [...API_AUTWrapper._registry.keys()];
    if (staleNames.length > 0) {
      fail(
        'AUT',
        `${staleNames.length} application(s) still registered at test start — the previous ` +
        `test's afterTest()/closeAllRegistered() never ran to completion: [${staleNames.join(', ')}]`
      );
    }
  }

  /**
   * Verifies none of this process's ever-known AUT endpoints ({@link _everKnownEndpoints})
   * still has anything listening — meant to be called at the very start of the *next* test,
   * before it does anything else, so a previous test's teardown failure (a genuine bug, or a
   * badly-behaved AUT that ignored its own shutdown signal) is caught immediately rather than
   * silently letting the next test start against a stale, still-running instance.
   *
   * Deliberately checks real socket connectivity, not `isControlled`/the internal handle —
   * {@link close} marks both false/undefined unconditionally, even when the underlying
   * `closeHandler` itself threw, so neither actually reflects whether the AUT genuinely
   * stopped. Deliberately scoped to {@link _everKnownEndpoints} rather than every name
   * {@link create}/{@link prepareApplication} has ever registered — see that field's own
   * doc comment for why a never-started/externally-owned target is excluded.
   *
   * @throws {Error} listing every `appName`/`host:port` still listening, if any are.
   */
  public static async assertNoKnownAUTsStillListening(): Promise<void> {
    const stillListening: string[] = [];
    for (const [appName, { host, port }] of API_AUTWrapper._everKnownEndpoints) {
      if (await isPortListening(host, port)) {
        stillListening.push(`[${appName}] ${host}:${port}`);
      }
    }
    if (stillListening.length > 0) {
      fail(
        'AUT',
        `${stillListening.length} AUT(s) still have something listening at test start — the previous test's teardown did not actually stop them:\n${stillListening.join('\n')}`
      );
    }
  }

  // ─── One-shot "next request" header override ───────────────────────────────

  /**
   * A one-shot header override for whichever AUT's {@link request} fires next — genuinely
   * global, not scoped to any particular instance. There's no AUT to target here (a test
   * stages this without naming one), so it can't live as instance state; it has to be a
   * single piece of class-level state that *any* instance's `request()` checks and consumes.
   *
   * Set via {@link setNextRequestHeaders}/{@link mergeNextRequestHeaders}. Consumed by the
   * very next {@link request} call made on *any* instance, then cleared immediately — not
   * "the next call to this particular AUT", but genuinely whichever call happens next,
   * anywhere. Also cleared unconditionally by {@link clearNextRequestHeaders}, which
   * `@controlium/framework`'s own `afterTest()` calls every time, so a staged-but-never-used
   * (or request-that-threw) override can never leak into the next test.
   *
   * `dataTableValueExpressions` — raw, **unresolved** `ValueExpression.parse` source text
   * from a DataTable `Value` column, keyed the same as `headers` — is carried separately
   * from `headers` itself, rather than pre-resolved and merged in at staging time. See
   * {@link setNextRequestHeaders}'s own doc comment for why: a one-shot override's whole
   * point is reflecting the freshest possible state at the moment it's actually consumed,
   * and resolving a DataTable cell's verb-grammar (which detokenises as part of resolving —
   * see `ValueExpression.parse`'s own doc comment) eagerly, at staging time, would silently
   * defeat that for exactly the entries that came from a DataTable.
   */
  private static _pendingNextRequestHeaders?: {
    mode: 'replace' | 'merge';
    headers: APIUtils.HTTPHeaders;
    dataTableValueExpressions?: Record<string, string>;
  };

  /**
   * Stages a one-shot header override that *replaces* session headers entirely — but only
   * for whichever AUT's {@link request} fires next, across the whole test, regardless of
   * which AUT that turns out to be. See {@link _pendingNextRequestHeaders} for why this is
   * static rather than scoped to one instance.
   *
   * Same detokenise-then-sentinel-resolve treatment as {@link setHeaders}, applied lazily at
   * the moment {@link request} actually consumes the override (not here) — merge mode needs
   * to see whatever that AUT's session headers are *at that moment*, not a snapshot taken
   * when this was staged.
   *
   * @param headers - The literal/file-sourced portion — plain, already-typed values (never
   *   containing `ValueExpression` verb-grammar); any string value may still carry an
   *   unresolved token, detokenised later, same as `headers` everywhere else in this class.
   * @param dataTableValueExpressions - The DataTable-sourced portion, if any, as **raw,
   *   unresolved** `ValueExpression.parse` source text per key — see
   *   {@link _pendingNextRequestHeaders}'s own doc comment for why this stays unresolved
   *   until {@link request} actually consumes it. A key here always wins over the same key
   *   in `headers` once resolved, matching `@controlium/cucumber-driver`'s own
   *   DataTable-always-wins convention.
   * @throws {Error} If `headers` is not a non-null object.
   */
  public static setNextRequestHeaders(headers: APIUtils.HTTPHeaders | null, dataTableValueExpressions?: Record<string, string>): void {
    requireObject(headers, 'AUT', 'headers');
    API_AUTWrapper._pendingNextRequestHeaders = { mode: 'replace', headers, dataTableValueExpressions };
  }

  /**
   * Stages a one-shot header override that *merges* onto session headers — but only for
   * whichever AUT's {@link request} fires next. See {@link setNextRequestHeaders} for the
   * rest; the only difference is `replace` vs `merge` once consumed.
   *
   * @throws {Error} If `headers` is not a non-null object.
   */
  public static mergeNextRequestHeaders(headers: APIUtils.HTTPHeaders | null, dataTableValueExpressions?: Record<string, string>): void {
    requireObject(headers, 'AUT', 'headers');
    API_AUTWrapper._pendingNextRequestHeaders = { mode: 'merge', headers, dataTableValueExpressions };
  }

  /**
   * Clears any staged one-shot header override without it ever being applied to a request.
   * Called automatically, unconditionally, by `@controlium/framework`'s own `afterTest()` —
   * a test that stages one and never triggers the request it was meant for (or whose request
   * throws before completing) must never leak it into whatever test runs next. Also called
   * internally by {@link request} itself the moment it consumes a pending override, win or
   * lose — "used once, for the very next call, period" has no exceptions.
   *
   * Safe to call when nothing is staged.
   */
  public static clearNextRequestHeaders(): void {
    API_AUTWrapper._pendingNextRequestHeaders = undefined;
  }

  // ─── One-shot "next request" query-params override ─────────────────────────

  /**
   * A one-shot query-params override for whichever AUT's {@link request} fires next —
   * genuinely global, exactly the same shape and lifecycle as
   * {@link _pendingNextRequestHeaders} (see its own doc comment for the full reasoning,
   * not repeated here, including why `dataTableValueExpressions` stays unresolved until
   * {@link request} actually consumes it).
   */
  private static _pendingNextRequestQueryParams?: {
    mode: 'replace' | 'merge';
    queryParams: APIUtils.QueryParams;
    dataTableValueExpressions?: Record<string, string>;
  };

  /**
   * Stages a one-shot query-params override that *replaces* session query params entirely
   * — but only for whichever AUT's {@link request} fires next. Same lifecycle/detokenise
   * timing as {@link setNextRequestHeaders} — see its own doc comment, including the
   * `dataTableValueExpressions` parameter.
   *
   * @throws {Error} If `queryParams` is not a non-null object.
   */
  public static setNextRequestQueryParams(queryParams: APIUtils.QueryParams | null, dataTableValueExpressions?: Record<string, string>): void {
    requireObject(queryParams, 'AUT', 'queryParams');
    API_AUTWrapper._pendingNextRequestQueryParams = { mode: 'replace', queryParams, dataTableValueExpressions };
  }

  /**
   * Stages a one-shot query-params override that *merges* onto session query params — but
   * only for whichever AUT's {@link request} fires next. See {@link setNextRequestQueryParams}
   * for the rest; the only difference is `replace` vs `merge` once consumed.
   *
   * @throws {Error} If `queryParams` is not a non-null object.
   */
  public static mergeNextRequestQueryParams(queryParams: APIUtils.QueryParams | null, dataTableValueExpressions?: Record<string, string>): void {
    requireObject(queryParams, 'AUT', 'queryParams');
    API_AUTWrapper._pendingNextRequestQueryParams = { mode: 'merge', queryParams, dataTableValueExpressions };
  }

  /**
   * Clears any staged one-shot query-params override without it ever being applied to a
   * request. Same automatic-clearing guarantee (via `afterTest()`) as
   * {@link clearNextRequestHeaders} — see its own doc comment.
   *
   * Safe to call when nothing is staged.
   */
  public static clearNextRequestQueryParams(): void {
    API_AUTWrapper._pendingNextRequestQueryParams = undefined;
  }

  // ─── Constructor ──────────────────────────────────────────────────────────

  /**
   * Creates an unconfigured, not-yet-started instance.
   * Prefer {@link create} to obtain a fully started instance.
   *
   * @param config - Optional initial configuration. All properties default to
   *   the same values as the class defaults if omitted.
   */
  constructor(config: {
    appName?:  string;
    port?:     number;
    host?:     string;
    protocol?: 'http' | 'https';
    requestTimeout?:  number;
    proxy?:    string;
    autHandlerTimeout?: number;
  } | null = {}) {
    // `config` is typed as an optional object, but nothing stops a caller — especially
    // a plain-JS or `any`-typed one — from passing `null` explicitly (which bypasses the
    // `= {}` default, since defaults only apply to `undefined`) or something that isn't
    // an object at all. Every field below is re-validated at runtime for the same reason:
    // the static type is a compile-time promise only, never a runtime guarantee.
    requireObject(config, 'AUT', 'config');

    const appName = config.appName ?? 'AUT';
    requireNonEmptyString(appName, 'AUT', 'appName');
    this._appName = appName;

    const host = config.host ?? 'localhost';
    requireNonEmptyString(host, this._appName, 'host');
    this._host = host;

    if (!Utils.isUndefined(config.port)) {
      requirePort(config.port, this._appName, 'port');
    }
    this._port = config.port;

    const protocol = config.protocol ?? 'http';
    requireProtocol(protocol, this._appName, 'protocol');
    this._protocol = protocol;

    const requestTimeout = config.requestTimeout ?? 30_000;
    requirePositiveNumber(requestTimeout, this._appName, 'requestTimeout');
    this._requestTimeout = requestTimeout;

    if (!Utils.isUndefined(config.proxy)) {
      requireNonEmptyString(config.proxy, this._appName, 'proxy');
    }
    this._proxy = config.proxy;

    const autHandlerTimeout = config.autHandlerTimeout ?? 30_000;
    requirePositiveNumber(autHandlerTimeout, this._appName, 'autHandlerTimeout');
    this._autHandlerTimeout = autHandlerTimeout;
  }

  // ─── Config: appName ──────────────────────────────────────────────────────

  /**
   * Display name used in log output to identify this AUT.
   * @default 'AUT'
   */
  public set appName(value: string) {
    requireNonEmptyString(value, this._appName, 'appName');
    this._appName = value;
  }
  /** @see {@link appName} setter */
  public get appName(): string { return this._appName; }

  // ─── Config: host ─────────────────────────────────────────────────────────

  /**
   * Hostname the AUT listens on. Must be `'localhost'` for any AUT this process actually
   * bootstraps itself — enforced at start time by {@link _startAUT}, not here, since this
   * setter alone can't yet know whether `startApplication()`/`create()` will ever be called
   * for this instance. A {@link prepareApplication}-only instance that's never started at all
   * (the external-target pattern — see that method's own doc comment) has no such
   * restriction: `_startAUT` never runs for it, so a genuinely remote `host` is legitimate.
   * @default 'localhost'
   */
  public set host(value: string) {
    requireNonEmptyString(value, this._appName, 'host');
    this._host = value;
  }
  /** @see {@link host} setter */
  public get host(): string { return this._host; }

  // ─── Config: port ─────────────────────────────────────────────────────────

  /**
   * Port the AUT listens on. Must be set before calling {@link create} or {@link request}.
   */
  public set port(value: number) {
    requirePort(value, this._appName, 'port');
    this._port = value;
  }
  /** @see {@link port} setter */
  public get port(): number | undefined { return this._port; }

  // ─── Config: protocol ─────────────────────────────────────────────────────

  /**
   * Protocol used when communicating with this AUT.
   * @default 'http'
   */
  public set protocol(value: 'http' | 'https') {
    requireProtocol(value, this._appName, 'protocol');
    this._protocol = value;
  }
  /** @see {@link protocol} setter */
  public get protocol(): 'http' | 'https' { return this._protocol; }

  // ─── Config: requestTimeout ───────────────────────────────────────────────

  /**
   * Maximum time in milliseconds to wait for this AUT to respond to a request.
   * @default 30_000
   */
  public set requestTimeout(value: number) {
    requirePositiveNumber(value, this._appName, 'requestTimeout');
    this._requestTimeout = value;
  }
  /** @see {@link requestTimeout} setter */
  public get requestTimeout(): number { return this._requestTimeout; }

  // ─── Config: autHandlerTimeout ────────────────────────────────────────────

  /**
   * Maximum time in milliseconds to wait for the consumer-supplied `bootstrapper`,
   * `closeHandler`, or `getUrlHandler` to settle before treating them as hung and
   * throwing. Guards against a handler that never resolves/rejects (e.g. a server
   * `close()` waiting forever on a keep-alive connection that never ends).
   * @default 30_000
   */
  public set autHandlerTimeout(value: number) {
    requirePositiveNumber(value, this._appName, 'autHandlerTimeout');
    this._autHandlerTimeout = value;
  }
  /** @see {@link autHandlerTimeout} setter */
  public get autHandlerTimeout(): number { return this._autHandlerTimeout; }

  // ─── Config: proxy ────────────────────────────────────────────────────────

  /**
   * Optional proxy URL to route requests through (e.g. `'http://proxy.example.com:8080'`).
   * Leave undefined to connect directly to the AUT.
   */
  public set proxy(value: string | undefined) {
    if (!Utils.isUndefined(value)) {
      requireNonEmptyString(value, this._appName, 'proxy');
    }
    this._proxy = value;
  }
  /** @see {@link proxy} setter */
  public get proxy(): string | undefined { return this._proxy; }

  // ─── Config: resourcePathPreamble ─────────────────────────────────────────

  /**
   * Optional path segment prepended to every resource path passed to {@link request}.
   * Useful when the AUT mounts all routes under a versioned prefix (e.g. `'/api/v1'`).
   * Cleared on each call to {@link close}.
   *
   * Setting this directly also establishes it as the *base* {@link useResourcePathPreamble}
   * recomputes from — selecting a named preamble afterwards combines with whatever was set
   * here, not with the result of any previous named selection (see that method's own doc
   * comment for why that distinction matters).
   */
  public set resourcePathPreamble(value: string | undefined) {
    if (!Utils.isUndefined(value)) {
      requireString(value, this._appName, 'resourcePathPreamble');
    }
    this._resourcePathPreamble = value;
    this._resourcePathPreambleBase = value;
  }
  /** @see {@link resourcePathPreamble} setter */
  public get resourcePathPreamble(): string | undefined { return this._resourcePathPreamble; }

  /**
   * Switches to a named resource path preamble, resolved from this AUT's settings-driven
   * `resourcePathPreambles` map (`$.testAUTDetails.<appName>.resourcePathPreambles`) — e.g.
   * selecting `'V2'` when that map is `{ V1: '/api/v1', V2: '/api/v2' }` makes every
   * subsequent {@link request} call go to `/api/v2/...` instead.
   *
   * **Replaces, never accumulates.** Each call recomputes {@link resourcePathPreamble}
   * fresh from the *base* value — whatever {@link resourcePathPreamble} held before the
   * first `useResourcePathPreamble` call in this session, from settings or set directly —
   * not from whatever the previous `useResourcePathPreamble` call left behind. So
   * `useResourcePathPreamble('V1')` then `useResourcePathPreamble('V2')` lands on
   * `<base>/api/v2`, never the corrupted `<base>/api/v1/api/v2` a naive
   * always-append implementation would produce by switching twice in the same session.
   *
   * @param name - A key in this AUT's configured `resourcePathPreambles` map.
   * @throws {Error} If no `resourcePathPreambles` map is configured for this AUT, or `name`
   *   isn't a key within it — listing the names that *are* available either way, since a
   *   typo here is far more likely than a genuine "intentionally undefined" case.
   *
   * @example
   * // testAUTDetails.MyApp.resourcePathPreambles = { V1: '/api/v1', V2: '/api/v2' }
   * aut.useResourcePathPreamble('V2'); // subsequent requests go to /api/v2/...
   */
  public useResourcePathPreamble(name: string): void {
    requireNonEmptyString(name, this._appName, 'name');
    const availableNames = Object.keys(this._namedResourcePathPreambles);
    if (!Object.prototype.hasOwnProperty.call(this._namedResourcePathPreambles, name)) {
      fail(
        this._appName,
        availableNames.length === 0
          ? `has no resourcePathPreambles configured at all — cannot select [${name}]. Configure ` +
            `'resourcePathPreambles' under this AUT's settings block first.`
          : `has no resourcePathPreamble named [${name}] — available: [${availableNames.join(', ')}].`
      );
    }
    // Writes the private field directly, deliberately bypassing the public setter above —
    // that setter also updates _resourcePathPreambleBase, which must stay exactly what it
    // was before this call (or any earlier useResourcePathPreamble call) for the
    // never-accumulates guarantee to hold.
    this._resourcePathPreamble = (this._resourcePathPreambleBase ?? '') + this._namedResourcePathPreambles[name];
    Log.writeLine(LogLevels.TestInformation, `[${this._appName}] resource path preamble switched to [${name}]: ${this._resourcePathPreamble}`);
  }

  // ─── Settings ───────────────────────────────────────────────────────────────

  /**
   * Resolves this AUT's configuration from `@controlium/utils`'s settings system
   * (`Settings.get` — env vars, npm package config, and/or whatever `Settings.setContext`
   * currently has active) and applies it directly to this instance via the existing
   * property setters. Called internally by {@link startApplication}; also callable
   * directly — e.g. from a test's own before-hook, to re-resolve the fields that are
   * always safe to change (see below) against that test's own settings context.
   *
   * **A source for `port` is mandatory** — either already set directly (e.g. via
   * {@link create}) or resolved here from settings. `port` is the one field with no
   * sensible framework default, and this is test-automation infrastructure: the test
   * suite must have total, explicit control over what it's testing, not a silent
   * fallback to "it'll probably work." If neither source has it, this throws rather than
   * leaving the AUT half-configured.
   *
   * **`host`/`port`/`protocol` can only change before this AUT is running.** They're
   * bound to the real OS-level listening socket the moment the bootstrapper actually
   * starts it — updating the *stored* value afterwards without the *actual* binding
   * changing would silently corrupt this instance's own state (`request()` would build
   * URLs pointing at the wrong place). Calling `loadSettings()` again while already
   * running is safe as long as the resolved values haven't actually changed; it throws
   * only if one genuinely would.
   *
   * **`requestTimeout`/`proxy`/`autHandlerTimeout`/`resourcePathPreamble` have no such
   * restriction** — `request()` reads them fresh on every call, so reloading them
   * mid-test (e.g. a differently-tagged scenario wanting a longer timeout) is always
   * safe and always applied.
   *
   * **Also resolves `dotEnvPath`** and, if configured, loads it into `process.env` via
   * `dotenv` (with `override: true`, so this AUT's own file always wins for its own keys
   * regardless of what a previously-started sibling app's `.env` already set) — before
   * returning, so it's available to whatever runs next (typically the bootstrapper, via
   * {@link startApplication}). See `~/repos/controlium/PRINCIPLES.md`'s visibility
   * principle: every resolved value and its source is logged here, and a
   * configured-but-missing `.env` file fails loudly rather than silently continuing
   * without it — both deliberate, not oversights.
   *
   * Settings are looked up at `$.<prefix>.<appName>.<field>`, where `<prefix>` defaults
   * to `'testAUTDetails'` (overridable via the `CONTROLIUM_AUT_SETTINGS_PREFIX` env var
   * or the `autSettingsPrefix` npm package config — never via the profile itself, which
   * would be a chicken-and-egg problem) and `<appName>` is this instance's own
   * {@link appName}.
   *
   * @param logLevel - Log level for the one headline summary line (the final effective
   *   configuration, and the "loaded .env file" line if one was configured) — the rest of
   *   the resolution trail always uses its own fixed tier, not this parameter (see
   *   {@link _resolveAndLogSetting} and {@link resolveSettingsPrefix} for the full spread
   *   — `TestDebug` for the per-field outcome, `FrameworkInformation` for where each value
   *   actually came from, `FrameworkDebug` for the rarely-relevant settings-prefix
   *   resolution). Defaults to `TestInformation` — the one line a normal test run's usual
   *   verbosity should show, without the full per-field trail underneath it.
   * @throws {Error} if no `port` is available from any source; if `host`/`port`/`protocol`
   *   would actually change while this AUT is already running; or if a configured
   *   `dotEnvPath` doesn't exist or fails to parse.
   */
  public loadSettings(logLevel: LogLevel = LogLevels.TestInformation): void {
    const prefix = resolveSettingsPrefix();
    const base = `$.${prefix}.${this._appName}`;

    const portResult = this._resolveAndLogSetting(base, 'port');
    if (Utils.isUndefined(portResult.value) && Utils.isUndefined(this._port)) {
      fail(
        this._appName,
        `no 'port' available — not already set, and none configured at '${base}.port' (env var, npm config, ` +
        `and current settings context all came back empty). This app has no way to know what port to use.`
      );
    }
    if (!Utils.isUndefined(portResult.value)) {
      const resolvedPort = coerceToNumber(portResult.value);
      this._applyIfNotRunningOrUnchanged('port', this._port, resolvedPort, (value) => { this.port = value; });
    }

    const hostResult = this._resolveAndLogSetting(base, 'host');
    if (!Utils.isUndefined(hostResult.value)) {
      this._applyIfNotRunningOrUnchanged('host', this._host, hostResult.value as string, (value) => { this.host = value; });
    }

    const protocolResult = this._resolveAndLogSetting(base, 'protocol');
    if (!Utils.isUndefined(protocolResult.value)) {
      this._applyIfNotRunningOrUnchanged('protocol', this._protocol, protocolResult.value as 'http' | 'https', (value) => { this.protocol = value; });
    }

    const requestTimeoutResult = this._resolveAndLogSetting(base, 'requestTimeout');
    if (!Utils.isUndefined(requestTimeoutResult.value)) {
      this.requestTimeout = coerceToNumber(requestTimeoutResult.value);
    }

    const proxyResult = this._resolveAndLogSetting(base, 'proxy');
    if (!Utils.isUndefined(proxyResult.value)) {
      this.proxy = proxyResult.value as string;
    }

    const autHandlerTimeoutResult = this._resolveAndLogSetting(base, 'autHandlerTimeout');
    if (!Utils.isUndefined(autHandlerTimeoutResult.value)) {
      this.autHandlerTimeout = coerceToNumber(autHandlerTimeoutResult.value);
    }

    const resourcePathPreambleResult = this._resolveAndLogSetting(base, 'resourcePathPreamble');
    if (!Utils.isUndefined(resourcePathPreambleResult.value)) {
      this.resourcePathPreamble = resourcePathPreambleResult.value as string;
    }

    // resourcePathPreambles (plural) — a map, not a scalar, so it has no env-var/npm-config
    // source (neither can express an object) and doesn't go through _resolveAndLogSetting's
    // scalar-oriented apply logic — resolved and logged inline instead, at the same two
    // fixed tiers as everything else in this trail (TestDebug outcome, FrameworkInformation
    // source), just with its own shape.
    const resourcePathPreamblesResult = Settings.get<Record<string, string>>(LogLevels.FrameworkInformation, 'resourcePathPreambles', {
      profileParameterName: `${base}.resourcePathPreambles`,
      notFoundIsExpected: true,
    });
    if (Utils.isUndefined(resourcePathPreamblesResult.value)) {
      Log.writeLine(LogLevels.TestDebug, `[${this._appName}] setting 'resourcePathPreambles' not configured`);
    } else {
      this._namedResourcePathPreambles = resourcePathPreamblesResult.value;
      Log.writeLine(LogLevels.TestDebug, `[${this._appName}] setting 'resourcePathPreambles' = [${Object.keys(this._namedResourcePathPreambles).join(', ')}]`);
    }

    const dotEnvResult = this._resolveAndLogSetting(base, 'dotEnvPath');
    if (!Utils.isUndefined(dotEnvResult.value)) {
      this._loadDotEnvFile(dotEnvResult.value, logLevel);
    }

    // One explicit summary, regardless of which fields above actually came from settings
    // vs. stayed at their already-set/constructor default — the per-field trail only ever
    // shows at TestDebug or quieter (see _resolveAndLogSetting), so a field simply using
    // its default would otherwise be invisible at any level a normal test run shows. Per
    // ~/repos/controlium/PRINCIPLES.md's visibility principle: the AUT's actual effective
    // configuration should always be visible, not just what changed.
    Log.writeLine(
      logLevel,
      `[${this._appName}] configuration:\n` +
      `  host: ${this._host}\n` +
      `  port: ${this._port}\n` +
      `  protocol: ${this._protocol}\n` +
      `  requestTimeout: ${this._requestTimeout}\n` +
      `  autHandlerTimeout: ${this._autHandlerTimeout}\n` +
      `  proxy: ${this._proxy ?? '(none)'}\n` +
      `  resourcePathPreamble: ${this._resourcePathPreamble ?? '(none)'}`,
      { suppressMultilinePreamble: true }
    );
  }

  /**
   * Resolves one field under this AUT's settings block and logs the outcome — never
   * silent, and never quieter for one outcome than the other, per
   * `~/repos/controlium/PRINCIPLES.md`'s visibility principle, but deliberately split
   * across two fixed tiers rather than one, so a normal test run's usual verbosity
   * (`TestInformation`) shows none of this — just {@link loadSettings}'s own single
   * headline summary:
   * - `TestDebug` — one short line per field, resolved value only (`setting 'host' =
   *   localhost`), no source. Visible one notch quieter than `TestInformation`, for
   *   anyone who wants the per-field breakdown without the framework-internal detail
   *   below.
   * - `FrameworkInformation` — `Settings.get`'s own line, carrying *where* the value
   *   actually came from (env var / npm config / profile / default) — framework-tier
   *   detail, not test-authoring signal.
   */
  private _resolveAndLogSetting(base: string, field: string): { value: unknown; source: string } {
    // notFoundIsExpected: true — every caller of this method (loadSettings, below) already
    // has its own fallback for "nothing configured here" (either the already-set/default
    // value, or — for 'port' specifically — its own explicit, far more actionable fail()
    // message). Utils.getSetting's generic "Unable to determine value" Error would
    // otherwise fire for every one of these on every single ordinary, expected "not
    // overridden via settings" outcome.
    const result = Settings.get<unknown>(LogLevels.FrameworkInformation, field, { profileParameterName: `${base}.${field}`, notFoundIsExpected: true });
    if (Utils.isUndefined(result.value)) {
      Log.writeLine(LogLevels.TestDebug, `[${this._appName}] setting '${field}' not configured`);
    } else {
      Log.writeLine(LogLevels.TestDebug, `[${this._appName}] setting '${field}' = ${result.value}`);
    }
    return result;
  }

  /**
   * Applies a resolved value for a field that's only safe to change before this AUT is
   * running (`host`/`port`/`protocol`) — see {@link loadSettings}'s own doc for why. Applies
   * freely if not yet running; if already running, a value identical to the current one is a
   * harmless no-op, but an actual attempted change throws rather than silently drifting this
   * instance's stored config away from what it's really bound to.
   */
  private _applyIfNotRunningOrUnchanged<T>(field: string, currentValue: T | undefined, resolvedValue: T, apply: (value: T) => void): void {
    if (this._isControlled) {
      if (resolvedValue !== currentValue) {
        fail(
          this._appName,
          `loadSettings(): cannot change '${field}' while running (currently [${currentValue}], settings now ` +
          `resolve to [${resolvedValue}]) — stop the application first.`
        );
      }
      return;
    }
    apply(resolvedValue);
  }

  /**
   * Loads a resolved `dotEnvPath` into `process.env` via `dotenv`, with `override: true` so
   * this AUT's own file always wins for its own keys regardless of what a previously-started
   * sibling app's `.env` already set (the default no-override behaviour means whichever app
   * starts first would otherwise silently win any overlapping variable names — wrong for a
   * multi-app process). Fails loudly — rather than logging and continuing — if the configured
   * path doesn't exist or fails to parse: a configured-but-broken `.env` is a real
   * misconfiguration the test author needs to know about immediately, not something to
   * silently proceed without (see `~/repos/controlium/PRINCIPLES.md`).
   */
  private _loadDotEnvFile(dotEnvPath: unknown, logLevel: LogLevel): void {
    requireNonEmptyString(dotEnvPath, this._appName, 'dotEnvPath');
    if (!existsSync(dotEnvPath)) {
      fail(this._appName, `configured dotEnvPath [${dotEnvPath}] does not exist`);
    }
    const result = loadDotenvFile({ path: dotEnvPath, override: true, quiet: true });
    if (result.error) {
      fail(this._appName, `failed to load .env file [${dotEnvPath}]: ${Utils.errorMessage(result.error)}`);
    }
    const loadedKeys = Object.keys(result.parsed ?? {});
    Log.writeLine(logLevel, `[${this._appName}] loaded ${loadedKeys.length} variable(s) from .env [${dotEnvPath}] into process.env`);
  }

  // ─── State: isControlled ──────────────────────────────────────────────────

  /**
   * `true` if this AUT has been successfully started and is currently running.
   */
  public get isControlled(): boolean { return this._isControlled; }

  // ─── Headers ──────────────────────────────────────────────────────────────

  /**
   * Replaces all current session-level request headers with the provided set.
   *
   * Every string (or `string[]`) value is detokenised **before** sentinel resolution — see
   * {@link detokeniseHeaderOrQueryValues}'s own doc comment for why this ordering is load-bearing, not
   * just a consistency nicety: a token whose resolved value is meant to *be* the sentinel
   * (e.g. "only send this header if a setting is configured") can only be recognised as one
   * if it's already resolved by the time `JsonUtils.resolveSentinels` inspects it.
   *
   * `JsonUtils.SENTINEL_UNDEFINED`/`SENTINEL_NULL` ("_undefined"/"_null") are resolved in
   * the result — a header whose value is exactly `"_undefined"` is omitted entirely, and
   * one whose value is exactly `"_null"` is set to a real `null` — the one textual
   * convention for expressing those regardless of whether `headers` was built from a JSON
   * literal, a file, or a Cucumber DataTable (a DataTable cell can only ever be a string,
   * so there's no other way for it to express "remove this header" or "a real null").
   *
   * Now async — detokenising is inherently asynchronous — so a caller must `await` this.
   */
  public async setHeaders(headers: APIUtils.HTTPHeaders | null): Promise<void> {
    requireObject(headers, this._appName, 'headers');
    this._headers = JsonUtils.resolveSentinels(await detokeniseHeaderOrQueryValues(headers));
    Log.writeLine(LogLevels.TestDebug, `[${this._appName}] request headers set to:\n${Utils.safeStringify(this._headers)}`, { suppressMultilinePreamble: true });
  }

  /**
   * Merges the provided headers into the current session-level set, overwriting any matching keys.
   * Set a header's value to `null` to have it omitted from subsequent requests without
   * removing it from the session set — see {@link API_AUTWrapper.RequestOptions.headers}.
   *
   * `headers` is detokenised before merging — see {@link setHeaders} for why this ordering
   * (detokenise, *then* merge, *then* resolve sentinels on the merged result) matters.
   * `JsonUtils.SENTINEL_UNDEFINED`/`SENTINEL_NULL` are resolved on the *merged* result, not
   * on `headers` alone — see {@link setHeaders} for what they mean. Resolving after the
   * merge (rather than before) is deliberate: it's what lets `"_undefined"` in `headers`
   * remove a header that was only ever set by an earlier call, not just one present in this
   * same call's own argument.
   *
   * Now async — detokenising is inherently asynchronous — so a caller must `await` this.
   */
  public async mergeHeaders(headers: APIUtils.HTTPHeaders | null): Promise<void> {
    requireObject(headers, this._appName, 'headers');
    const detokenisedHeaders = await detokeniseHeaderOrQueryValues(headers);
    const merged: APIUtils.HTTPHeaders = { ...this._headers, ...detokenisedHeaders };
    this._headers = JsonUtils.resolveSentinels(merged);
    Log.writeLine(LogLevels.TestDebug, `[${this._appName}] request headers merged to:\n${Utils.safeStringify(this._headers)}`, { suppressMultilinePreamble: true });
  }

  /**
   * Removes all current session-level request headers.
   * Called automatically by {@link close}.
   */
  public clearHeaders(): void {
    this._headers = {};
    Log.writeLine(LogLevels.FrameworkDebug, `[${this._appName}] request headers cleared`);
  }

  /**
   * Returns a shallow copy of the current session-level request headers.
   */
  public getHeaders(): APIUtils.HTTPHeaders {
    return { ...this._headers };
  }

  // ─── Query params ─────────────────────────────────────────────────────────

  /**
   * Replaces all current session-level query parameters with the provided set — same
   * detokenise-then-sentinel-resolve treatment, and the same `string[]`/`null` conventions,
   * as {@link setHeaders} (see its own doc comment for the full reasoning, not repeated
   * here). A `string[]` value sends that key more than once (e.g. `tag=a&tag=b`); `null`
   * omits the key entirely; `JsonUtils.SENTINEL_UNDEFINED`/`SENTINEL_NULL` resolve the same
   * way `setHeaders` already does.
   *
   * At request time, this session-level set and {@link API_AUTWrapper.RequestOptions.queryString}
   * (if also given) are combined, never one overriding the other — see {@link request}'s
   * own doc comment.
   *
   * Now async — detokenising is inherently asynchronous — so a caller must `await` this.
   */
  public async setQueryParams(queryParams: APIUtils.QueryParams | null): Promise<void> {
    requireObject(queryParams, this._appName, 'queryParams');
    this._queryParams = JsonUtils.resolveSentinels(await detokeniseHeaderOrQueryValues(queryParams));
    Log.writeLine(LogLevels.TestDebug, `[${this._appName}] query params set to:\n${Utils.safeStringify(this._queryParams)}`, { suppressMultilinePreamble: true });
  }

  /**
   * Merges the provided query parameters into the current session-level set, overwriting
   * any matching keys — same detokenise-then-merge-then-sentinel-resolve ordering as
   * {@link mergeHeaders} (see its own doc comment for why that ordering matters).
   *
   * Now async — detokenising is inherently asynchronous — so a caller must `await` this.
   */
  public async mergeQueryParams(queryParams: APIUtils.QueryParams | null): Promise<void> {
    requireObject(queryParams, this._appName, 'queryParams');
    const detokenisedQueryParams = await detokeniseHeaderOrQueryValues(queryParams);
    const merged: APIUtils.QueryParams = { ...this._queryParams, ...detokenisedQueryParams };
    this._queryParams = JsonUtils.resolveSentinels(merged);
    Log.writeLine(LogLevels.TestDebug, `[${this._appName}] query params merged to:\n${Utils.safeStringify(this._queryParams)}`, { suppressMultilinePreamble: true });
  }

  /**
   * Removes all current session-level query parameters.
   * Called automatically by {@link close}.
   */
  public clearQueryParams(): void {
    this._queryParams = {};
    Log.writeLine(LogLevels.FrameworkDebug, `[${this._appName}] query params cleared`);
  }

  /**
   * Returns a shallow copy of the current session-level query parameters.
   */
  public getQueryParams(): APIUtils.QueryParams {
    return { ...this._queryParams };
  }

  // ─── Transactions ─────────────────────────────────────────────────────────

  /**
   * All recorded HTTP transactions (requests and their outcomes) for this AUT session.
   * A transaction with no `response` and a populated `error` indicates the AUT did not respond
   * (e.g. it crashed or was not reachable).
   */
  public get transactions(): ReadonlyArray<API_AUTWrapper.Transaction> {
    return this._transactions;
  }

  /**
   * The most recent transaction recorded for this AUT.
   * @throws {Error} if no requests have been made.
   */
  public get lastTransaction(): API_AUTWrapper.Transaction {
    if (this._transactions.length === 0) {
      fail(this._appName, 'No HTTP transactions recorded');
    }
    return this._transactions[this._transactions.length - 1];
  }

  /**
   * The HTTP response from the most recent transaction.
   * @throws {Error} if there is no response — either no requests have been made,
   *   or the AUT did not respond.
   */
  public get lastResponse(): APIUtils.HTTPResponse {
    const last = this.lastTransaction;
    if (Utils.isUndefined(last.response)) {
      fail(this._appName, `last transaction has no response — AUT may have crashed. Error: ${last.error ?? 'unknown'}`);
    }
    return last.response as APIUtils.HTTPResponse;
  }

  /**
   * Discards all recorded transactions for this AUT session.
   * Called automatically by {@link close}.
   */
  public clearTransactions(): void {
    this._transactions.length = 0;
    Log.writeLine(LogLevels.FrameworkDebug, `[${this._appName}] transactions cleared`);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Closes this AUT (if running) and resets all session state.
   * Configuration properties (host, port, protocol, etc.) are preserved.
   * Safe to call when the AUT is not running.
   */
  public async close(): Promise<void> {
    this.clearTransactions();
    this.clearHeaders();
    this.clearQueryParams();
    this._resourcePathPreamble = undefined;
    // _resourcePathPreambleBase alongside it — same session-state lifecycle, reset
    // together. _namedResourcePathPreambles (the resolved map itself) is deliberately NOT
    // reset here — it's settings-resolved configuration, same bucket as _bootstrapper/
    // _closeHandler/port/host/etc., which close() never resets either, so a
    // stop-then-restart on the same prepared instance doesn't lose it.
    this._resourcePathPreambleBase = undefined;
    this._isControlled = false;

    if (!Utils.isUndefined(this._handle)) {
      Log.writeLine(LogLevels.FrameworkDebug, `Closing [${this._appName}]`);
      await this._closeAUT();
    }
  }

  // ─── HTTP communication ───────────────────────────────────────────────────

  /**
   * Sends an HTTP request to this AUT and records the transaction.
   *
   * If the AUT does not respond (e.g. it has crashed), the error is recorded in the
   * transaction but this method does NOT throw — callers can inspect `lastTransaction.error`
   * or call `lastResponse` (which will throw) to surface the failure.
   *
   * Per-call headers are merged on top of the current session headers. `Content-Type` is
   * decided, in priority order, unless the caller has explicitly set it — including
   * explicitly to `null` (see {@link API_AUTWrapper.RequestOptions.headers}), which always
   * wins over both of the following:
   * 1. {@link API_AUTWrapper.RequestOptions.contentType}, if given.
   * 2. Otherwise, if the body is a JSON object (or a JSON string), `Content-Type` is
   *    inferred automatically — a legacy fallback kept for any caller that doesn't bother
   *    passing `contentType` explicitly. There is no equivalent sniffing for XML/YAML/
   *    anything else — see {@link API_AUTWrapper.RequestOptions.contentType}'s own doc
   *    comment for why a caller that knows its body's kind should just say so. A `Buffer`
   *    body is never sniffed at all (see {@link API_AUTWrapper.RequestOptions.body}) — a
   *    caller sending binary content must say so via `contentType` itself.
   *
   * `requestTimeout` and `proxy` fall back to the session-level {@link requestTimeout}/{@link proxy}
   * when not given per-call. `queryString` is combined with — never overridden by, or
   * overriding — both {@link setQueryParams}/{@link mergeQueryParams}'s session-level query
   * params and a query string embedded directly in `resourcePath` itself (e.g.
   * `'/users?foo=bar'`); see {@link APIUtils.mergeQueryStrings}'s own doc comment for why a
   * key appearing in more than one of those three sources survives as a genuine duplicate
   * rather than one silently winning.
   *
   * @param method - HTTP method (e.g. `'GET'`, `'POST'`, `'DELETE'`).
   * @param resourcePath - Path relative to the AUT root (e.g. `'/users/42'`).
   *   Prepended with {@link resourcePathPreamble} if set.
   * @param options - Optional per-request headers, body, contentType, query string,
   *   requestTimeout, and proxy.
   * @throws {Error} if {@link port} has not been set.
   */
  public async request(
    method: string,
    resourcePath: string,
    options: API_AUTWrapper.RequestOptions | null = {}
  ): Promise<void> {
    if (Utils.isUndefined(this._port)) {
      fail(this._appName, 'Cannot make request — port is not set');
    }

    // `method`/`resourcePath` are typed `string`, but that's a compile-time promise only —
    // a caller stuffing up an argument (wrong order, wrong type, `any`-typed value) must be
    // caught here, not surfaced as a confusing string-concatenation or downstream HTTP error.
    requireNonEmptyString(method, this._appName, 'method');
    requireString(resourcePath, this._appName, 'resourcePath');
    // `options: ... = {}` only substitutes the default for `undefined` — an explicit `null`
    // (or any non-object `any`-typed value) sails straight through and would otherwise crash
    // on `options.headers` below.
    requireObject(options, this._appName, 'options');
    if (!Utils.isUndefined(options.headers)) {
      requireObject(options.headers, this._appName, 'options.headers');
    }
    if (!Utils.isUndefined(options.queryString)) {
      requireString(options.queryString, this._appName, 'options.queryString');
    }
    if (!Utils.isUndefined(options.requestTimeout)) {
      requirePositiveNumber(options.requestTimeout, this._appName, 'options.requestTimeout');
    }
    if (!Utils.isUndefined(options.proxy)) {
      requireNonEmptyString(options.proxy, this._appName, 'options.proxy');
    }
    if (!Utils.isUndefined(options.contentType)) {
      requireNonEmptyString(options.contentType, this._appName, 'options.contentType');
    }

    const fullPath = (this._resourcePathPreamble ?? '') + resourcePath;

    // Consume any staged one-shot "next request" override (see
    // API_AUTWrapper._pendingNextRequestHeaders) — genuinely global, not scoped to this
    // instance, so whichever AUT's request() fires next — this call, right now — is the one
    // that gets it. Cleared immediately, before anything below can throw, so "used once, no
    // exceptions" holds regardless of what happens to the rest of this particular request.
    const pendingOverride = API_AUTWrapper._pendingNextRequestHeaders;
    API_AUTWrapper.clearNextRequestHeaders();

    let baseHeaders = this._headers;
    if (!Utils.isUndefined(pendingOverride)) {
      // Resolve any DataTable-sourced ValueExpression entries now, at the moment this
      // override is actually consumed — not back when the staging step ran — so a
      // DataTable cell gets exactly the same "freshest possible state, resolved once, right
      // before use" treatment as the literal/file portion of this same override already
      // gets. A DataTable key always wins over the same key in the literal/file portion,
      // same convention `@controlium/cucumber-driver`'s session-level step definitions use.
      const resolvedDataTableHeaders = await resolveDataTableValueExpressions(pendingOverride.dataTableValueExpressions);
      const combinedOverrideHeaders = { ...pendingOverride.headers, ...resolvedDataTableHeaders };
      APIUtils.assertPrimitiveValues(combinedOverrideHeaders, 'header');

      // Same detokenise-then-resolveSentinels treatment as setHeaders/mergeHeaders, computed
      // here (not when staged) — merge mode needs to see this AUT's session headers as they
      // are right now, not a snapshot taken whenever the override was originally staged.
      const detokenisedOverride = await detokeniseHeaderOrQueryValues(combinedOverrideHeaders as APIUtils.HTTPHeaders);
      baseHeaders = JsonUtils.resolveSentinels(
        pendingOverride.mode === 'replace' ? detokenisedOverride : { ...this._headers, ...detokenisedOverride }
      );
      Log.writeLine(
        LogLevels.TestDebug,
        `[${this._appName}] applying one-shot next-request header override (${pendingOverride.mode}):\n${Utils.safeStringify(baseHeaders)}`,
        { suppressMultilinePreamble: true }
      );
    }

    const mergedHeaders: APIUtils.HTTPHeaders = {
      ...baseHeaders,
      ...(options.headers ?? {}),
    };

    // Consume any staged one-shot "next request" query-params override — same lifecycle as
    // the header override above (see _pendingNextRequestQueryParams's own doc comment).
    const pendingQueryParamsOverride = API_AUTWrapper._pendingNextRequestQueryParams;
    API_AUTWrapper.clearNextRequestQueryParams();

    let baseQueryParams = this._queryParams;
    if (!Utils.isUndefined(pendingQueryParamsOverride)) {
      // Same deferred DataTable-ValueExpression resolution as the header override above —
      // see its own comment for why.
      const resolvedDataTableQueryParams = await resolveDataTableValueExpressions(pendingQueryParamsOverride.dataTableValueExpressions);
      const combinedOverrideQueryParams = { ...pendingQueryParamsOverride.queryParams, ...resolvedDataTableQueryParams };
      APIUtils.assertPrimitiveValues(combinedOverrideQueryParams, 'query parameter');

      const detokenisedQueryParamsOverride = await detokeniseHeaderOrQueryValues(combinedOverrideQueryParams as APIUtils.QueryParams);
      baseQueryParams = JsonUtils.resolveSentinels(
        pendingQueryParamsOverride.mode === 'replace' ? detokenisedQueryParamsOverride : { ...this._queryParams, ...detokenisedQueryParamsOverride }
      );
      Log.writeLine(
        LogLevels.TestDebug,
        `[${this._appName}] applying one-shot next-request query-params override (${pendingQueryParamsOverride.mode}):\n${Utils.safeStringify(baseQueryParams)}`,
        { suppressMultilinePreamble: true }
      );
    }

    // Decide Content-Type unless the caller has explicitly set it — including to `null`,
    // which signals "omit this header" (see buildHeaders in @controlium/utils) and must
    // not be clobbered by either of the following. `options.contentType` (the caller's own
    // explicit, kind-aware choice) always wins over the JSON-sniffing fallback — see
    // RequestOptions.contentType's own doc comment for why there's no equivalent sniffing
    // for XML/YAML/anything else. A Buffer body is excluded from the JSON-sniffing check
    // entirely — JsonUtils.isJson would otherwise report a false positive on *any* Buffer
    // (JSON.stringify(aBuffer) always succeeds, producing {"type":"Buffer","data":[...]},
    // which then parses straight back as "valid JSON"), silently mislabelling genuine
    // binary content as application/json.
    if (Utils.isUndefined(mergedHeaders['Content-Type'])) {
      if (!Utils.isUndefined(options.contentType)) {
        mergedHeaders['Content-Type'] = options.contentType;
      } else if (!Buffer.isBuffer(options.body) && JsonUtils.isJson(options.body)) {
        mergedHeaders['Content-Type'] = APIUtils.APPLICATION_JSON;
      }
    }

    // Detokenise every outgoing string value — method, resource path, headers, query
    // string, body — unconditionally, right at this one point where every outgoing
    // request to this AUT is guaranteed to pass,
    // regardless of how its content was built. Not opt-in per caller: test data sourced from,
    // say, a file or a prior "recorded" value may never pass through any code path a caller
    // could plausibly hook detokenisation into themselves. Detokeniser.doAsync() itself no-ops
    // when Detokeniser.enabled is false — the caller-controlled safety-net override, reset by
    // @controlium/framework's own afterTest() — so there is no flag to thread through here.
    // (Session headers set via setHeaders/mergeHeaders are already detokenised by the time
    // they reach here — this re-detokenises them too, harmlessly, since Detokeniser.doAsync()
    // on already-resolved text is a no-op. It's genuinely needed for any header supplied
    // directly via options.headers on this one call, which never went through either.)
    //
    // This is also the one designated point where de-escaping (deEscape: true, explicit —
    // not just relying on the default) is allowed to happen at all: de-escaping is a one-shot
    // operation (see @controlium/utils's Detokeniser "Escaping" section), so every earlier
    // resolution anywhere upstream of this call must defer it (deEscape: false) and let it
    // land here, exactly once, right before the request actually goes out.
    const detokenisedMergedHeaders = await detokeniseHeaderOrQueryValues(mergedHeaders);

    // Session/one-shot query params (already detokenised above, same guarantee session
    // headers get) become a query-string fragment; options.queryString is detokenised here
    // — the one per-call piece that's never been through a detokenise pass yet — and the
    // two are combined, never one overriding the other (see APIUtils.mergeQueryStrings's
    // own doc comment): a key set both ways survives as a genuine duplicate, for the AUT to
    // deal with, not this method's job to silently resolve.
    const queryParamsString = APIUtils.buildQueryString(baseQueryParams);
    const detokenisedOptionsQueryString = Utils.isUndefined(options.queryString)
      ? undefined
      : await Detokeniser.doAsync(options.queryString, { deEscape: true });
    const detokenisedQueryString = APIUtils.mergeQueryStrings(queryParamsString, detokenisedOptionsQueryString);

    // A Buffer body is binary — never token-bearing, left untouched. A string body is
    // detokenised directly. An object body is walked and detokenised leaf-by-leaf — see
    // detokeniseDeep — rather than JSON.stringify-ed first: stringifying first would escape
    // any quote inside a token's own parameters (e.g. [[setting|processEnvName: "X"]]) before
    // the detokeniser ever saw them, breaking token parsing. The result stays an object, so
    // it's still JSON-serialised exactly once, downstream, same as an untouched object body
    // always was.
    const detokenisedBody = Utils.isNullOrUndefined(options.body) || Buffer.isBuffer(options.body)
      ? options.body
      : typeof options.body === 'string'
        ? await Detokeniser.doAsync(options.body, { deEscape: true })
        : await detokeniseDeep(options.body) as object;

    // `method`/`resourcePath` (via `fullPath`, which may also carry a token through
    // `resourcePathPreamble` if that itself came from settings as templated text) are
    // outgoing string values exactly like headers/queryString/body — the same
    // "unconditionally, regardless of how the content was built" reasoning applies, so
    // they get the same treatment here rather than being silently exempt.
    const detokenisedMethod = await Detokeniser.doAsync(method, { deEscape: true });
    const detokenisedFullPath = await Detokeniser.doAsync(fullPath, { deEscape: true });

    const httpRequest: APIUtils.HTTPRequest = {
      method: detokenisedMethod,
      protocol: this._protocol,
      host:     `${this._host}:${this._port}`,
      resourcePath: detokenisedFullPath,
      queryString: detokenisedQueryString,
      headers:  detokenisedMergedHeaders,
      body:     detokenisedBody,
      proxy:    options.proxy ?? this._proxy,
      // Key stays `timeout` — this is APIUtils.HTTPRequest's own field name (an external
      // contract in @controlium/utils), unrelated to this class's own requestTimeout rename.
      timeout:  options.requestTimeout ?? this._requestTimeout,
    };

    // The redirect loop below needs a mutable "current hop" — starts as the request just
    // built, and may be replaced (method/body/target all potentially changing) once per
    // hop if options.followRedirects is set and the AUT actually redirects.
    let currentRequest = httpRequest;
    for (let hop = 0; ; hop++) {
      const response = await this.sendRequest(currentRequest);
      if (response === undefined) return; // failure already recorded by sendRequest
      if (!options.followRedirects) return;

      const location = firstHeaderValue(response.headers, 'location');
      if (!isRedirectStatus(response.status) || location === undefined) return;

      if (hop >= MAX_REDIRECTS_FOLLOWED) {
        fail(this._appName, `exceeded ${MAX_REDIRECTS_FOLLOWED} redirects while following Location headers (last target: [${location}])`);
      }
      currentRequest = resolveRedirectRequest(currentRequest, response.status, location);
    }
  }

  /**
   * Sends exactly one request (no redirect-following — that's {@link request}'s own
   * loop) and records the transaction, success or failure. Extracted so
   * {@link request}'s `followRedirects` loop can call this once per hop, logging and
   * recording every hop individually — not just the final one.
   *
   * @returns The response on success, `undefined` on failure (the transaction's own
   *   `.error` already recorded — see {@link request}'s own doc comment for why this
   *   method deliberately doesn't throw on a non-responding AUT).
   */
  private async sendRequest(httpRequest: APIUtils.HTTPRequest): Promise<APIUtils.HTTPResponse | undefined> {
    // Lightweight, unconditional, pre-call — the one thing guaranteed to be visible even
    // if the AUT never responds at all (e.g. a hang/timeout): full detail below depends on
    // the call actually completing, since the genuine wire bytes don't exist until it has.

    try {
      // Makes the real call and, on success, records a completed transaction (request +
      // response) and logs a one-line status summary. targetFriendlyName is display-only
      // — performRawHTTPOperation has no concept of a named AUT; passing this AUT's own
      // name through lets its request/response detail logging (see its own doc comment)
      // show which AUT a dump belongs to.
      const response = await APIUtils.performRawHTTPOperation(httpRequest, { targetFriendlyName: this._appName });
      this._transactions.push({ request: httpRequest, response });
      return response;
    } catch (err) {
      // Catches any throw from performRawHTTPOperation (connection refused, DNS failure,
      // timeout, etc.) and converts it into a recorded, error-only transaction instead of
      // propagating — logs the failure, records it, and returns undefined so the caller
      // (request's redirect loop) can treat "didn't respond" as a normal, inspectable
      // outcome rather than an exception to catch itself.
      const errText = Utils.errorMessage(err);
      Log.writeLine(LogLevels.Error, `[${this._appName}] did not respond to [${httpRequest.method} ${httpRequest.resourcePath}]: ${errText}`);
      this._transactions.push({ request: httpRequest, error: errText });
      return undefined;
    }
  }

  // ─── URL and liveness ────────────────────────────────────────────────────

  /**
   * Returns the URL this AUT reports it is listening on, via the `getUrlHandler`
   * supplied to {@link create}.
   * @throws {Error} if the AUT is not running, no `getUrlHandler` was provided,
   *   or the handler itself throws.
   */
  public async autURL(): Promise<string> {
    if (Utils.isUndefined(this._handle)) {
      fail(this._appName, 'is not running');
    }
    if (Utils.isUndefined(this._getUrlHandler)) {
      fail(this._appName, 'has no getUrlHandler — provide one via create() to use autURL()/isLive()');
    }

    const result = await invokeHandler(
      this._getUrlHandler, this._appName, 'getUrlHandler', this._autHandlerTimeout, this._handle
    );

    if (typeof result !== 'string') {
      fail(this._appName, `getUrlHandler must return a string — received ${Utils.describeValue(result)}`);
    }
    return result;
  }

  /**
   * Returns `true` if this AUT is running and reporting a valid URL.
   */
  public async isLive(): Promise<boolean> {
    if (Utils.isUndefined(this._handle)) {
      Log.writeLine(LogLevels.TestInformation, `[${this._appName}] is not running`);
      return false;
    }
    try {
      const url = await this.autURL();
      if (!url) {
        Log.writeLine(LogLevels.Error, `[${this._appName}] running but getUrlHandler returned empty`);
        return false;
      }
      Log.writeLine(LogLevels.TestInformation, `[${this._appName}] is live at ${url}`);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Internal lifecycle ───────────────────────────────────────────────────

  private async _startAUT(bootstrapper?: API_AUTWrapper.Bootstrapper<Handle>): Promise<void> {
    if (!Utils.isUndefined(bootstrapper)) this._bootstrapper = bootstrapper;

    // Fail fast at configuration time — don't wait until close()/autURL() are
    // actually called to discover a handler is missing or not a function.
    if (Utils.isUndefined(this._bootstrapper)) {
      fail(this._appName, 'No bootstrapper set — provide one via create()');
    }
    requireFunction(this._bootstrapper, this._appName, 'bootstrapper');

    if (Utils.isUndefined(this._closeHandler)) {
      fail(this._appName, 'No closeHandler set — provide one via create() so close() can tear the AUT down');
    }
    requireFunction(this._closeHandler, this._appName, 'closeHandler');

    if (!Utils.isUndefined(this._getUrlHandler)) {
      requireFunction(this._getUrlHandler, this._appName, 'getUrlHandler');
    }

    if (Utils.isUndefined(this._port)) {
      fail(this._appName, 'No port set — set port before calling create()');
    }

    if (this._host !== 'localhost') {
      fail(this._appName, `Host is [${this._host}] — must be 'localhost' for controlled local execution`);
    }

    // Current state, always logged, before deciding what to do about it — a tester needs
    // to see this regardless of which branch runs next, not just infer it from whichever
    // branch's own message happens to appear.
    const wasAlreadyRunning = !Utils.isUndefined(this._handle);

    if (wasAlreadyRunning) {
      // Not "ignored" and not an error — always closed and restarted. If skip-if-already-
      // running is ever wanted instead, that's a deliberate policy change, not implied by
      // this logging.
      Log.writeLine(LogLevels.TestInformation, `[${this._appName}] already running — closing before restart (timeout: ${this._autHandlerTimeout})`);
      await this._closeAUT();
    }

    Log.writeLine(
      LogLevels.TestInformation,
      `[${this._appName}] not running - starting via bootstrapper (timeout: ${this._autHandlerTimeout}) on ${this._protocol}://${this._host}:${this._port}`
    );

    const startedAt = Date.now();
    const handle = await invokeHandler(
      this._bootstrapper, this._appName, 'bootstrapper', this._autHandlerTimeout, this._port as number
    );
    const startDurationMs = Date.now() - startedAt;
    if (Utils.isNullOrUndefined(handle)) {
      fail(this._appName, `bootstrapper resolved but returned ${Utils.describeValue(handle)} — a real AUT handle is required`);
    }
    this._handle = handle;

    this._isControlled = true;
    Log.writeLine(LogLevels.TestInformation, `[${this._appName}] started successfully in ${startDurationMs}ms`);

    // One additional, post-start diagnostic — distinct from loadSettings()'s own
    // configuration summary (host/port/protocol/requestTimeout/autHandlerTimeout/proxy/
    // resourcePathPreamble), which only reflects what was *resolved from settings*, not
    // what's actually live right now. Everything below is only knowable once the AUT has
    // genuinely started: the URL it reports (which may differ from a simple host:port
    // construction), and whatever headers have been set on it since loadSettings() ran.
    // getUrlHandler is optional on create() — a caller may have omitted it, in which case
    // autURL() throws ("has no getUrlHandler"); that's a configuration choice, not a
    // failure this diagnostic log should ever cause startApplication() itself to fail over.
    let url: string;
    try {
      url = await this.autURL();
    } catch (err) {
      url = `<unavailable: ${Utils.errorMessage(err)}>`;
    }
    const headers = this.getHeaders();
    const headersSummary = Object.keys(headers).length > 0 ? Utils.safeStringify(headers) : '<none>';
    Log.writeLine(
      LogLevels.TestDebug,
      `[${this._appName}] live state:\n` +
      `  url: ${url}\n` +
      `  isControlled: ${this._isControlled}\n` +
      `  headers: ${headersSummary}`,
      { suppressMultilinePreamble: true }
    );
  }

  private async _closeAUT(): Promise<void> {
    if (!Utils.isUndefined(this._handle)) {
      const handle = this._handle;
      Log.writeLine(LogLevels.FrameworkDebug, `Calling closeHandler for [${this._appName}]`);
      try {
        // Re-validated here (not just at create() time) — the handler is invoked
        // again defensively at the point of actual use, never assumed still valid.
        await invokeHandler(
          this._closeHandler, this._appName, 'closeHandler', this._autHandlerTimeout, handle
        );
        Log.writeLine(LogLevels.TestInformation, `[${this._appName}] closed`);
      } finally {
        this._handle = undefined;
      }
    }
  }
}

// ─── Namespace ────────────────────────────────────────────────────────────────

// Declaration merging — attaches CreateDetails/Transaction/etc. as nested types reachable
// via `API_AUTWrapper.Transaction` — is the only way to achieve that in TypeScript; there's
// no ES2015-module equivalent for this specific pattern.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace API_AUTWrapper {

  /**
   * A function that starts the application on the given port and returns a handle
   * of type `Handle`. The framework calls this; the consumer provides it (e.g. wrapping
   * `NestFactory.create`). The handle's shape is entirely up to the caller — it's
   * passed as-is to {@link CloseHandler} and {@link GetUrlHandler}, never inspected.
   */
  export type Bootstrapper<Handle = unknown> = (port: number) => Promise<Handle>;

  /**
   * The full, explicit configuration {@link API_AUTWrapper.create} accepts. Named mainly so
   * `create()`'s signature doesn't have to spell out every field inline.
   */
  export interface CreateDetails<Handle = unknown> {
    appName: string;
    port: number;
    bootstrapper?: Bootstrapper<Handle>;
    closeHandler?: CloseHandler<Handle>;
    getUrlHandler?: GetUrlHandler<Handle>;
    host?: string;
    protocol?: 'http' | 'https';
    requestTimeout?: number;
    proxy?: string;
    autHandlerTimeout?: number;
  }

  /**
   * The lifecycle handler functions {@link API_AUTWrapper.prepareApplication} accepts.
   * Deliberately just the handlers — everything {@link CreateDetails} has beyond them
   * (`host`/`port`/`protocol`/etc.) comes from {@link API_AUTWrapper.loadSettings} instead,
   * since `prepareApplication` is the settings-driven entry point, not the explicit one.
   */
  export interface PrepareApplicationHandlers<Handle = unknown> {
    bootstrapper?: Bootstrapper<Handle>;
    closeHandler?: CloseHandler<Handle>;
    getUrlHandler?: GetUrlHandler<Handle>;
  }

  /**
   * Given the handle returned by a {@link Bootstrapper}, closes the AUT.
   * May return a `Promise` or close synchronously.
   */
  export type CloseHandler<Handle = unknown> = (handle: Handle) => Promise<unknown> | unknown;

  /**
   * Given the handle returned by a {@link Bootstrapper}, returns the URL the AUT
   * is listening on.
   */
  export type GetUrlHandler<Handle = unknown> = (handle: Handle) => Promise<string> | string;

  /**
   * Per-request options. Headers here are merged on top of the session headers.
   */
  export interface RequestOptions {
    /**
     * Merged on top of the session headers (see {@link API_AUTWrapper.setHeaders}).
     * Set a header's value to `null` to suppress it for this request only — e.g. to
     * remove a session-level `Authorization` header for one unauthenticated call
     * (`{ headers: { Authorization: null } }`). `@controlium/utils`'s HTTP layer omits
     * any header whose value is `null` from the outgoing request entirely.
     */
    headers?: APIUtils.HTTPHeaders;
    /**
     * A `Buffer` is sent byte-exact, untouched — never detokenised, never JSON-sniffed for
     * `Content-Type` (see this interface's own `contentType` option for sending binary
     * content correctly labelled, since there's no equivalent auto-inference for a body
     * this method can't look inside as text). Use this for genuinely binary payloads (an
     * image, an archive, deliberately malformed bytes) — a `string`/`object` body is always
     * decoded/encoded as text at some point, which would corrupt non-UTF-8 bytes.
     */
    body?: string | object | Buffer;
    /**
     * The `Content-Type` to use for this request's body, when no `Content-Type` is
     * already set (an explicit header always wins, including an explicit `null` meaning
     * "omit the header" — see {@link headers} above). Takes priority over this method's
     * own JSON-sniffing fallback (see this method's own doc comment).
     *
     * Deliberately just a plain string, not a `'json'`/`'xml'`/`'yaml'` enum — this class
     * has no opinion on what body "kinds" exist or which MIME type each maps to; that's
     * the caller's own policy (e.g. `cucumber-driver`'s Gherkin wording and its own
     * `APIUtils.APPLICATION_JSON`/`APPLICATION_XML`/`APPLICATION_YAML` constants), not this
     * framework's. This option is deliberately just the primitive "set this if nothing
     * else already did" — the kind→MIME-type mapping lives entirely at the caller.
     */
    contentType?: string;
    /**
     * Query string appended to the request URL (e.g. `'foo=bar'` or `'?foo=bar'` — the
     * leading `?` is optional). No session-level equivalent — set per-call only.
     */
    queryString?: string;
    /**
     * Overrides the session-level {@link API_AUTWrapper.requestTimeout} for this request only.
     * Falls back to {@link API_AUTWrapper.requestTimeout} when not given.
     */
    requestTimeout?: number;
    /**
     * Overrides the session-level {@link API_AUTWrapper.proxy} for this request only.
     * Falls back to {@link API_AUTWrapper.proxy} when not given.
     */
    proxy?: string;
    /**
     * When `true`, a `301`/`302`/`303`/`307`/`308` response with a `Location` header is
     * followed automatically, re-issuing the request to that target — standard
     * browser/`fetch` compatibility semantics: `301`/`302`/`303` downgrade the method to
     * `GET` and drop the body; `307`/`308` preserve the method and body exactly. Capped
     * at 20 hops (throws if exceeded — an AUT redirecting forever is never followed
     * silently). Default `false`: by default `request()` returns whatever the AUT
     * actually sent, 3xx included — a deliberate choice for a test framework (see
     * `~/repos/controlium/PRINCIPLES.md`'s "not a standard application" principle), not
     * an oversight.
     *
     * Every hop — not just the final one — gets its own full `Sent`/`Received`
     * `TestInformation` log entry and its own {@link API_AUTWrapper.Transaction} pushed
     * to {@link transactions}; {@link lastTransaction}/{@link lastResponse} resolve to
     * the *final* hop (the last one pushed), with every earlier hop still inspectable via
     * the full {@link transactions} array.
     */
    followRedirects?: boolean;
  }

  /**
   * A recorded HTTP interaction with this AUT.
   * If the AUT did not respond, `response` will be undefined and `error` will be populated.
   */
  export interface Transaction {
    request: APIUtils.HTTPRequest;
    response?: APIUtils.HTTPResponse;
    error?: string;
  }
}

// ─── Private helpers ────────────────────────────────────────────────────────

/**
 * Builds a `[appName] message` string, logs it at Error level, and throws it.
 * The single place every user-facing failure in this file goes through, so
 * wording/logging stays consistent regardless of what failed.
 */
function fail(appName: string, message: string): never {
  const errText = `[${appName}] ${message}`;
  Log.writeLine(LogLevels.Error, errText);
  throw new Error(errText);
}

/**
 * Resolves `true` if anything answers a plain TCP connect on `host:port`, `false` if the
 * attempt is refused or doesn't complete within `timeoutMS` — used by
 * {@link API_AUTWrapper.assertNoKnownAUTsStillListening} as ground truth for "is this AUT
 * actually still running", independent of any of this file's own bookkeeping.
 */
function isPortListening(host: string, port: number, timeoutMS = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Recursively detokenises every string leaf of a JSON-shaped value — used for an object
 * request body. Deliberately walks the *object*, detokenising each string value in isolation,
 * rather than `JSON.stringify`-ing the whole thing first and detokenising that one resulting
 * string: a token with a quoted parameter (e.g. `[[setting|processEnvName: "X"]]`) would have
 * its own quotes escaped to `\"` by `JSON.stringify` before the detokeniser ever saw them,
 * breaking token parsing. Detokenising leaf-by-leaf, before serialisation, never has that
 * problem — each leaf is detokenised as the plain string it actually is.
 */
async function detokeniseDeep(value: unknown): Promise<unknown> {
  if (typeof value === 'string') {
    return Detokeniser.doAsync(value, { deEscape: true });
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => detokeniseDeep(item)));
  }
  if (!Utils.isNullOrUndefined(value) && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, entryValue]) => [key, await detokeniseDeep(entryValue)] as const)
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/** Hop cap for {@link API_AUTWrapper.RequestOptions.followRedirects} — an AUT redirecting
 * forever is never followed silently; matches the conventional browser/`fetch` limit. */
const MAX_REDIRECTS_FOLLOWED = 20;

/** `true` for the status codes {@link API_AUTWrapper.RequestOptions.followRedirects}
 * recognises as a redirect worth following. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** The first value of a (possibly repeated) response header, case-insensitive-by-already-
 * lowercased-key — `response.headers` keys are already lowercased by
 * `RawHttpResponseParser`, so a plain lookup is enough. `undefined` if absent. */
function firstHeaderValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Builds the next hop's request for {@link API_AUTWrapper.request}'s `followRedirects`
 * loop — resolving `location` (absolute or relative) against `previous`'s own URL, and
 * applying standard browser/`fetch` compatibility semantics: `301`/`302`/`303` downgrade
 * the method to `GET` and drop the body; `307`/`308` preserve both exactly. Headers are
 * carried over unchanged on every hop (see {@link API_AUTWrapper.RequestOptions.followRedirects}'s
 * own doc comment for why — this is a test framework talking to AUTs under test, not
 * untrusted public browsing, so browsers' own cross-origin header-stripping doesn't apply
 * here).
 */
function resolveRedirectRequest(previous: APIUtils.HTTPRequest, status: number, location: string): APIUtils.HTTPRequest {
  const queryStringSuffix = Utils.isNullOrUndefined(previous.queryString)
    ? ''
    : previous.queryString.startsWith('?') ? previous.queryString : `?${previous.queryString}`;
  const previousUrl = new URL(`${previous.protocol}://${previous.host}${previous.resourcePath}${queryStringSuffix}`);
  const nextUrl = new URL(location, previousUrl);
  const preserveMethodAndBody = status === 307 || status === 308;

  return {
    ...previous,
    protocol: nextUrl.protocol === 'https:' ? 'https' : 'http',
    host: nextUrl.host,
    resourcePath: nextUrl.pathname,
    queryString: nextUrl.search === '' ? undefined : nextUrl.search,
    method: preserveMethodAndBody ? previous.method : 'GET',
    body: preserveMethodAndBody ? previous.body : undefined,
  };
}

/**
 * Detokenises every string (or `string[]`) value within a headers *or query-params* object
 * — the two share an identical shape (see {@link APIUtils.QueryParams}), so one function
 * serves both. number/boolean/null values are left untouched, since detokenisation is a
 * string operation. Returns a new object; the input is never mutated.
 *
 * Used both by {@link API_AUTWrapper.request} (detokenising right before a header/query
 * param actually goes out on the wire) and by {@link API_AUTWrapper.setHeaders}/{@link
 * API_AUTWrapper.mergeHeaders}/{@link API_AUTWrapper.setQueryParams}/{@link
 * API_AUTWrapper.mergeQueryParams} (detokenising *before* `JsonUtils.resolveSentinels`
 * runs) — the second use is load-bearing, not just a consistency nicety: a token whose
 * resolved value is meant to *be* the `"_undefined"`/`"_null"` sentinel (e.g. "only send
 * this if a setting is configured, otherwise omit it entirely") can only ever be recognised
 * as a sentinel if it's already been resolved by the time `resolveSentinels` inspects it.
 * `resolveSentinels` runs once, at merge time — well before `request()`'s own detokenise
 * pass, which happens per-request, much later — so relying solely on that later pass would
 * mean such a token's sentinel intent is silently missed every time, and a literal
 * `"_undefined"`/`"_null"` string ships to the AUT as a real value instead of the
 * header/query param being omitted/nulled as the test author intended.
 */
/**
 * Resolves a one-shot override's raw, DataTable-sourced `ValueExpression.parse` source text
 * (see {@link API_AUTWrapper._pendingNextRequestHeaders}'s own doc comment for why this
 * stays unresolved until now) into actual values — `number:`/`boolean:`/`json:`/`file:`
 * casts included, same as `@controlium/cucumber-driver`'s session-level DataTable handling,
 * just resolved here, at consumption time, instead of at step-definition time.
 *
 * `undefined` (no DataTable was ever staged for this override) resolves to `{}` — nothing to
 * merge in.
 */
async function resolveDataTableValueExpressions(raw: Record<string, string> | undefined): Promise<Record<string, unknown>> {
  if (Utils.isUndefined(raw)) return {};
  const resolvedEntries = await Promise.all(
    Object.entries(raw).map(async ([key, value]) => [key, await ValueExpression.parse(value, { useJson5: true })] as const)
  );
  return Object.fromEntries(resolvedEntries);
}

async function detokeniseHeaderOrQueryValues(values: APIUtils.HTTPHeaders): Promise<APIUtils.HTTPHeaders> {
  const result: APIUtils.HTTPHeaders = { ...values };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') {
      result[key] = await Detokeniser.doAsync(value, { deEscape: true });
    } else if (Array.isArray(value)) {
      result[key] = await Promise.all(value.map((singleValue) => Detokeniser.doAsync(singleValue, { deEscape: true })));
    }
  }
  return result;
}

/** Default top-level settings key {@link loadSettings} nests every AUT's settings under. */
const DEFAULT_SETTINGS_PREFIX = 'testAUTDetails';

/**
 * Resolves the configurable top-level settings prefix {@link loadSettings} nests every AUT's
 * settings block under. Resolved via env var / npm package config only — never via the
 * profile itself (`profileParameterName`), which would be a chicken-and-egg problem: the
 * prefix has to be known before anything can look inside the profile for it.
 *
 * Always logged at `FrameworkDebug` — which prefix convention is in play is rarely-changed,
 * deep framework infrastructure, essentially never test-authoring signal, so it's the
 * quietest tier of {@link loadSettings}'s whole resolution trail, not something a caller
 * can promote by passing a louder level in.
 */
function resolveSettingsPrefix(): string {
  const { value, source } = Settings.get<string>(LogLevels.FrameworkDebug, 'AUT settings prefix', {
    processEnvName: 'CONTROLIUM_AUT_SETTINGS_PREFIX',
    npmPackageConfigName: 'autSettingsPrefix',
    defaultValue: DEFAULT_SETTINGS_PREFIX,
  });
  Log.writeLine(LogLevels.FrameworkDebug, `AUT settings prefix: [${value}] (${source})`);
  return value as string;
}

/**
 * A setting resolved from an env var always comes back as a string even when it represents a
 * number (e.g. `"3000"`); one resolved from a profile/World object may already be a real
 * number. Normalises either into a number — including turning genuinely invalid input (e.g.
 * `"abc"`) into `NaN`, which the eventual `requirePort`/`requirePositiveNumber` call on the
 * target setter then rejects with its own clear error, rather than silently accepting garbage.
 */
function coerceToNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Generic guard: fails unless `value` is a non-null, non-array object — i.e. something
 * it's actually safe to spread or read named properties off. A `null`/array/primitive
 * spreads silently (`{...null}` → `{}`, `{...'ab'}` → `{0:'a',1:'b'}`) rather than
 * throwing, which is worse than a crash: it corrupts state quietly instead of telling
 * the caller they made a mistake.
 *
 * Delegates to `@controlium/utils`'s `Utils.assertShape` (added upstream 2026-09-29
 * specifically to absorb this and its three siblings below — see `UTILS_CANDIDATES.md`)
 * rather than hand-rolling the check. `Utils.assertShape` logs and throws in one step, so
 * — unlike {@link fail}-based checks elsewhere in this file — there is no separate log
 * call here to double up with; the `appName` is folded into `assertShape`'s `funcName`
 * argument (rendered as `[appName]`) so the failure can still be traced to a specific AUT.
 * Kept as a thin same-named wrapper (rather than calling `Utils.assertShape` directly at
 * every call site) purely so callers keep the original generic type `T` — `assertShape`'s
 * own `AssertShapeMap['nonNullObject']` is the widened `object`, which would force a cast.
 */
function requireObject<T extends object>(value: T | null | undefined, appName: string, label: string): asserts value is T {
  Utils.assertShape(value, 'nonNullObject', `[${appName}]`, label);
}

/**
 * Fails unless `value` is a `string` (empty allowed). No upstream equivalent: unlike its
 * siblings above/below, `@controlium/utils`'s `AssertShapeMap` has no permissive "any
 * string, including empty" entry — only `nonEmptyString` — so this one stays local and
 * `fail()`-based rather than delegating. Deliberately permissive because both call sites
 * (`resourcePath`, `resourcePathPreamble`) treat `''` as meaningfully different from
 * "not provided", not as an error case.
 */
function requireString(value: unknown, appName: string, label: string): asserts value is string {
  if (typeof value !== 'string') {
    fail(appName, `${label} must be a string — received ${Utils.describeValue(value)}`);
  }
}

/** Fails unless `value` is a non-empty `string`. Delegates to `Utils.assertShape` — see {@link requireObject}. */
function requireNonEmptyString(value: unknown, appName: string, label: string): asserts value is string {
  Utils.assertShape(value, 'nonEmptyString', `[${appName}]`, label);
}

/** Fails unless `value` is a finite number greater than zero. Delegates to `Utils.assertShape` — see {@link requireObject}. */
function requirePositiveNumber(value: unknown, appName: string, label: string): asserts value is number {
  Utils.assertShape(value, 'positiveNumber', `[${appName}]`, label);
}

/** Fails unless `value` is an integer in the valid TCP port range (1–65535). Delegates to `Utils.assertShape` — see {@link requireObject}. */
function requirePort(value: unknown, appName: string, label: string): asserts value is number {
  Utils.assertShape(value, 'port', `[${appName}]`, label);
}

/**
 * Fails unless `value` is exactly `'http'` or `'https'`. Stays local rather than
 * delegating to `Utils.assertShape` — this is genuinely HTTP-domain-specific (not a
 * generic shape), and `@controlium/utils`'s own `APIUtils.performHTTPOperation` now does
 * this exact check inline as domain-specific validation rather than a generic `Utils`
 * primitive. See `UTILS_CANDIDATES.md`.
 */
function requireProtocol(value: unknown, appName: string, label: string): asserts value is 'http' | 'https' {
  if (value !== 'http' && value !== 'https') {
    fail(appName, `${label} must be 'http' or 'https' — received ${Utils.describeValue(value)}`);
  }
}

/**
 * Generic guard: fails unless `value` is callable. Knows nothing about what the
 * value is supposed to be — `label` is just text for the error message, and TypeScript
 * gives no runtime guarantee that a `value` typed as a function actually is one at
 * runtime (a plain-JS consumer, or one bypassing types with `any`, can pass anything —
 * including `null`/`undefined` explicitly, not just by omission).
 *
 * Deliberately does NOT delegate to `@controlium/utils`'s `Utils.assertType(value,
 * 'function', ...)`, even though that exists and does almost the same check — using
 * it here would double-log the failure, since `assertType` already calls
 * `Log.writeLine` itself before {@link fail} logs again.
 *
 * Currently only called for this file's three AUT lifecycle handlers (`bootstrapper`,
 * `closeHandler`, `getUrlHandler`), but there's nothing handler-specific about it.
 */
function requireFunction(value: unknown, appName: string, label: string): void {
  if (typeof value !== 'function') {
    fail(appName, `${label} must be a function — received ${Utils.describeValue(value)}`);
  }
}

/**
 * Generic defensive function invocation: verifies `handler` is callable, catches a
 * synchronous throw, and enforces `timeoutMs` in case it never resolves/rejects (e.g.
 * a `close()` waiting forever on a connection that never ends) — the timeout race
 * itself is `@controlium/utils`'s `Utils.timeoutPromise`, not reimplemented here.
 * Every failure path — not a function, threw, rejected, or timed out — goes through
 * {@link fail}, so callers always get a `[appName] label ...` error with enough detail
 * to know what happened. There's nothing AUT-specific here — it would work identically
 * for any function.
 *
 * `args` is forwarded to `handler` as-is — a handler may take one argument, several,
 * or none; this doesn't assume any particular arity. `handler`'s declared type only
 * exists to let `Args`/`Result` be inferred from the real handler type at each call
 * site — at runtime it's treated as `unknown` and verified by {@link requireFunction},
 * since the actual value may not match its declared type at all (a consumer can pass
 * anything, including past `any`/casts).
 *
 * Currently only called for this file's three AUT lifecycle handlers (`bootstrapper`,
 * `closeHandler`, `getUrlHandler`) — see the call sites in `_startAUT`, `_closeAUT`,
 * and `autURL`.
 */
async function invokeHandler<Args extends unknown[], Result>(
  handler: ((...args: Args) => Result | Promise<Result>) | undefined,
  appName: string,
  label: string,
  timeoutMs: number,
  ...args: Args
): Promise<Result> {
  requireFunction(handler, appName, label);
  const fn = handler as (...args: Args) => Result | Promise<Result>;

  let resultPromise: Promise<Result>;
  try {
    resultPromise = Promise.resolve(fn(...args));
  } catch (err) {
    fail(appName, `${label} threw: ${Utils.errorMessage(err)}`);
  }

  try {
    return await Utils.timeoutPromise(resultPromise, { timeoutMS: timeoutMs, friendlyName: label });
  } catch (err) {
    fail(appName, `${label} threw: ${Utils.errorMessage(err)}`);
  }
}
