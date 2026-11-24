import { existsSync } from 'node:fs';

import { config as loadDotenvFile } from 'dotenv';

import { APIUtils, JsonUtils, Log, LogLevels, Settings, Utils } from '@controlium/utils';
import type { LogLevel } from '@controlium/utils';

import { assertNoManagedAUTPortsOpen as checkNoManagedAUTPortsOpen, isPortStillOpen, rememberBootstrappedAddress } from './detectLeakedAUTPorts.js';
import { buildNextHopRequest, isARedirectStatus, locationHeaderValue, MAX_REDIRECTS_FOLLOWED } from './followRedirects.js';
import {
  assertNameNotUsedByOtherKind,
  assertNothingLeftRegisteredFromLastTest,
  closeAndForgetEveryAUTAndAPI,
  findAUTByName,
  findAUTOrAPIByTargetText as lookUpAUTOrAPIByTargetText,
  findOnlyRegisteredAUT,
  registerAPI as fileAPIRegistration,
  registerAUT,
} from './namedAUTsAndAPIs.js';
import {
  forgetStagedRequestHeaders,
  forgetStagedRequestQueryParams,
  stageNextRequestHeaders,
  stageNextRequestQueryParams,
  takeStagedRequestHeaders,
  takeStagedRequestQueryParams,
} from './oneShotNextRequestOverrides.js';
import {
  callHandlerWithTimeout,
  logAndThrow,
  requireAnyString,
  requireCallableFunction,
  requireHttpOrHttps,
  requireNonEmptyString,
  requireNonNullObject,
  requirePositiveNumber,
  requireValidPort,
} from './requireValidArguments.js';
import { resolveAPISettingsPrefix, resolveAUTSettingsPrefix } from './settingsBlockPrefix.js';

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
 *   api = await API_AUTWrapper.startNewApplication({
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
 * const api = await API_AUTWrapper.startNewApplication({
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
 *   authApi  = await API_AUTWrapper.startNewApplication({ appName: 'AuthAPI',  port: 3001, ...authAutHandlers });
 *   orderApi = await API_AUTWrapper.startNewApplication({ appName: 'OrderAPI', port: 3002, ...orderAutHandlers });
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
 * {@link startNewApplication} starts the AUT immediately and takes its config inline. For a
 * suite that wants config resolved from settings (per-environment profiles, env vars, npm
 * package config — see {@link loadSettings}) and the AUT's actual start to be its own visible,
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
  // named preamble is selected (see switchResourcePathPreamble), kept separate from
  // _resourcePathPreamble itself (the EFFECTIVE value request() reads) specifically so
  // switching named preambles never accumulates onto a previous selection — each switch
  // recomputes fresh from this same base, never from whatever the last switch left behind.
  private _resourcePathPreambleBase?: string;
  private _namedResourcePathPreambles: Record<string, string> = {};
  private _autHandlerTimeout: number;
  private _headers: APIUtils.HTTPHeaders = {};
  private _queryParams: APIUtils.QueryParams = {};
  // 'aut' for every instance created via startNewApplication()/prepareApplication() (the
  // default — unchanged behaviour for every existing caller); 'api' only for one created via
  // registerAPI()/prepareAPI(). Never settable by a caller — set directly on the instance by
  // those four static factories only, immediately after construction. Governs which
  // settings prefix/registry loadSettings() resolves against, whether it also resolves
  // autHandlerTimeout (an API has no bootstrapper/closeHandler/getUrlHandler for that
  // timeout to ever bound), and what Transaction.target records for every request sent
  // through this instance.
  private _kind: 'aut' | 'api' = 'aut';

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
   * {@link closeAllAUTsAndAPIs}, since this method registers the result the same way
   * {@link prepareApplication} does (see {@link getApplication}/{@link closeAllAUTsAndAPIs}).
   *
   * The caller is responsible for choosing `port` — including offsetting it to
   * avoid collisions when tests run in parallel (e.g. multiple Cucumber/Vitest
   * workers each starting their own copy of the AUT). Loading any `.env` file
   * the bootstrapper depends on is also the caller's responsibility, before
   * calling `startNewApplication()`.
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
   *   if omitted, {@link resolveURL}/{@link isLive} fall back to `protocol://host:port`.
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
   *   does not settle within `autHandlerTimeout`, `appName` is already registered
   *   and currently running (`close()` it first), or `appName` is already registered as an
   *   API (see {@link registerAPI}/{@link prepareAPI}).
   */
  public static async startNewApplication<Handle = unknown>(details: API_AUTWrapper.NewApplicationDetails<Handle> | null): Promise<API_AUTWrapper<Handle>> {
    // `details` is the very first thing any caller touches — validate before reading a
    // single property off it. `appName` isn't known yet (that's what we're validating),
    // so error messages up to this point use the fixed 'AUT' label.
    requireNonNullObject(details, 'AUT', 'startNewApplication() details');
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
    const existingEntry = findAUTByName(wrapper.appName);
    if (!Utils.isUndefined(existingEntry) && existingEntry.isSelfManaged) {
      logAndThrow(wrapper.appName, 'is already running — close() it before calling startNewApplication() again with the same name');
    }
    assertNameNotUsedByOtherKind(wrapper.appName, 'aut');

    wrapper._closeHandler  = details.closeHandler;
    wrapper._getUrlHandler = details.getUrlHandler;
    await wrapper._startAUT(details.bootstrapper);
    registerAUT(wrapper.appName, wrapper as unknown as API_AUTWrapper);
    rememberBootstrappedAddress(wrapper.appName, wrapper.host, wrapper.port);
    return wrapper;
  }

  // ─── Named application registry ────────────────────────────────────────────
  //
  // The actual name→instance lookup tables, the cross-registry collision guard, and the
  // port-leak/teardown checks all live in ./namedAUTsAndAPIs.js and ./detectLeakedAUTPorts.js
  // — see each module's own doc comment. Everything below here is this class's thin public
  // surface over them.

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
   * Unlike {@link startNewApplication}, `host`/`port`/`protocol`/`requestTimeout`/`proxy`/
   * `autHandlerTimeout`/`resourcePathPreamble` are never supplied inline here — they come
   * exclusively from a mandatory settings block for this `appName` (see {@link loadSettings}
   * for exactly how, and why that's mandatory rather than falling back to defaults). Only the
   * handler *functions* are supplied directly, since those are code, not data, and can't
   * meaningfully come from a settings/profile system.
   *
   * Use {@link startNewApplication} directly instead, with inline configuration, for an AUT
   * that genuinely needs no settings-driven configuration at all.
   *
   * `handlers` with no `bootstrapper` at all (e.g. `{}`) is a legitimate, intentional way to
   * use this — not just "prepared, start it later" but "this process will *never* start it":
   * registering a genuinely external/already-running target purely to resolve its
   * settings-driven `host`/`port`/`protocol` under a name, so {@link request} can reach it
   * exactly like any self-bootstrapped AUT, without this process ever claiming to own its
   * lifecycle. Such an instance is deliberately excluded from
   * {@link assertNoManagedAUTPortsOpen}'s domain — this process never started it, so it has
   * nothing to verify was stopped.
   *
   * @param appName - Name this application is registered under, and the key used to look
   *   up its settings block. Required, non-empty — there is no default name.
   * @param handlers - The lifecycle handler functions — same meaning as on {@link startNewApplication}.
   * @returns The prepared, not-yet-started {@link API_AUTWrapper} instance. Capturing it is
   *   optional; {@link startApplication}/{@link stopApplication} can reach the same instance
   *   by name instead.
   * @throws {Error} if `appName` is missing, if this name is already registered **and
   *   currently running** (stop it via {@link stopApplication} before preparing it again —
   *   re-preparing a running app would resolve new configuration without anything actually
   *   re-binding to it), if `appName` is already registered as an API (see
   *   {@link registerAPI}/{@link prepareAPI}), or if {@link loadSettings} finds no
   *   settings configured for `appName`.
   */
  public static prepareApplication<Handle = unknown>(
    appName: string,
    handlers: API_AUTWrapper.PrepareApplicationHandlers<Handle> | null
  ): API_AUTWrapper<Handle> {
    requireNonEmptyString(appName, 'AUT', 'appName');
    requireNonNullObject(handlers, appName, 'prepareApplication handlers');

    const existing = findAUTByName(appName);
    if (!Utils.isUndefined(existing) && existing.isSelfManaged) {
      logAndThrow(appName, 'is already running — stopApplication() it before preparing it again');
    }
    assertNameNotUsedByOtherKind(appName, 'aut');

    const wrapper = new API_AUTWrapper<Handle>({ appName });
    wrapper.loadSettings();
    wrapper._bootstrapper  = handlers.bootstrapper;
    wrapper._closeHandler  = handlers.closeHandler;
    wrapper._getUrlHandler = handlers.getUrlHandler;

    // The registry is deliberately type-erased — different named apps can have entirely
    // different `Handle` types, and nothing reading from it (just startApplication's/
    // stopApplication's own calls) needs to know what it is.
    registerAUT(appName, wrapper as unknown as API_AUTWrapper);
    // Only remember this endpoint for assertNoManagedAUTPortsOpen's sake when a real
    // bootstrapper was actually supplied — i.e. this process might genuinely start it later.
    // Without one, startApplication() can never be called for this name at all ever (it
    // would fail with "no bootstrapper set"), so this process will never own stopping it
    // either.
    if (!Utils.isUndefined(handlers.bootstrapper)) {
      rememberBootstrappedAddress(appName, wrapper.host, wrapper.port);
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
   *   bootstrapper/closeHandler/port-related reasons as {@link startNewApplication}.
   */
  public static async startApplication<Handle = unknown>(appName: string): Promise<API_AUTWrapper<Handle>> {
    requireNonEmptyString(appName, 'AUT', 'appName');
    const wrapper = findAUTByName(appName);
    if (Utils.isUndefined(wrapper)) {
      logAndThrow(appName, 'is not prepared — call prepareApplication() first (did your suite wire this app up in Before?)');
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
    const wrapper = findAUTByName(appName);
    if (Utils.isUndefined(wrapper)) {
      logAndThrow(appName, 'is not registered — nothing to stop (did prepareApplication()/startApplication() run for this name?)');
    }
    await wrapper.close();
  }

  /**
   * Finds an already-registered {@link API_AUTWrapper} instance by name — the same instance
   * {@link startNewApplication}/{@link prepareApplication} returned, found by name rather than
   * by holding onto the reference directly. Purely a lookup: never starts, stops, or changes
   * anything, so it's always safe to call, as many times as needed.
   *
   * @param appName - The name to look up (the one passed to `startNewApplication`/
   *   `prepareApplication`, or `'AUT'` if neither gave one explicitly). Omit entirely — or
   *   pass `undefined` — to mean "the AUT": this resolves to the single currently-registered
   *   instance, which only works when exactly one is registered. With zero or more than one,
   *   there is nothing a bare "AUT" could mean unambiguously, so this throws rather than
   *   guessing which one — e.g. for a Cucumber step wired to accept either `AUT` or
   *   `[<name>]` as its target.
   * @returns The registered instance.
   * @throws {Error} If `appName` is given but nothing is registered under that name; or if
   *   `appName` is omitted and zero, or more than one, AUT is currently registered.
   */
  public static getApplication<Handle = unknown>(appName?: string): API_AUTWrapper<Handle> {
    if (Utils.isUndefined(appName)) {
      return findOnlyRegisteredAUT() as API_AUTWrapper<Handle>;
    }
    requireNonEmptyString(appName, 'AUT', 'appName');
    const wrapper = findAUTByName(appName);
    if (Utils.isUndefined(wrapper)) {
      logAndThrow(appName, 'is not registered — nothing to find (did startNewApplication()/prepareApplication() run for this name?)');
    }
    return wrapper as API_AUTWrapper<Handle>;
  }

  /**
   * Closes every currently-registered AUT and clears both registries entirely, regardless of
   * whether each one was ever actually started ({@link close} already safely no-ops for one
   * that wasn't). Called automatically by `@controlium/framework`'s own `afterTest()` so a
   * test never has to remember to close what it registered, and so no registered AUT can
   * ever leak into whatever test runs next, regardless of whether that test ever calls
   * `startNewApplication()`/`prepareApplication()` itself.
   *
   * @throws {Error} If any registered AUT's `close()` throws — the error lists every AUT
   *   that failed, by name, not just the first.
   */
  public static async closeAllAUTsAndAPIs(): Promise<void> {
    await closeAndForgetEveryAUTAndAPI();
  }

  /**
   * Verifies nothing is left registered as either an AUT or an API at the very start of the
   * *next* test — i.e. did the previous test's own {@link closeAllAUTsAndAPIs} (called by
   * `@controlium/framework`'s `afterTest()`) run *at all*? See
   * `namedAUTsAndAPIs.ts`'s `assertNothingLeftRegisteredFromLastTest` for the full reasoning,
   * including how this differs from {@link assertNoManagedAUTPortsOpen}.
   *
   * @throws {Error} listing every `appName` still present in either registry, if any are.
   */
  public static assertNoAUTsOrAPIsStillRegistered(): void {
    assertNothingLeftRegisteredFromLastTest();
  }

  /**
   * Verifies none of this process's ever-bootstrapped AUTs still has an open port — meant to
   * be called at the very start of the *next* test, before it does anything else, so a
   * previous test's teardown failure (a genuine bug, or a badly-behaved AUT that ignored its
   * own shutdown signal) is caught immediately rather than silently letting the next test
   * start against a stale, still-running instance. Deliberately scoped to AUTs this process
   * genuinely started itself — see `detectLeakedAUTPorts.ts`'s own doc comment for why a
   * remote AUT or an API is excluded.
   *
   * @throws {Error} listing every `appName`/`host:port` still open, if any are.
   */
  public static async assertNoManagedAUTPortsOpen(): Promise<void> {
    await checkNoManagedAUTPortsOpen();
  }

  // ─── API registry & factory ────────────────────────────────────────────────

  /**
   * Creates, configures, and registers a new API — a connection target this process
   * never starts, stops, or owns the lifecycle of (no `bootstrapper`/`closeHandler`/
   * `getUrlHandler` — see {@link NewAPIDetails}), registered so {@link request}/
   * {@link setHeaders}/{@link transactions}/etc. all work on it identically to an AUT (same
   * underlying class, same instance methods). Use this for a genuinely external/
   * already-running HTTP target (a shared staging service, a third-party API) that this
   * suite only ever talks *to*, never manages.
   *
   * Parallel to, but deliberately separate from, {@link startNewApplication} — rather than
   * overloading it with an extra parameter, which would risk its existing
   * signature/behaviour.
   *
   * Unlike {@link startNewApplication}'s `appName` (which defaults to `'AUT'` when omitted),
   * `appName` is mandatory here — `'AUT'`/`'API'` are both reserved literals
   * {@link findAUTOrAPIByTargetText} treats specially; silently defaulting an unnamed API to
   * `'AUT'` (what the shared constructor would otherwise do) would collide with that meaning.
   * `port` is likewise required eagerly here, unlike the shared constructor's own optional
   * `port` — an AUT only ever discovers a missing port at `_startAUT()` time, but an API
   * never calls `_startAUT()` at all, so without this explicit check a portless API would
   * construct successfully and only fail much later, confusingly, at its first
   * {@link request} call.
   *
   * @param details.appName - Name this API is registered under (see
   *   {@link findAUTOrAPIByTargetText}). Required, non-empty.
   * @param details.port - Port the API listens on. Required.
   * @param details.host - Hostname. Defaults to `'localhost'` — but, unlike an AUT, never
   *   required to equal `'localhost'`: this instance never calls `_startAUT()`, so that
   *   enforcement point never runs for it.
   * @param details.protocol - `'http'` or `'https'`. Defaults to `'http'`.
   * @param details.requestTimeout - Request timeout in ms. Defaults to `30_000`.
   * @param details.proxy - Optional proxy URL.
   * @returns The registered {@link API_AUTWrapper} API instance.
   * @throws {Error} if `details` is missing, `appName`/`port` is missing or invalid, or
   *   `appName` is already registered as an API or as an AUT.
   */
  public static registerAPI(details: API_AUTWrapper.NewAPIDetails | null): API_AUTWrapper {
    requireNonNullObject(details, 'API', 'registerAPI() details');
    requireNonEmptyString(details.appName, 'API', 'appName');
    requireValidPort(details.port, details.appName, 'port');
    assertNameNotUsedByOtherKind(details.appName, 'api');

    const wrapper = new API_AUTWrapper({
      appName:  details.appName,
      port:     details.port,
      host:     details.host,
      protocol: details.protocol,
      requestTimeout: details.requestTimeout,
      proxy:    details.proxy,
    });
    wrapper._kind = 'api';

    fileAPIRegistration(wrapper.appName, wrapper);
    Log.writeLine(LogLevels.TestInformation, `[${wrapper.appName}] API registered: ${wrapper.protocol}://${wrapper.host}:${wrapper.port}`);
    return wrapper;
  }

  /**
   * Resolves a named API's connection details entirely from settings (see
   * {@link loadSettings}, branched for {@link targetKind} `'api'`) and registers the result
   * under `appName`. There is no two-step "prepare then start" story here, unlike
   * {@link prepareApplication}/{@link startApplication} — an API is fully usable the
   * moment this returns; there is no `startAPI()`.
   *
   * @param appName - Name this API is registered under, and the key used to look up its
   *   settings block (`$.testAPIs.<appName>.*` by default — see
   *   {@link resolveAPISettingsPrefix}). Required, non-empty.
   * @returns The registered {@link API_AUTWrapper} API instance.
   * @throws {Error} if `appName` is missing; if already registered as an API or as an
   *   AUT; or if {@link loadSettings} finds no `port` configured for `appName`.
   */
  public static prepareAPI(appName: string): API_AUTWrapper {
    requireNonEmptyString(appName, 'API', 'appName');
    assertNameNotUsedByOtherKind(appName, 'api');

    const wrapper = new API_AUTWrapper({ appName });
    wrapper._kind = 'api';
    wrapper.loadSettings();

    fileAPIRegistration(appName, wrapper);
    Log.writeLine(LogLevels.FrameworkDebug, `[${appName}] API prepared from settings`);
    return wrapper;
  }

  /**
   * Resolves a step/runner's `AUT` / `API` / `[name]` target text into the registered
   * {@link API_AUTWrapper} instance it refers to — runner-agnostic, so `@controlium/cucumber`'s
   * (and any future runner's) step-defs just call it rather than duplicating this three-way
   * dispatch themselves. See `namedAUTsAndAPIs.ts`'s own implementation for the full
   * `'AUT'`/`'API'`/`[name]` dispatch logic.
   *
   * @param targetText - The raw captured step text: `'AUT'`, `'API'`, or `[name]`.
   * @returns The resolved {@link API_AUTWrapper} instance — an AUT or an API.
   * @throws {Error} If `targetText`'s bracketed name is registered as neither; if it is
   *   (impossibly) registered as both; or any of the usual zero/ambiguous-registration
   *   errors for the unqualified `'AUT'`/`'API'` cases.
   */
  public static findAUTOrAPIByTargetText<Handle = unknown>(targetText: string): API_AUTWrapper<Handle> {
    requireNonEmptyString(targetText, 'AUT', 'targetText');
    return lookUpAUTOrAPIByTargetText(targetText) as API_AUTWrapper<Handle>;
  }

  // ─── One-shot "next request" header override ───────────────────────────────

  /**
   * Stages a one-shot header override that *replaces* session headers entirely — but only
   * for whichever AUT's {@link request} fires next, across the whole test, regardless of
   * which AUT that turns out to be.
   *
   * @param headers - The literal/file-sourced portion — plain, already-typed values (never
   *   containing `ValueExpression` verb-grammar).
   * @param dataTableValueExpressions - The table/config-cell-sourced portion, if any, as
   *   **raw, unresolved** `ValueExpression.parse` source text per key, resolved lazily at the
   *   moment {@link request} actually consumes it — see `oneShotNextRequestOverrides.ts`'s
   *   own doc comment for why. A key here always wins over the same key in `headers` once
   *   resolved, matching `@controlium/cucumber`'s own convention for same-key precedence.
   * @throws {Error} If `headers` is not a non-null object.
   */
  public static setNextRequestHeaders(headers: APIUtils.HTTPHeaders | null, dataTableValueExpressions?: Record<string, string>): void {
    requireNonNullObject(headers, 'AUT', 'headers');
    stageNextRequestHeaders('replace', headers, dataTableValueExpressions);
  }

  /**
   * Stages a one-shot header override that *merges* onto session headers — but only for
   * whichever AUT's {@link request} fires next. See {@link setNextRequestHeaders} for the
   * rest; the only difference is `replace` vs `merge` once consumed.
   *
   * @throws {Error} If `headers` is not a non-null object.
   */
  public static mergeNextRequestHeaders(headers: APIUtils.HTTPHeaders | null, dataTableValueExpressions?: Record<string, string>): void {
    requireNonNullObject(headers, 'AUT', 'headers');
    stageNextRequestHeaders('merge', headers, dataTableValueExpressions);
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
    forgetStagedRequestHeaders();
  }

  // ─── One-shot "next request" query-params override ─────────────────────────

  /**
   * Stages a one-shot query-params override that *replaces* session query params entirely
   * — but only for whichever AUT's {@link request} fires next. Same lifecycle as
   * {@link setNextRequestHeaders} — see its own doc comment, including the
   * `dataTableValueExpressions` parameter.
   *
   * @throws {Error} If `queryParams` is not a non-null object.
   */
  public static setNextRequestQueryParams(queryParams: APIUtils.QueryParams | null, dataTableValueExpressions?: Record<string, string>): void {
    requireNonNullObject(queryParams, 'AUT', 'queryParams');
    stageNextRequestQueryParams('replace', queryParams, dataTableValueExpressions);
  }

  /**
   * Stages a one-shot query-params override that *merges* onto session query params — but
   * only for whichever AUT's {@link request} fires next. See {@link setNextRequestQueryParams}
   * for the rest; the only difference is `replace` vs `merge` once consumed.
   *
   * @throws {Error} If `queryParams` is not a non-null object.
   */
  public static mergeNextRequestQueryParams(queryParams: APIUtils.QueryParams | null, dataTableValueExpressions?: Record<string, string>): void {
    requireNonNullObject(queryParams, 'AUT', 'queryParams');
    stageNextRequestQueryParams('merge', queryParams, dataTableValueExpressions);
  }

  /**
   * Clears any staged one-shot query-params override without it ever being applied to a
   * request. Same automatic-clearing guarantee (via `afterTest()`) as
   * {@link clearNextRequestHeaders} — see its own doc comment.
   *
   * Safe to call when nothing is staged.
   */
  public static clearNextRequestQueryParams(): void {
    forgetStagedRequestQueryParams();
  }

  // ─── Constructor ──────────────────────────────────────────────────────────

  /**
   * Creates an unconfigured, not-yet-started instance.
   * Prefer {@link startNewApplication} to obtain a fully started instance.
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
    requireNonNullObject(config, 'AUT', 'config');

    const appName = config.appName ?? 'AUT';
    requireNonEmptyString(appName, 'AUT', 'appName');
    this._appName = appName;

    const host = config.host ?? 'localhost';
    requireNonEmptyString(host, this._appName, 'host');
    this._host = host;

    if (!Utils.isUndefined(config.port)) {
      requireValidPort(config.port, this._appName, 'port');
    }
    this._port = config.port;

    const protocol = config.protocol ?? 'http';
    requireHttpOrHttps(protocol, this._appName, 'protocol');
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
   * setter alone can't yet know whether `startApplication()`/`startNewApplication()` will
   * ever be called for this instance. A {@link prepareApplication}-only instance that's never
   * started at all (the external-target pattern — see that method's own doc comment) has no
   * such restriction: `_startAUT` never runs for it, so a genuinely remote `host` is
   * legitimate.
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
   * Port the AUT listens on. Must be set before calling {@link startNewApplication} or
   * {@link request}.
   */
  public set port(value: number) {
    requireValidPort(value, this._appName, 'port');
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
    requireHttpOrHttps(value, this._appName, 'protocol');
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
   * Setting this directly also establishes it as the *base* {@link switchResourcePathPreamble}
   * recomputes from — selecting a named preamble afterwards combines with whatever was set
   * here, not with the result of any previous named selection (see that method's own doc
   * comment for why that distinction matters).
   */
  public set resourcePathPreamble(value: string | undefined) {
    if (!Utils.isUndefined(value)) {
      requireAnyString(value, this._appName, 'resourcePathPreamble');
    }
    this._resourcePathPreamble = value;
    this._resourcePathPreambleBase = value;
  }
  /** @see {@link resourcePathPreamble} setter */
  public get resourcePathPreamble(): string | undefined { return this._resourcePathPreamble; }

  /**
   * Switches to a named resource path preamble, resolved from this AUT's settings-driven
   * `resourcePathPreambles` map (`$.testAUTs.<appName>.resourcePathPreambles`) — e.g.
   * selecting `'V2'` when that map is `{ V1: '/api/v1', V2: '/api/v2' }` makes every
   * subsequent {@link request} call go to `/api/v2/...` instead.
   *
   * **Replaces, never accumulates.** Each call recomputes {@link resourcePathPreamble}
   * fresh from the *base* value — whatever {@link resourcePathPreamble} held before the
   * first `switchResourcePathPreamble` call in this session, from settings or set directly —
   * not from whatever the previous `switchResourcePathPreamble` call left behind. So
   * `switchResourcePathPreamble('V1')` then `switchResourcePathPreamble('V2')` lands on
   * `<base>/api/v2`, never the corrupted `<base>/api/v1/api/v2` a naive
   * always-append implementation would produce by switching twice in the same session.
   *
   * @param name - A key in this AUT's configured `resourcePathPreambles` map.
   * @throws {Error} If no `resourcePathPreambles` map is configured for this AUT, or `name`
   *   isn't a key within it — listing the names that *are* available either way, since a
   *   typo here is far more likely than a genuine "intentionally undefined" case.
   *
   * @example
   * // testAUTs.MyApp.resourcePathPreambles = { V1: '/api/v1', V2: '/api/v2' }
   * aut.switchResourcePathPreamble('V2'); // subsequent requests go to /api/v2/...
   */
  public switchResourcePathPreamble(name: string): void {
    requireNonEmptyString(name, this._appName, 'name');
    const availableNames = Object.keys(this._namedResourcePathPreambles);
    if (!Object.prototype.hasOwnProperty.call(this._namedResourcePathPreambles, name)) {
      logAndThrow(
        this._appName,
        availableNames.length === 0
          ? `has no resourcePathPreambles configured at all — cannot select [${name}]. Configure ` +
            `'resourcePathPreambles' under this AUT's settings block first.`
          : `has no resourcePathPreamble named [${name}] — available: [${availableNames.join(', ')}].`
      );
    }
    // Writes the private field directly, deliberately bypassing the public setter above —
    // that setter also updates _resourcePathPreambleBase, which must stay exactly what it
    // was before this call (or any earlier switchResourcePathPreamble call) for the
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
   * {@link startNewApplication}) or resolved here from settings. `port` is the one field
   * with no sensible framework default, and this is test-automation infrastructure: the
   * test suite must have total, explicit control over what it's testing, not a silent
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
   * mid-test (e.g. a differently-configured test wanting a longer timeout) is always
   * safe and always applied.
   *
   * **Also resolves `dotEnvPath`** and, if configured, loads it into `process.env` via
   * `dotenv` (with `override: true`, so this AUT's own file always wins for its own keys
   * regardless of what a previously-started sibling app's `.env` already set) — before
   * returning, so it's available to whatever runs next (typically the bootstrapper, via
   * {@link startApplication}). Every resolved value and its source is logged here, and a
   * configured-but-missing `.env` file fails loudly rather than silently continuing
   * without it — both deliberate, not oversights.
   *
   * Settings are looked up at `$.<prefix>.<appName>.<field>`, where `<appName>` is this
   * instance's own {@link appName} and `<prefix>` depends on {@link targetKind}: for an
   * AUT, defaults to `'testAUTs'` (overridable via `CONTROLIUM_AUT_SETTINGS_PREFIX`/
   * `autSettingsPrefix` — see {@link resolveAUTSettingsPrefix}); for an API, defaults to
   * `'testAPIs'` (overridable via `CONTROLIUM_API_SETTINGS_PREFIX`/
   * `apiSettingsPrefix` — see {@link resolveAPISettingsPrefix}). Never via the
   * profile itself, which would be a chicken-and-egg problem. An API additionally never
   * resolves `autHandlerTimeout` at all — it has no bootstrapper/closeHandler/getUrlHandler
   * for that timeout to ever bound.
   *
   * @param logLevel - Log level for the one headline summary line (the final effective
   *   configuration, and the "loaded .env file" line if one was configured) — the rest of
   *   the resolution trail always uses its own fixed tier, not this parameter (see
   *   {@link _resolveAndLogSetting} and {@link resolveAUTSettingsPrefix} for the full spread
   *   — `TestDebug` for the per-field outcome, `FrameworkInformation` for where each value
   *   actually came from, `FrameworkDebug` for the rarely-relevant settings-prefix
   *   resolution). Defaults to `TestInformation` — the one line a normal test run's usual
   *   verbosity should show, without the full per-field trail underneath it.
   * @throws {Error} if no `port` is available from any source; if `host`/`port`/`protocol`
   *   would actually change while this AUT is already running; or if a configured
   *   `dotEnvPath` doesn't exist or fails to parse.
   */
  public loadSettings(logLevel: LogLevel = LogLevels.TestInformation): void {
    const prefix = this._kind === 'api' ? resolveAPISettingsPrefix() : resolveAUTSettingsPrefix();
    const base = `$.${prefix}.${this._appName}`;

    const portResult = this._resolveAndLogSetting(base, 'port');
    if (Utils.isUndefined(portResult.value) && Utils.isUndefined(this._port)) {
      logAndThrow(
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

    // An API has no bootstrapper/closeHandler/getUrlHandler for this timeout to ever
    // bound (it never calls _startAUT()) — so, unlike every other field above/below, this
    // one is never resolved at all for an API, not even to apply a configured-but-unused
    // value. this._autHandlerTimeout simply stays at its constructor default.
    if (this._kind === 'aut') {
      const autHandlerTimeoutResult = this._resolveAndLogSetting(base, 'autHandlerTimeout');
      if (!Utils.isUndefined(autHandlerTimeoutResult.value)) {
        this.autHandlerTimeout = coerceToNumber(autHandlerTimeoutResult.value);
      }
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
    // its default would otherwise be invisible at any level a normal test run shows. The
    // AUT's actual effective configuration should always be visible, not just what changed.
    Log.writeLine(
      logLevel,
      `[${this._appName}] configuration:\n` +
      `  host: ${this._host}\n` +
      `  port: ${this._port}\n` +
      `  protocol: ${this._protocol}\n` +
      `  requestTimeout: ${this._requestTimeout}\n` +
      (this._kind === 'aut' ? `  autHandlerTimeout: ${this._autHandlerTimeout}\n` : '') +
      `  proxy: ${this._proxy ?? '(none)'}\n` +
      `  resourcePathPreamble: ${this._resourcePathPreamble ?? '(none)'}`,
      { suppressMultilinePreamble: true }
    );
  }

  /**
   * Resolves one field under this AUT's settings block and logs the outcome — never
   * silent, and never quieter for one outcome than the other, but deliberately split
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
    // value, or — for 'port' specifically — its own explicit, far more actionable throw
    // message). Settings.get's generic "Unable to determine value" Error would otherwise
    // fire for every one of these on every single ordinary, expected "not overridden via
    // settings" outcome.
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
        logAndThrow(
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
   * silently proceed without.
   */
  private _loadDotEnvFile(dotEnvPath: unknown, logLevel: LogLevel): void {
    requireNonEmptyString(dotEnvPath, this._appName, 'dotEnvPath');
    if (!existsSync(dotEnvPath)) {
      logAndThrow(this._appName, `configured dotEnvPath [${dotEnvPath}] does not exist`);
    }
    const result = loadDotenvFile({ path: dotEnvPath, override: true, quiet: true });
    if (result.error) {
      logAndThrow(this._appName, `failed to load .env file [${dotEnvPath}]: ${Utils.errorMessage(result.error)}`);
    }
    const loadedKeys = Object.keys(result.parsed ?? {});
    Log.writeLine(logLevel, `[${this._appName}] loaded ${loadedKeys.length} variable(s) from .env [${dotEnvPath}] into process.env`);
  }

  // ─── State: isSelfManaged ──────────────────────────────────────────────────

  /**
   * `true` if this process itself started this AUT (via a real `bootstrapper`) and it hasn't
   * been {@link close}d since. Always `false` for a remote AUT (one {@link prepareApplication}d
   * with no `bootstrapper` at all) or an API — neither is ever started/stopped by this
   * process, so there is no "self" for this to be true of. Use {@link resolveURL}/
   * {@link isLive} to check reachability for those instead.
   */
  public get isSelfManaged(): boolean { return this._isControlled; }

  // ─── State: targetKind ──────────────────────────────────────────────────────

  /**
   * `'aut'` for an instance created via {@link startNewApplication}/{@link prepareApplication}
   * (regardless of whether this process actually starts it — see {@link isSelfManaged} for
   * that distinction); `'api'` for one created via {@link registerAPI}/{@link prepareAPI}.
   */
  public get targetKind(): 'aut' | 'api' { return this._kind; }

  // ─── Headers ──────────────────────────────────────────────────────────────

  /**
   * Replaces all current session-level request headers with the provided set.
   *
   * `JsonUtils.SENTINEL_UNDEFINED`/`SENTINEL_NULL` ("_undefined"/"_null") are resolved in
   * the result — a header whose value is exactly `"_undefined"` is omitted entirely, and
   * one whose value is exactly `"_null"` is set to a real `null` — the one textual
   * convention for expressing those regardless of whether `headers` was built from a JSON
   * literal, a file, or a plain table/config cell (such a cell can only ever be a string,
   * so there's no other way for it to express "remove this header" or "a real null").
   *
   * No automatic token resolution happens here — see the comment inside `request()` for why
   * automatic detokenisation was removed from this class entirely.
   *
   * Async for interface stability with the rest of this class's header/query-param
   * methods — nothing inside actually awaits anything at the moment.
   */
  public async setHeaders(headers: APIUtils.HTTPHeaders | null): Promise<void> {
    requireNonNullObject(headers, this._appName, 'headers');
    this._headers = JsonUtils.resolveSentinels(headers);
    Log.writeLine(LogLevels.TestDebug, `[${this._appName}] request headers set to:\n${Utils.safeStringify(this._headers)}`, { suppressMultilinePreamble: true });
  }

  /**
   * Merges the provided headers into the current session-level set, overwriting any matching keys.
   * Set a header's value to `null` to have it omitted from subsequent requests without
   * removing it from the session set — see {@link API_AUTWrapper.RequestOptions.headers}.
   *
   * `JsonUtils.SENTINEL_UNDEFINED`/`SENTINEL_NULL` are resolved on the *merged* result, not
   * on `headers` alone — see {@link setHeaders} for what they mean. Resolving after the
   * merge (rather than before) is deliberate: it's what lets `"_undefined"` in `headers`
   * remove a header that was only ever set by an earlier call, not just one present in this
   * same call's own argument.
   *
   * Async for interface stability — see {@link setHeaders}'s own doc comment.
   */
  public async mergeHeaders(headers: APIUtils.HTTPHeaders | null): Promise<void> {
    requireNonNullObject(headers, this._appName, 'headers');
    const merged: APIUtils.HTTPHeaders = { ...this._headers, ...headers };
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
   * sentinel-resolve treatment, and the same `string[]`/`null` conventions, as
   * {@link setHeaders} (see its own doc comment for the full reasoning, not repeated
   * here). A `string[]` value sends that key more than once (e.g. `tag=a&tag=b`); `null`
   * omits the key entirely; `JsonUtils.SENTINEL_UNDEFINED`/`SENTINEL_NULL` resolve the same
   * way `setHeaders` already does.
   *
   * At request time, this session-level set and {@link API_AUTWrapper.RequestOptions.queryString}
   * (if also given) are combined, never one overriding the other — see {@link request}'s
   * own doc comment.
   *
   * Async for interface stability — see {@link setHeaders}'s own doc comment.
   */
  public async setQueryParams(queryParams: APIUtils.QueryParams | null): Promise<void> {
    requireNonNullObject(queryParams, this._appName, 'queryParams');
    this._queryParams = JsonUtils.resolveSentinels(queryParams);
    Log.writeLine(LogLevels.TestDebug, `[${this._appName}] query params set to:\n${Utils.safeStringify(this._queryParams)}`, { suppressMultilinePreamble: true });
  }

  /**
   * Merges the provided query parameters into the current session-level set, overwriting
   * any matching keys — same merge-then-sentinel-resolve ordering as {@link mergeHeaders}
   * (see its own doc comment for why that ordering matters).
   *
   * Async for interface stability — see {@link setHeaders}'s own doc comment.
   */
  public async mergeQueryParams(queryParams: APIUtils.QueryParams | null): Promise<void> {
    requireNonNullObject(queryParams, this._appName, 'queryParams');
    const merged: APIUtils.QueryParams = { ...this._queryParams, ...queryParams };
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
      logAndThrow(this._appName, 'No HTTP transactions recorded');
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
      logAndThrow(this._appName, `last transaction has no response — AUT may have crashed. Error: ${last.error ?? 'unknown'}`);
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
      logAndThrow(this._appName, 'Cannot make request — port is not set');
    }

    // `method`/`resourcePath` are typed `string`, but that's a compile-time promise only —
    // a caller stuffing up an argument (wrong order, wrong type, `any`-typed value) must be
    // caught here, not surfaced as a confusing string-concatenation or downstream HTTP error.
    requireNonEmptyString(method, this._appName, 'method');
    requireAnyString(resourcePath, this._appName, 'resourcePath');
    // `options: ... = {}` only substitutes the default for `undefined` — an explicit `null`
    // (or any non-object `any`-typed value) sails straight through and would otherwise crash
    // on `options.headers` below.
    requireNonNullObject(options, this._appName, 'options');
    if (!Utils.isUndefined(options.headers)) {
      requireNonNullObject(options.headers, this._appName, 'options.headers');
    }
    if (!Utils.isUndefined(options.queryString)) {
      requireAnyString(options.queryString, this._appName, 'options.queryString');
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

    // Consume any staged one-shot "next request" header override — genuinely global, not
    // scoped to this instance, so whichever AUT's request() fires next — this call, right
    // now — is the one that gets it. Resolved and cleared, immediately, before anything
    // below can throw, so "used once, no exceptions" holds regardless of what happens to
    // the rest of this particular request.
    const overriddenHeaders = await takeStagedRequestHeaders(this._appName, this._headers);
    const baseHeaders = overriddenHeaders ?? this._headers;

    const mergedHeaders: APIUtils.HTTPHeaders = {
      ...baseHeaders,
      ...(options.headers ?? {}),
    };

    // Same lifecycle for the one-shot query-params override.
    const overriddenQueryParams = await takeStagedRequestQueryParams(this._appName, this._queryParams);
    const baseQueryParams = overriddenQueryParams ?? this._queryParams;

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

    // No automatic token resolution happens anywhere in this method — method, resource
    // path, headers, query string, body all go out exactly as given. Automatic,
    // unconditional detokenisation here (and in setHeaders/mergeHeaders/setQueryParams/
    // mergeQueryParams, and the one-shot next-request overrides) was removed deliberately:
    // the original "JIT, at the one point every outgoing request is guaranteed to pass
    // through" design proved problematic in practice — see the root ecosystem CLAUDE.md's
    // passing it in here.
    //
    // Session/one-shot query params become a query-string fragment; combined with
    // options.queryString (if also given), never one overriding the other (see
    // APIUtils.mergeQueryStrings's own doc comment): a key set both ways survives as a
    // genuine duplicate, for the AUT to deal with, not this method's job to resolve.
    const queryParamsString = APIUtils.buildQueryString(baseQueryParams);
    const combinedQueryString = APIUtils.mergeQueryStrings(queryParamsString, options.queryString);

    const httpRequest: APIUtils.HTTPRequest = {
      method,
      protocol: this._protocol,
      host:     `${this._host}:${this._port}`,
      resourcePath: fullPath,
      queryString: combinedQueryString,
      headers:  mergedHeaders,
      body:     options.body,
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

      const location = locationHeaderValue(response.headers);
      if (!isARedirectStatus(response.status) || location === undefined) return;

      if (hop >= MAX_REDIRECTS_FOLLOWED) {
        logAndThrow(this._appName, `exceeded ${MAX_REDIRECTS_FOLLOWED} redirects while following Location headers (last target: [${location}])`);
      }
      currentRequest = buildNextHopRequest(currentRequest, response.status, location);
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
    try {
      // Makes the real call and, on success, records a completed transaction (request +
      // response) and logs a one-line status summary. targetFriendlyName is display-only
      // — performRawHTTPOperation has no concept of a named AUT; passing this AUT's own
      // name through lets its request/response detail logging show which AUT a dump
      // belongs to.
      const response = await APIUtils.performRawHTTPOperation(httpRequest, { targetFriendlyName: this._appName });
      this._transactions.push({ request: httpRequest, response, target: { kind: this._kind, name: this._appName } });
      return response;
    } catch (err) {
      // Catches any throw from performRawHTTPOperation (connection refused, DNS failure,
      // timeout, etc.) and converts it into a recorded, error-only transaction instead of
      // propagating — logs the failure, records it, and returns undefined so the caller
      // (request's redirect loop) can treat "didn't respond" as a normal, inspectable
      // outcome rather than an exception to catch itself.
      const errText = Utils.errorMessage(err);
      Log.writeLine(LogLevels.Error, `[${this._appName}] did not respond to [${httpRequest.method} ${httpRequest.resourcePath}]: ${errText}`);
      this._transactions.push({ request: httpRequest, error: errText, target: { kind: this._kind, name: this._appName } });
      return undefined;
    }
  }

  // ─── URL and liveness ────────────────────────────────────────────────────

  /**
   * Returns this instance's URL.
   *
   * For a self-managed AUT with a `getUrlHandler`, asks the handler directly — the real
   * listening URL may differ from a naive `protocol://host:port` construction (e.g. a
   * dynamically-assigned port, or framework-specific path handling). For anything else — a
   * remote AUT, an API, or a self-managed AUT that was never given a `getUrlHandler` at
   * all — falls back to building the URL directly from {@link protocol}/{@link host}/
   * {@link port}, all of which are always known for any registered instance regardless of
   * how it was created.
   *
   * @throws {Error} if `getUrlHandler` is given but doesn't return a string, or if there's
   *   no `getUrlHandler` to ask and {@link port} isn't set either.
   */
  public async resolveURL(): Promise<string> {
    if (!Utils.isUndefined(this._handle) && !Utils.isUndefined(this._getUrlHandler)) {
      const result = await callHandlerWithTimeout(
        this._getUrlHandler, this._appName, 'getUrlHandler', this._autHandlerTimeout, this._handle
      );
      if (typeof result !== 'string') {
        logAndThrow(this._appName, `getUrlHandler must return a string — received ${Utils.describeValue(result)}`);
      }
      return result;
    }
    if (Utils.isUndefined(this._port)) {
      logAndThrow(this._appName, 'cannot resolve URL — port is not set');
    }
    return `${this._protocol}://${this._host}:${this._port}`;
  }

  /**
   * Returns `true` if this instance is reachable.
   *
   * For a self-managed AUT with a `getUrlHandler`, asks the handler via {@link resolveURL}
   * — same as before, behaviourally: a throw or an empty URL both count as "not live". For
   * anything else — a remote AUT, an API, or a self-managed AUT with no `getUrlHandler` —
   * there's no handler to ask, so this does a real TCP reachability probe against
   * {@link host}:{@link port} instead of assuming "nothing to ask" means "not live": a
   * remote AUT or an API this process never started can still be genuinely up and
   * perfectly reachable.
   */
  public async isLive(): Promise<boolean> {
    if (!Utils.isUndefined(this._handle) && !Utils.isUndefined(this._getUrlHandler)) {
      try {
        const url = await this.resolveURL();
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

    if (Utils.isUndefined(this._port)) {
      Log.writeLine(LogLevels.TestInformation, `[${this._appName}] is not running`);
      return false;
    }
    const reachable = await isPortStillOpen(this._host, this._port);
    Log.writeLine(
      LogLevels.TestInformation,
      reachable
        ? `[${this._appName}] is live at ${this._protocol}://${this._host}:${this._port}`
        : `[${this._appName}] is not reachable at ${this._host}:${this._port}`
    );
    return reachable;
  }

  // ─── Internal lifecycle ───────────────────────────────────────────────────

  private async _startAUT(bootstrapper?: API_AUTWrapper.Bootstrapper<Handle>): Promise<void> {
    if (!Utils.isUndefined(bootstrapper)) this._bootstrapper = bootstrapper;

    // Fail fast at configuration time — don't wait until close()/resolveURL() are
    // actually called to discover a handler is missing or not a function.
    if (Utils.isUndefined(this._bootstrapper)) {
      logAndThrow(this._appName, 'No bootstrapper set — provide one via startNewApplication()');
    }
    requireCallableFunction(this._bootstrapper, this._appName, 'bootstrapper');

    if (Utils.isUndefined(this._closeHandler)) {
      logAndThrow(this._appName, 'No closeHandler set — provide one via startNewApplication() so close() can tear the AUT down');
    }
    requireCallableFunction(this._closeHandler, this._appName, 'closeHandler');

    if (!Utils.isUndefined(this._getUrlHandler)) {
      requireCallableFunction(this._getUrlHandler, this._appName, 'getUrlHandler');
    }

    if (Utils.isUndefined(this._port)) {
      logAndThrow(this._appName, 'No port set — set port before calling startNewApplication()');
    }

    if (this._host !== 'localhost') {
      logAndThrow(this._appName, `Host is [${this._host}] — must be 'localhost' for controlled local execution`);
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
    const handle = await callHandlerWithTimeout(
      this._bootstrapper, this._appName, 'bootstrapper', this._autHandlerTimeout, this._port as number
    );
    const startDurationMs = Date.now() - startedAt;
    if (Utils.isNullOrUndefined(handle)) {
      logAndThrow(this._appName, `bootstrapper resolved but returned ${Utils.describeValue(handle)} — a real AUT handle is required`);
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
    let url: string;
    try {
      url = await this.resolveURL();
    } catch (err) {
      url = `<unavailable: ${Utils.errorMessage(err)}>`;
    }
    const headers = this.getHeaders();
    const headersSummary = Object.keys(headers).length > 0 ? Utils.safeStringify(headers) : '<none>';
    Log.writeLine(
      LogLevels.TestDebug,
      `[${this._appName}] live state:\n` +
      `  url: ${url}\n` +
      `  isSelfManaged: ${this._isControlled}\n` +
      `  headers: ${headersSummary}`,
      { suppressMultilinePreamble: true }
    );
  }

  private async _closeAUT(): Promise<void> {
    if (!Utils.isUndefined(this._handle)) {
      const handle = this._handle;
      Log.writeLine(LogLevels.FrameworkDebug, `Calling closeHandler for [${this._appName}]`);
      try {
        // Re-validated here (not just at startNewApplication() time) — the handler is
        // invoked again defensively at the point of actual use, never assumed still valid.
        await callHandlerWithTimeout(
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

// Declaration merging — attaches NewApplicationDetails/Transaction/etc. as nested types
// reachable via `API_AUTWrapper.Transaction` — is the only way to achieve that in
// TypeScript; there's no ES2015-module equivalent for this specific pattern. It also means
// this namespace block can't be moved to its own file — declaration merging with a class
// requires both declarations in the same file.
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
   * The full, explicit configuration {@link API_AUTWrapper.startNewApplication} accepts.
   * Named mainly so `startNewApplication()`'s signature doesn't have to spell out every
   * field inline.
   */
  export interface NewApplicationDetails<Handle = unknown> {
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
   * Deliberately just the handlers — everything {@link NewApplicationDetails} has beyond
   * them (`host`/`port`/`protocol`/etc.) comes from {@link API_AUTWrapper.loadSettings}
   * instead, since `prepareApplication` is the settings-driven entry point, not the
   * explicit one.
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
     * A `Buffer` is sent byte-exact, untouched — never JSON-sniffed for
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
     * the caller's own policy (e.g. `cucumber`'s Gherkin wording and its own
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
     * actually sent, 3xx included — a deliberate choice for a test framework, not an
     * oversight.
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
   * A recorded HTTP interaction with an AUT or an API.
   * If the target did not respond, `response` will be undefined and `error` will be
   * populated. `target` identifies which registered entity (and under what name) this
   * interaction belongs to — see {@link API_AUTWrapper.targetKind}/{@link API_AUTWrapper.findAUTOrAPIByTargetText}.
   */
  export interface Transaction {
    request: APIUtils.HTTPRequest;
    response?: APIUtils.HTTPResponse;
    error?: string;
    target: { kind: 'aut' | 'api'; name: string };
  }

  /**
   * The full, explicit configuration {@link API_AUTWrapper.registerAPI} accepts. No
   * `bootstrapper`/`closeHandler`/`getUrlHandler`/`autHandlerTimeout` fields — an API is
   * never bootstrapped by this process, so none of those lifecycle concepts apply.
   */
  export interface NewAPIDetails {
    appName: string;
    port: number;
    host?: string;
    protocol?: 'http' | 'https';
    requestTimeout?: number;
    proxy?: string;
  }
}

/**
 * A setting resolved from an env var always comes back as a string even when it represents a
 * number (e.g. `"3000"`); one resolved from a profile/World object may already be a real
 * number. Normalises either into a number — including turning genuinely invalid input (e.g.
 * `"abc"`) into `NaN`, which the eventual `requireValidPort`/`requirePositiveNumber` call on
 * the target setter then rejects with its own clear error, rather than silently accepting
 * garbage. Only ever called from {@link API_AUTWrapper.loadSettings}, so it stays a plain
 * module-private function here rather than its own file.
 */
function coerceToNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}
