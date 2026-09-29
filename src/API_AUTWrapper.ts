import { APIUtils, JsonUtils, Log, LogLevels, Utils } from '@controlium/utils';

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
 */
export class API_AUTWrapper<Handle = unknown> {

  // ─── Instance configuration ───────────────────────────────────────────────

  private _appName: string;
  private _host: string;
  private _port?: number;
  private _protocol: 'http' | 'https';
  private _timeout: number;
  private _proxy?: string;
  private _resourcePathPreamble?: string;
  private _handlerTimeout: number;
  private _headers: APIUtils.HTTPHeaders = {};

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
   * requests immediately. Call {@link close} on the instance when done.
   *
   * The caller is responsible for choosing `port` — including offsetting it to
   * avoid collisions when tests run in parallel (e.g. multiple Cucumber/Vitest
   * workers each starting their own copy of the AUT). Loading any `.env` file
   * the bootstrapper depends on is also the caller's responsibility, before
   * calling `create()`.
   *
   * @param details.appName - Display name for the AUT used in log output.
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
   * @param details.timeout - Request timeout in ms. Defaults to `30_000`.
   * @param details.proxy - Optional proxy URL.
   * @param details.handlerTimeout - Maximum time in ms to wait for `bootstrapper`,
   *   `closeHandler`, or `getUrlHandler` to settle before treating them as hung.
   *   Defaults to `30_000`.
   * @returns A started {@link API_AUTWrapper} instance.
   * @throws {Error} if `bootstrapper` or `closeHandler` is missing or not a function,
   *   `getUrlHandler` is provided but not a function, no port is set, host is not
   *   localhost, or `bootstrapper` throws, rejects, resolves with `null`/`undefined`,
   *   or does not settle within `handlerTimeout`.
   */
  public static async create<Handle = unknown>(details: {
    appName: string;
    port: number;
    bootstrapper?: API_AUTWrapper.Bootstrapper<Handle>;
    closeHandler?: API_AUTWrapper.CloseHandler<Handle>;
    getUrlHandler?: API_AUTWrapper.GetUrlHandler<Handle>;
    host?: string;
    protocol?: 'http' | 'https';
    timeout?: number;
    proxy?: string;
    handlerTimeout?: number;
  } | null): Promise<API_AUTWrapper<Handle>> {
    // `details` is the very first thing any caller touches — validate before reading a
    // single property off it. `appName` isn't known yet (that's what we're validating),
    // so error messages up to this point use the fixed 'AUT' label.
    requireObject(details, 'AUT', 'create() details');
    const wrapper = new API_AUTWrapper<Handle>({
      appName:  details.appName,
      port:     details.port,
      host:     details.host,
      protocol: details.protocol,
      timeout:  details.timeout,
      proxy:    details.proxy,
      handlerTimeout: details.handlerTimeout,
    });
    wrapper._closeHandler  = details.closeHandler;
    wrapper._getUrlHandler = details.getUrlHandler;
    await wrapper._startAUT(details.bootstrapper);
    return wrapper;
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
    timeout?:  number;
    proxy?:    string;
    handlerTimeout?: number;
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

    const timeout = config.timeout ?? 30_000;
    requirePositiveNumber(timeout, this._appName, 'timeout');
    this._timeout = timeout;

    if (!Utils.isUndefined(config.proxy)) {
      requireNonEmptyString(config.proxy, this._appName, 'proxy');
    }
    this._proxy = config.proxy;

    const handlerTimeout = config.handlerTimeout ?? 30_000;
    requirePositiveNumber(handlerTimeout, this._appName, 'handlerTimeout');
    this._handlerTimeout = handlerTimeout;
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
   * Hostname the AUT listens on. Must be `'localhost'` — remote hosts are not
   * supported for controlled local execution.
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

  // ─── Config: timeout ──────────────────────────────────────────────────────

  /**
   * Maximum time in milliseconds to wait for this AUT to respond to a request.
   * @default 30_000
   */
  public set timeout(value: number) {
    requirePositiveNumber(value, this._appName, 'timeout');
    this._timeout = value;
  }
  /** @see {@link timeout} setter */
  public get timeout(): number { return this._timeout; }

  // ─── Config: handlerTimeout ───────────────────────────────────────────────

  /**
   * Maximum time in milliseconds to wait for the consumer-supplied `bootstrapper`,
   * `closeHandler`, or `getUrlHandler` to settle before treating them as hung and
   * throwing. Guards against a handler that never resolves/rejects (e.g. a server
   * `close()` waiting forever on a keep-alive connection that never ends).
   * @default 30_000
   */
  public set handlerTimeout(value: number) {
    requirePositiveNumber(value, this._appName, 'handlerTimeout');
    this._handlerTimeout = value;
  }
  /** @see {@link handlerTimeout} setter */
  public get handlerTimeout(): number { return this._handlerTimeout; }

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
   */
  public set resourcePathPreamble(value: string | undefined) {
    if (!Utils.isUndefined(value)) {
      requireString(value, this._appName, 'resourcePathPreamble');
    }
    this._resourcePathPreamble = value;
  }
  /** @see {@link resourcePathPreamble} setter */
  public get resourcePathPreamble(): string | undefined { return this._resourcePathPreamble; }

  // ─── State: isControlled ──────────────────────────────────────────────────

  /**
   * `true` if this AUT has been successfully started and is currently running.
   */
  public get isControlled(): boolean { return this._isControlled; }

  // ─── Headers ──────────────────────────────────────────────────────────────

  /**
   * Replaces all current session-level request headers with the provided set.
   */
  public setHeaders(headers: APIUtils.HTTPHeaders | null): void {
    requireObject(headers, this._appName, 'headers');
    this._headers = { ...headers };
    Log.writeLine(LogLevels.FrameworkInformation, `[${this._appName}] request headers set to:\n${Utils.safeStringify(this._headers)}`, { suppressMultilinePreamble: true });
  }

  /**
   * Merges the provided headers into the current session-level set, overwriting any matching keys.
   * Set a header's value to `null` to have it omitted from subsequent requests without
   * removing it from the session set — see {@link API_AUTWrapper.RequestOptions.headers}.
   */
  public mergeHeaders(headers: APIUtils.HTTPHeaders | null): void {
    requireObject(headers, this._appName, 'headers');
    this._headers = { ...this._headers, ...headers };
    Log.writeLine(LogLevels.FrameworkInformation, `[${this._appName}] request headers merged to:\n${Utils.safeStringify(this._headers)}`, { suppressMultilinePreamble: true });
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
    this._resourcePathPreamble = undefined;
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
   * Per-call headers are merged on top of the current session headers.
   * If the body is a JSON object (or a JSON string), `Content-Type` is inferred automatically
   * unless the caller has explicitly set it — including explicitly to `null` (see
   * {@link API_AUTWrapper.RequestOptions.headers}).
   *
   * `timeout` and `proxy` fall back to the session-level {@link timeout}/{@link proxy}
   * when not given per-call; `queryString` has no session-level equivalent.
   *
   * @param method - HTTP method (e.g. `'GET'`, `'POST'`, `'DELETE'`).
   * @param resourcePath - Path relative to the AUT root (e.g. `'/users/42'`).
   *   Prepended with {@link resourcePathPreamble} if set.
   * @param options - Optional per-request headers, body, query string, timeout, and proxy.
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
    if (!Utils.isUndefined(options.timeout)) {
      requirePositiveNumber(options.timeout, this._appName, 'options.timeout');
    }
    if (!Utils.isUndefined(options.proxy)) {
      requireNonEmptyString(options.proxy, this._appName, 'options.proxy');
    }

    const fullPath = (this._resourcePathPreamble ?? '') + resourcePath;

    const mergedHeaders: APIUtils.HTTPHeaders = {
      ...this._headers,
      ...(options.headers ?? {}),
    };

    // Infer Content-Type for JSON bodies unless the caller has explicitly set it —
    // including to `null`, which signals "omit this header" (see buildHeaders in
    // @controlium/utils) and must not be clobbered by inference.
    if (Utils.isUndefined(mergedHeaders['Content-Type']) && JsonUtils.isJson(options.body)) {
      mergedHeaders['Content-Type'] = APIUtils.APPLICATION_JSON;
    }

    const httpRequest: APIUtils.HTTPRequest = {
      method,
      protocol: this._protocol,
      host:     `${this._host}:${this._port}`,
      resourcePath: fullPath,
      queryString: options.queryString,
      headers:  mergedHeaders,
      body:     options.body,
      proxy:    options.proxy ?? this._proxy,
      timeout:  options.timeout ?? this._timeout,
    };

    Log.writeLine(
      LogLevels.FrameworkInformation,
      `HTTP [${method}] → ${this._protocol}://${httpRequest.host}${fullPath}`
    );

    try {
      const response = await APIUtils.performHTTPOperation(httpRequest);
      this._transactions.push({ request: httpRequest, response });
      Log.writeLine(
        LogLevels.FrameworkInformation,
        `[${this._appName}] responded: ${response.status} ${response.statusMessage}`
      );
    } catch (err) {
      const errText = Utils.errorMessage(err);
      Log.writeLine(LogLevels.Error, `[${this._appName}] did not respond to [${method} ${fullPath}]: ${errText}`);
      this._transactions.push({ request: httpRequest, error: errText });
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
      this._getUrlHandler, this._appName, 'getUrlHandler', this._handlerTimeout, this._handle
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
      Log.writeLine(LogLevels.FrameworkInformation, `[${this._appName}] is not running`);
      return false;
    }
    try {
      const url = await this.autURL();
      if (!url) {
        Log.writeLine(LogLevels.Error, `[${this._appName}] running but getUrlHandler returned empty`);
        return false;
      }
      Log.writeLine(LogLevels.FrameworkInformation, `[${this._appName}] is live at ${url}`);
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

    if (!Utils.isUndefined(this._handle)) {
      Log.writeLine(LogLevels.FrameworkDebug, `[${this._appName}] already running — closing before restart`);
      await this._closeAUT();
    }

    Log.writeLine(LogLevels.FrameworkInformation, `Starting [${this._appName}] on port ${this._port}`);

    const handle = await invokeHandler(
      this._bootstrapper, this._appName, 'bootstrapper', this._handlerTimeout, this._port as number
    );
    if (Utils.isNullOrUndefined(handle)) {
      fail(this._appName, `bootstrapper resolved but returned ${Utils.describeValue(handle)} — a real AUT handle is required`);
    }
    this._handle = handle;

    this._isControlled = true;
    Log.writeLine(LogLevels.FrameworkInformation, `[${this._appName}] started successfully`);
  }

  private async _closeAUT(): Promise<void> {
    if (!Utils.isUndefined(this._handle)) {
      const handle = this._handle;
      Log.writeLine(LogLevels.FrameworkDebug, `Calling closeHandler for [${this._appName}]`);
      try {
        // Re-validated here (not just at create() time) — the handler is invoked
        // again defensively at the point of actual use, never assumed still valid.
        await invokeHandler(
          this._closeHandler, this._appName, 'closeHandler', this._handlerTimeout, handle
        );
        Log.writeLine(LogLevels.FrameworkDebug, `[${this._appName}] closed`);
      } finally {
        this._handle = undefined;
      }
    }
  }
}

// ─── Namespace ────────────────────────────────────────────────────────────────

export namespace API_AUTWrapper {

  /**
   * A function that starts the application on the given port and returns a handle
   * of type `Handle`. The framework calls this; the consumer provides it (e.g. wrapping
   * `NestFactory.create`). The handle's shape is entirely up to the caller — it's
   * passed as-is to {@link CloseHandler} and {@link GetUrlHandler}, never inspected.
   */
  export type Bootstrapper<Handle = unknown> = (port: number) => Promise<Handle>;

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
    body?: string | object;
    /**
     * Query string appended to the request URL (e.g. `'foo=bar'` or `'?foo=bar'` — the
     * leading `?` is optional). No session-level equivalent — set per-call only.
     */
    queryString?: string;
    /**
     * Overrides the session-level {@link API_AUTWrapper.timeout} for this request only.
     * Falls back to {@link API_AUTWrapper.timeout} when not given.
     */
    timeout?: number;
    /**
     * Overrides the session-level {@link API_AUTWrapper.proxy} for this request only.
     * Falls back to {@link API_AUTWrapper.proxy} when not given.
     */
    proxy?: string;
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
