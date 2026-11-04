import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APIUtils, Detokeniser, Log, LogLevels, Settings } from '@controlium/utils';

import { API_AUTWrapper } from './API_AUTWrapper';

// ─── Mock @controlium/utils ───────────────────────────────────────────────────

vi.mock('@controlium/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@controlium/utils')>();
  return {
    ...actual,
    Log: { writeLine: vi.fn() },
    // Object.assign onto the real class (not a `{ ...actual.APIUtils }` plain-object spread)
    // — class methods defined with shorthand syntax are non-enumerable, so a spread silently
    // drops every static method except whatever's explicitly listed afterwards. Mutating the
    // real class in place keeps every other static method (buildURL, doRawLogging, etc.)
    // genuinely real, with only performRawHTTPOperation overridden.
    APIUtils: Object.assign(actual.APIUtils, { performRawHTTPOperation: vi.fn() }),
  };
});

const mockPerform = vi.mocked(APIUtils.performRawHTTPOperation);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT      = 14000;
const RAW_SERVER_PORT   = 14001;
const RAW_SERVER_PORT_2 = 14002;
// Own, never-reused-elsewhere ports for the registry-scoping tests below — _everKnownEndpoints
// is additive-forever (by design, see its own doc comment), so reusing a port any other test
// in this file has ever registered would falsely trip "still listening" here too.
const REGISTRY_CHECK_PORT   = 14500;
const REGISTRY_CHECK_PORT_2 = 14501;

/** Shorthand for a successful HTTP response */
const makeResponse = (
  status  = 200,
  body    = '{"ok":true}',
  headers: Record<string, string> = {},
  rawRequestBytes  = Buffer.from(''),
  rawResponseBytes = Buffer.from(''),
): APIUtils.HTTPResponse => ({
  status,
  statusMessage: status === 200 ? 'OK' : String(status),
  headers,
  body,
  bodyBuffer: Buffer.from(body),
  rawRequestBytes,
  rawResponseBytes,
});

/** A minimal stub handle — no real server, just spies for closeHandler/getUrlHandler to call. */
interface StubHandle {
  closeFn: () => Promise<void>;
  getUrlFn: () => Promise<string>;
}

function makeStubHandle(options: {
  getUrlResult?: string;
  closeShouldFail?: boolean;
  getUrlShouldFail?: boolean;
} = {}): StubHandle {
  return {
    closeFn: options.closeShouldFail
      ? vi.fn().mockRejectedValue(new Error('close failed'))
      : vi.fn().mockResolvedValue(undefined),
    getUrlFn: options.getUrlShouldFail
      ? vi.fn().mockRejectedValue(new Error('getUrl exploded'))
      : options.getUrlResult === ''
        ? vi.fn().mockResolvedValue('')
        : vi.fn().mockResolvedValue(options.getUrlResult ?? `http://localhost:${DEFAULT_PORT}`),
  };
}

/** closeHandler/getUrlHandler for stub handles — just delegate to the spies on the handle. */
const stubCloseHandler:  API_AUTWrapper.CloseHandler<StubHandle>  = (handle) => handle.closeFn();
const stubGetUrlHandler: API_AUTWrapper.GetUrlHandler<StubHandle> = (handle) => handle.getUrlFn();

/** Creates a stub bootstrapper — optionally fails at startup, with an Error or a non-Error value. */
function makeStubBootstrapper(options: {
  handle?: StubHandle;
  failToStart?: boolean;
  failWithNonError?: boolean;
} = {}): API_AUTWrapper.Bootstrapper<StubHandle> {
  const handle = options.handle ?? makeStubHandle();
  if (options.failWithNonError) return vi.fn().mockRejectedValue(null);
  return options.failToStart
    ? vi.fn().mockRejectedValue(new Error('Bootstrap failed'))
    : vi.fn().mockResolvedValue(handle);
}

/**
 * Creates a real Node.js HTTP server bootstrapper. Returns the raw `http.Server` —
 * no adapter object needed, since close()/getUrl() are supplied separately below.
 * The handler defaults to returning 200 {"ok":true}.
 */
function makeRawBootstrapper(
  handler?: (req: IncomingMessage, res: ServerResponse) => void
): API_AUTWrapper.Bootstrapper<Server> {
  return async (port: number): Promise<Server> => {
    const server = createServer(handler ?? ((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }));
    await new Promise<void>((resolve) => server.listen(port, resolve));
    return server;
  };
}

const rawCloseHandler: API_AUTWrapper.CloseHandler<Server> = (server) =>
  new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );

const rawGetUrlHandler: API_AUTWrapper.GetUrlHandler<Server> = (server) => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : undefined;
  return `http://localhost:${port}`;
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('API_AUTWrapper', () => {

  beforeEach(() => {
    mockPerform.mockReset();
  });

  // ─── Lifecycle: stub bootstrapper ──────────────────────────────────────────

  describe('Lifecycle — stub bootstrapper', () => {

    let aut: API_AUTWrapper<StubHandle>;

    afterEach(async () => {
      await aut?.close();
    });

    it('starts when bootstrapper is passed to create()', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });
      expect(aut.isControlled).toBe(true);
      expect(aut.appName).toBe('TestApp');
    });

    it('throws when no bootstrapper has been provided', async () => {
      await expect(
        API_AUTWrapper.create({ appName: 'TestApp', port: DEFAULT_PORT })
      ).rejects.toThrow(/No bootstrapper set/);
    });

    it('throws when no closeHandler has been provided', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: makeStubBootstrapper(),
        })
      ).rejects.toThrow(/No closeHandler set/);
    });

    it('throws when port has not been set', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        API_AUTWrapper.create({
          appName: 'TestApp',
          bootstrapper: makeStubBootstrapper(),
          closeHandler: stubCloseHandler,
        } as any)
      ).rejects.toThrow(/No port set/);
    });

    it('throws when host is not localhost', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          host: 'remote.example.com',
          bootstrapper: makeStubBootstrapper(),
          closeHandler: stubCloseHandler,
        })
      ).rejects.toThrow(/must be 'localhost'/);
    });

    it('propagates bootstrapper failure and leaves isControlled false', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: makeStubBootstrapper({ failToStart: true }),
          closeHandler: stubCloseHandler,
        })
      ).rejects.toThrow('Bootstrap failed');
    });

    it('propagates a non-Error bootstrapper failure without masking it', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: makeStubBootstrapper({ failWithNonError: true }),
          closeHandler: stubCloseHandler,
        })
      ).rejects.toBeDefined();
    });

    it('close resets isControlled', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });
      await aut.close();
      expect(aut.isControlled).toBe(false);
    });

    it('close is safe when nothing is running', async () => {
      aut = new API_AUTWrapper({ port: DEFAULT_PORT });
      await expect(aut.close()).resolves.not.toThrow();
    });

    it('propagates AUT closeHandler failure', async () => {
      const handle = makeStubHandle({ closeShouldFail: true });
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle }),
        closeHandler: stubCloseHandler,
      });
      await expect(aut.close()).rejects.toThrow('close failed');
    });

    it('propagates a non-Error closeHandler failure without masking it', async () => {
      const handle = makeStubHandle();
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle }),
        closeHandler: () => Promise.reject(null),
      });
      await expect(aut.close()).rejects.toBeDefined();
    });

    it('closeHandler receives the exact handle the bootstrapper returned', async () => {
      const handle = makeStubHandle();
      const receivedHandles: StubHandle[] = [];
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle }),
        closeHandler: (h) => { receivedHandles.push(h); return stubCloseHandler(h); },
      });
      await aut.close();
      expect(receivedHandles).toEqual([handle]);
    });
  });

  // ─── Defensive handler validation ──────────────────────────────────────────
  // Consumers can pass anything for bootstrapper/closeHandler/getUrlHandler —
  // not just omit them, but explicitly pass null, a string, a number, etc.
  // Every one of these must fail clearly, never with an unrelated crash or a hang.

  describe('Defensive handler validation', () => {

    let aut: API_AUTWrapper<StubHandle>;

    afterEach(async () => {
      await aut?.close();
    });

    it('throws clearly when bootstrapper is not a function', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          bootstrapper: 'not-a-function' as any,
          closeHandler: stubCloseHandler,
        })
      ).rejects.toThrow(/bootstrapper must be a function/);
    });

    it('throws clearly when closeHandler is explicitly null', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: makeStubBootstrapper(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          closeHandler: null as any,
        })
      ).rejects.toThrow(/closeHandler must be a function/);
    });

    it('throws clearly when getUrlHandler is provided but not a function', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: makeStubBootstrapper(),
          closeHandler: stubCloseHandler,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getUrlHandler: 42 as any,
        })
      ).rejects.toThrow(/getUrlHandler must be a function/);
    });

    it('throws clearly when bootstrapper resolves with undefined', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: vi.fn().mockResolvedValue(undefined),
          closeHandler: stubCloseHandler,
        })
      ).rejects.toThrow(/bootstrapper resolved but returned undefined/);
    });

    it('throws clearly when bootstrapper resolves with null', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: vi.fn().mockResolvedValue(null),
          closeHandler: stubCloseHandler,
        })
      ).rejects.toThrow(/bootstrapper resolved but returned null/);
    });

    it('throws clearly when getUrlHandler returns a non-string value', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getUrlHandler: (() => 12345) as any,
      });
      await expect(aut.autURL()).rejects.toThrow(/getUrlHandler must return a string/);
    });

    it('times out a bootstrapper that never settles, using a configurable autHandlerTimeout', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: () => new Promise<StubHandle>(() => { /* never resolves */ }),
          closeHandler: stubCloseHandler,
          autHandlerTimeout: 50,
        })
      ).rejects.toThrow(/bootstrapper threw: bootstrapper: Timeout after 50 ms/);
    });

    it('times out a closeHandler that never settles', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: () => new Promise<void>(() => { /* never resolves */ }),
        autHandlerTimeout: 50,
      });
      await expect(aut.close()).rejects.toThrow(/closeHandler threw: closeHandler: Timeout after 50 ms/);
      // _handle is cleared by the finally in _closeAUT even on failure, so the
      // afterEach's aut.close() call-again is a safe no-op.
    });

    it('times out a getUrlHandler that never settles', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
        getUrlHandler: () => new Promise<string>(() => { /* never resolves */ }),
        autHandlerTimeout: 50,
      });
      await expect(aut.autURL()).rejects.toThrow(/getUrlHandler threw: getUrlHandler: Timeout after 50 ms/);
    });

    it('catches a bootstrapper that throws synchronously rather than rejecting', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: () => { throw new Error('synchronous boom'); },
          closeHandler: stubCloseHandler,
        })
      ).rejects.toThrow(/bootstrapper threw: synchronous boom/);
    });
  });

  // ─── Defensive input validation ────────────────────────────────────────────
  // This is test-automation infrastructure — every value crossing a public boundary
  // (constructor config, create() details, setters, request() args, header objects)
  // is assumed to be untrustworthy at runtime regardless of its declared TS type,
  // since a caller can always bypass static types (JS interop, `any`, a genuine
  // mistake). Each case below simulates exactly that.

  describe('Defensive input validation', () => {

    describe('constructor / create() config', () => {

      // These five all delegate to Utils.assertShape (see UTILS_CANDIDATES.md), whose
      // message format is `Cannot [appName] as [label] not a valid 'shape'. Is [...]`.

      it('rejects a null constructor config', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper(null as any)).toThrow(/\[config\] not a valid 'nonNullObject'/);
      });

      it('rejects a non-object constructor config', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper('oops' as any)).toThrow(/\[config\] not a valid 'nonNullObject'/);
      });

      it('rejects an array constructor config', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper([1, 2, 3] as any)).toThrow(/\[config\] not a valid 'nonNullObject'/);
      });

      it('rejects a non-string appName', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper({ appName: 42 as any })).toThrow(/\[appName\] not a valid 'nonEmptyString'/);
      });

      it('rejects an empty appName', () => {
        expect(() => new API_AUTWrapper({ appName: '' })).toThrow(/\[appName\] not a valid 'nonEmptyString'/);
      });

      it('rejects a non-string host', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper({ host: 42 as any })).toThrow(/\[host\] not a valid 'nonEmptyString'/);
      });

      it('rejects a non-numeric port', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper({ port: '3000' as any })).toThrow(/\[port\] not a valid 'port'/);
      });

      it('rejects a port outside the valid TCP range', () => {
        expect(() => new API_AUTWrapper({ port: 70_000 })).toThrow(/\[port\] not a valid 'port'/);
        expect(() => new API_AUTWrapper({ port: 0 })).toThrow(/\[port\] not a valid 'port'/);
        expect(() => new API_AUTWrapper({ port: -1 })).toThrow(/\[port\] not a valid 'port'/);
      });

      it('rejects a non-integer port', () => {
        expect(() => new API_AUTWrapper({ port: 3000.5 })).toThrow(/\[port\] not a valid 'port'/);
      });

      it('rejects an invalid protocol', () => {
        // requireProtocol stays local (HTTP-domain-specific, not a generic Utils.assertShape shape).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper({ protocol: 'ftp' as any })).toThrow(/protocol must be 'http' or 'https'/);
      });

      it('rejects a zero or negative requestTimeout', () => {
        expect(() => new API_AUTWrapper({ requestTimeout: 0 })).toThrow(/\[requestTimeout\] not a valid 'positiveNumber'/);
        expect(() => new API_AUTWrapper({ requestTimeout: -5 })).toThrow(/\[requestTimeout\] not a valid 'positiveNumber'/);
      });

      it('rejects a non-numeric autHandlerTimeout', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper({ autHandlerTimeout: 'fast' as any })).toThrow(/\[autHandlerTimeout\] not a valid 'positiveNumber'/);
      });

      it('rejects an empty proxy string', () => {
        expect(() => new API_AUTWrapper({ proxy: '' })).toThrow(/\[proxy\] not a valid 'nonEmptyString'/);
      });

      it('create() rejects null details', async () => {
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          API_AUTWrapper.create(null as any)
        ).rejects.toThrow(/\[create\(\) details\] not a valid 'nonNullObject'/);
      });
    });

    describe('property setters', () => {

      let aut: API_AUTWrapper;

      beforeEach(() => {
        aut = new API_AUTWrapper({ appName: 'SetterTest', port: DEFAULT_PORT });
      });

      it('rejects a non-string appName', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => { aut.appName = 42 as any; }).toThrow(/\[appName\] not a valid 'nonEmptyString'/);
      });

      it('rejects a non-string host', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => { aut.host = null as any; }).toThrow(/\[host\] not a valid 'nonEmptyString'/);
      });

      it('rejects an out-of-range port', () => {
        expect(() => { aut.port = 99_999; }).toThrow(/\[port\] not a valid 'port'/);
      });

      it('rejects an invalid protocol', () => {
        // requireProtocol stays local (HTTP-domain-specific, not a generic Utils.assertShape shape).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => { aut.protocol = 'gopher' as any; }).toThrow(/protocol must be 'http' or 'https'/);
      });

      it('rejects a non-positive requestTimeout', () => {
        expect(() => { aut.requestTimeout = -1; }).toThrow(/\[requestTimeout\] not a valid 'positiveNumber'/);
      });

      it('rejects a non-positive autHandlerTimeout', () => {
        expect(() => { aut.autHandlerTimeout = 0; }).toThrow(/\[autHandlerTimeout\] not a valid 'positiveNumber'/);
      });

      it('rejects a non-string proxy', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => { aut.proxy = 42 as any; }).toThrow(/\[proxy\] not a valid 'nonEmptyString'/);
      });

      it('rejects a non-string resourcePathPreamble', () => {
        // requireString stays local — no upstream "any string, empty allowed" shape exists.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => { aut.resourcePathPreamble = 42 as any; }).toThrow(/resourcePathPreamble must be a string/);
      });

      it('identifies the failing AUT by its current appName in the error', () => {
        aut.appName = 'MyNamedAUT';
        expect(() => { aut.port = -1; }).toThrow(/\[MyNamedAUT\]/);
      });
    });

    describe('useResourcePathPreamble', () => {

      let aut: API_AUTWrapper;

      beforeEach(() => {
        aut = new API_AUTWrapper({ appName: 'PreambleTest', port: DEFAULT_PORT });
        Settings.setContext({
          sourceName: 'TestProfile',
          parameters: { testAUTDetails: { PreambleTest: { resourcePathPreambles: { V1: '/api/v1', V2: '/api/v2' } } } },
        });
        aut.loadSettings();
      });

      afterEach(() => {
        Settings.clearContext();
      });

      it('switches the effective resourcePathPreamble to the named value', () => {
        aut.useResourcePathPreamble('V1');
        expect(aut.resourcePathPreamble).toBe('/api/v1');
      });

      it('switching names replaces rather than accumulates', () => {
        aut.useResourcePathPreamble('V1');
        aut.useResourcePathPreamble('V2');
        expect(aut.resourcePathPreamble).toBe('/api/v2');
        // Switching back confirms it's genuinely recomputed fresh each time, not drifting.
        aut.useResourcePathPreamble('V1');
        expect(aut.resourcePathPreamble).toBe('/api/v1');
      });

      it('combines with a base resourcePathPreamble set directly, without accumulating on repeat switches', () => {
        aut.resourcePathPreamble = '/mounted';
        aut.useResourcePathPreamble('V1');
        expect(aut.resourcePathPreamble).toBe('/mounted/api/v1');
        aut.useResourcePathPreamble('V2');
        expect(aut.resourcePathPreamble).toBe('/mounted/api/v2');
      });

      it('throws on an unknown name, listing what is actually available', () => {
        expect(() => aut.useResourcePathPreamble('V3')).toThrow(/\[PreambleTest\].*no resourcePathPreamble named \[V3\].*available: \[V1, V2\]/);
      });

      it('throws clearly when nothing is configured at all', () => {
        const bareAut = new API_AUTWrapper({ appName: 'NoPreambles', port: DEFAULT_PORT });
        expect(() => bareAut.useResourcePathPreamble('V1')).toThrow(/\[NoPreambles\].*no resourcePathPreambles configured at all/);
      });

      it('rejects a non-string name', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => aut.useResourcePathPreamble(42 as any)).toThrow(/\[name\] not a valid 'nonEmptyString'/);
      });

      it('close() resets the effective preamble and its base, but the configured map survives a restart', async () => {
        aut.useResourcePathPreamble('V1');
        expect(aut.resourcePathPreamble).toBe('/api/v1');

        await aut.close();
        expect(aut.resourcePathPreamble).toBeUndefined();

        // The map itself is settings-resolved configuration, not session state — still
        // usable without calling loadSettings() again.
        aut.useResourcePathPreamble('V2');
        expect(aut.resourcePathPreamble).toBe('/api/v2');
      });
    });

    describe('setHeaders / mergeHeaders', () => {

      let aut: API_AUTWrapper;

      beforeEach(() => {
        aut = new API_AUTWrapper({ port: DEFAULT_PORT });
      });

      it('setHeaders rejects null', async () => {
        await expect(aut.setHeaders(null)).rejects.toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('setHeaders rejects a non-object', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(aut.setHeaders('x-header: 1' as any)).rejects.toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('setHeaders rejects an array', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(aut.setHeaders(['a', 'b'] as any)).rejects.toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('mergeHeaders rejects null', async () => {
        await expect(aut.mergeHeaders(null)).rejects.toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('does not crash logging a circular header value', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const circular: any = { a: 1 };
        circular.self = circular;
        await expect(aut.setHeaders({ weird: circular })).resolves.toBeUndefined();
        expect(aut.getHeaders()['weird']).toBe(circular);
      });
    });

    describe('request()', () => {

      let aut: API_AUTWrapper;

      beforeEach(() => {
        aut = new API_AUTWrapper({ port: DEFAULT_PORT });
        mockPerform.mockResolvedValue(makeResponse());
      });

      it('rejects a non-string method', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(aut.request(123 as any, '/')).rejects.toThrow(/\[method\] not a valid 'nonEmptyString'/);
      });

      it('rejects an empty method', async () => {
        await expect(aut.request('', '/')).rejects.toThrow(/\[method\] not a valid 'nonEmptyString'/);
      });

      it('rejects a non-string resourcePath', async () => {
        // requireString stays local — no upstream "any string, empty allowed" shape exists.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(aut.request('GET', undefined as any)).rejects.toThrow(/resourcePath must be a string/);
      });

      it('rejects explicit null options', async () => {
        await expect(aut.request('GET', '/', null)).rejects.toThrow(/\[options\] not a valid 'nonNullObject'/);
      });

      it('rejects a non-object options', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(aut.request('GET', '/', 'bad' as any)).rejects.toThrow(/\[options\] not a valid 'nonNullObject'/);
      });

      it('rejects a non-object options.headers', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(aut.request('GET', '/', { headers: 'x' as any })).rejects.toThrow(/\[options\.headers\] not a valid 'nonNullObject'/);
      });
    });
  });

  // ─── Lifecycle: raw HTTP server bootstrapper ───────────────────────────────

  describe('Lifecycle — raw HTTP server bootstrapper', () => {

    let aut: API_AUTWrapper<Server>;

    afterEach(async () => {
      await aut?.close();
    });

    it('starts a real Node.js HTTP server and reports live', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'RawApp',
        port: RAW_SERVER_PORT,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });
      expect(aut.isControlled).toBe(true);
      await expect(aut.isLive()).resolves.toBe(true);
    });

    it('autURL returns the correct URL from the real server via getUrlHandler', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'RawApp',
        port: RAW_SERVER_PORT,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });
      await expect(aut.autURL()).resolves.toBe(`http://localhost:${RAW_SERVER_PORT}`);
    });

    it('autURL throws when no getUrlHandler was provided', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'RawApp',
        port: RAW_SERVER_PORT,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
      });
      await expect(aut.autURL()).rejects.toThrow(/no getUrlHandler/);
    });

    it('closes the real server cleanly', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'RawApp',
        port: RAW_SERVER_PORT,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });
      await expect(aut.close()).resolves.not.toThrow();
      expect(aut.isControlled).toBe(false);
    });
  });

  // ─── Multiple simultaneous AUTs ────────────────────────────────────────────

  describe('Multiple simultaneous AUTs', () => {

    let aut1: API_AUTWrapper<Server>;
    let aut2: API_AUTWrapper<Server>;

    afterEach(async () => {
      await aut1?.close();
      await aut2?.close();
    });

    it('two instances run simultaneously without interfering', async () => {
      aut1 = await API_AUTWrapper.create({
        appName: 'App1',
        port: RAW_SERVER_PORT,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });
      aut2 = await API_AUTWrapper.create({
        appName: 'App2',
        port: RAW_SERVER_PORT_2,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });

      expect(aut1.isControlled).toBe(true);
      expect(aut2.isControlled).toBe(true);
      await expect(aut1.isLive()).resolves.toBe(true);
      await expect(aut2.isLive()).resolves.toBe(true);
    });

    it('closing one instance does not affect the other', async () => {
      aut1 = await API_AUTWrapper.create({
        appName: 'App1',
        port: RAW_SERVER_PORT,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });
      aut2 = await API_AUTWrapper.create({
        appName: 'App2',
        port: RAW_SERVER_PORT_2,
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });

      await aut1.close();

      expect(aut1.isControlled).toBe(false);
      expect(aut2.isControlled).toBe(true);
      await expect(aut2.isLive()).resolves.toBe(true);
    });

    it('transactions are recorded independently per instance', async () => {
      mockPerform
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeResponse(201));

      const soloAut1 = new API_AUTWrapper({ appName: 'App1', port: DEFAULT_PORT });
      const soloAut2 = new API_AUTWrapper({ appName: 'App2', port: DEFAULT_PORT + 1 });

      await soloAut1.request('GET', '/ping');
      await soloAut2.request('POST', '/items');

      expect(soloAut1.transactions).toHaveLength(1);
      expect(soloAut2.transactions).toHaveLength(1);
      expect(soloAut1.lastResponse.status).toBe(200);
      expect(soloAut2.lastResponse.status).toBe(201);
    });

    it('headers are managed independently per instance', async () => {
      const soloAut1 = new API_AUTWrapper({ appName: 'App1', port: DEFAULT_PORT });
      const soloAut2 = new API_AUTWrapper({ appName: 'App2', port: DEFAULT_PORT + 1 });

      await soloAut1.setHeaders({ Authorization: 'Bearer token-1' });
      await soloAut2.setHeaders({ Authorization: 'Bearer token-2' });

      expect(soloAut1.getHeaders()['Authorization']).toBe('Bearer token-1');
      expect(soloAut2.getHeaders()['Authorization']).toBe('Bearer token-2');
    });

    it('clearing headers on one instance does not affect the other', async () => {
      const soloAut1 = new API_AUTWrapper({ appName: 'App1', port: DEFAULT_PORT });
      const soloAut2 = new API_AUTWrapper({ appName: 'App2', port: DEFAULT_PORT + 1 });

      await soloAut1.setHeaders({ 'x-custom': 'value' });
      await soloAut2.setHeaders({ 'x-custom': 'value' });

      soloAut1.clearHeaders();

      expect(soloAut1.getHeaders()).toEqual({});
      expect(soloAut2.getHeaders()).toEqual({ 'x-custom': 'value' });
    });
  });

  // ─── Named application registry (prepareApplication / startApplication / stopApplication) ──

  describe('prepareApplication / startApplication / stopApplication', () => {

    /** Puts a settings block in place for Settings.get()'s profileParameterName resolution. */
    function setAutSettings(apps: Record<string, Record<string, unknown>>): void {
      Settings.setContext({ sourceName: 'TestProfile', parameters: { testAUTDetails: apps } });
    }

    afterEach(async () => {
      // Best-effort cleanup — most tests below stop what they start themselves, but this
      // guards against a left-over registry entry bleeding into a later test if one throws
      // before reaching its own cleanup.
      await API_AUTWrapper.stopApplication('RegistryApp').catch(() => { /* not registered — fine */ });
      await API_AUTWrapper.stopApplication('RegistryApp2').catch(() => { /* not registered — fine */ });
      await API_AUTWrapper.stopApplication('ExternalApp').catch(() => { /* not registered — fine */ });
      Settings.clearContext();
    });

    it('prepareApplication resolves config from settings but does not start the app', () => {
      setAutSettings({ RegistryApp: { port: DEFAULT_PORT } });
      const bootstrapper = makeStubBootstrapper();

      const aut = API_AUTWrapper.prepareApplication('RegistryApp', {
        bootstrapper,
        closeHandler: stubCloseHandler,
      });

      expect(aut.isControlled).toBe(false);
      expect(aut.appName).toBe('RegistryApp');
      expect(aut.port).toBe(DEFAULT_PORT);
      expect(bootstrapper).not.toHaveBeenCalled();
    });

    it('startApplication starts a previously prepared app, found by name', async () => {
      setAutSettings({ RegistryApp: { port: DEFAULT_PORT } });
      API_AUTWrapper.prepareApplication('RegistryApp', {
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });

      const aut = await API_AUTWrapper.startApplication('RegistryApp');

      expect(aut.isControlled).toBe(true);
      expect(aut.appName).toBe('RegistryApp');
    });

    it('throws clearly when starting a name that was never prepared', async () => {
      await expect(API_AUTWrapper.startApplication('NeverPrepared')).rejects.toThrow(/\[NeverPrepared\] is not prepared/);
    });

    it('stopApplication closes the registered instance but leaves it registered', async () => {
      setAutSettings({ RegistryApp: { port: DEFAULT_PORT } });
      const handle = makeStubHandle();
      API_AUTWrapper.prepareApplication('RegistryApp', {
        bootstrapper: makeStubBootstrapper({ handle }),
        closeHandler: stubCloseHandler,
      });
      await API_AUTWrapper.startApplication('RegistryApp');

      await API_AUTWrapper.stopApplication('RegistryApp');

      expect(handle.closeFn).toHaveBeenCalledTimes(1);
      // Still registered (just stopped) — restarting by name alone must work, with no
      // fresh prepareApplication() call, proving stop/start really are each other's inverse.
      const restarted = await API_AUTWrapper.startApplication('RegistryApp');
      expect(restarted.isControlled).toBe(true);
    });

    it('throws clearly when stopping a name that was never prepared', async () => {
      await expect(API_AUTWrapper.stopApplication('NeverStarted')).rejects.toThrow(/\[NeverStarted\] is not registered/);
    });

    it('starting again under the same name (without re-preparing) restarts it', async () => {
      setAutSettings({ RegistryApp: { port: DEFAULT_PORT } });
      const firstHandle = makeStubHandle();
      API_AUTWrapper.prepareApplication('RegistryApp', {
        bootstrapper: makeStubBootstrapper({ handle: firstHandle }),
        closeHandler: stubCloseHandler,
      });
      await API_AUTWrapper.startApplication('RegistryApp');

      const second = await API_AUTWrapper.startApplication('RegistryApp');

      expect(firstHandle.closeFn).toHaveBeenCalledTimes(1);
      expect(second.isControlled).toBe(true);
    });

    it('rejects re-preparing an app that is currently running', async () => {
      setAutSettings({ RegistryApp: { port: DEFAULT_PORT } });
      API_AUTWrapper.prepareApplication('RegistryApp', {
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });
      await API_AUTWrapper.startApplication('RegistryApp');

      expect(() =>
        API_AUTWrapper.prepareApplication('RegistryApp', { bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler })
      ).toThrow(/is already running/);
    });

    it('multiple differently-named apps are prepared, started, and stopped independently', async () => {
      setAutSettings({
        RegistryApp: { port: DEFAULT_PORT },
        RegistryApp2: { port: DEFAULT_PORT + 1 },
      });
      const handle1 = makeStubHandle();
      const handle2 = makeStubHandle();
      API_AUTWrapper.prepareApplication('RegistryApp', {
        bootstrapper: makeStubBootstrapper({ handle: handle1 }),
        closeHandler: stubCloseHandler,
      });
      API_AUTWrapper.prepareApplication('RegistryApp2', {
        bootstrapper: makeStubBootstrapper({ handle: handle2 }),
        closeHandler: stubCloseHandler,
      });
      await API_AUTWrapper.startApplication('RegistryApp');
      await API_AUTWrapper.startApplication('RegistryApp2');

      await API_AUTWrapper.stopApplication('RegistryApp');

      expect(handle1.closeFn).toHaveBeenCalledTimes(1);
      expect(handle2.closeFn).not.toHaveBeenCalled();

      await API_AUTWrapper.stopApplication('RegistryApp2');
      expect(handle2.closeFn).toHaveBeenCalledTimes(1);
    });

    it('rejects null handlers passed to prepareApplication', () => {
      setAutSettings({ RegistryApp: { port: DEFAULT_PORT } });
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        API_AUTWrapper.prepareApplication('RegistryApp', null as any)
      ).toThrow(/\[prepareApplication handlers\] not a valid 'nonNullObject'/);
    });

    it('rejects a non-string appName before ever checking settings', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        API_AUTWrapper.prepareApplication(42 as any, { bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler })
      ).toThrow(/\[appName\] not a valid 'nonEmptyString'/);
    });

    it('rejects a non-string appName passed to startApplication', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(API_AUTWrapper.startApplication(42 as any)).rejects.toThrow(/\[appName\] not a valid 'nonEmptyString'/);
    });

    it('rejects a non-string appName passed to stopApplication', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(API_AUTWrapper.stopApplication(42 as any)).rejects.toThrow(/\[appName\] not a valid 'nonEmptyString'/);
    });

    it('throws clearly when preparing an app with no settings configured for it', () => {
      // No Settings context at all — nothing configured anywhere for this name.
      expect(() =>
        API_AUTWrapper.prepareApplication('UnknownApp', { bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler })
      ).toThrow(/no 'port' available/);
    });

    it('actually starts and stops a real HTTP server end-to-end', async () => {
      setAutSettings({ RegistryApp: { port: RAW_SERVER_PORT } });
      API_AUTWrapper.prepareApplication('RegistryApp', {
        bootstrapper: makeRawBootstrapper(),
        closeHandler: rawCloseHandler,
        getUrlHandler: rawGetUrlHandler,
      });
      await API_AUTWrapper.startApplication('RegistryApp');

      const response = await fetch(`http://localhost:${RAW_SERVER_PORT}`);
      expect(response.status).toBe(200);

      await API_AUTWrapper.stopApplication('RegistryApp');

      await expect(fetch(`http://localhost:${RAW_SERVER_PORT}`)).rejects.toThrow();
    });

    it('assertRegistryIsEmpty passes when nothing is registered', async () => {
      await API_AUTWrapper.closeAllRegistered(); // guarantee a clean slate regardless of test order
      expect(() => API_AUTWrapper.assertRegistryIsEmpty()).not.toThrow();
    });

    it('assertRegistryIsEmpty throws, listing every still-registered name, when the registry was never cleared', () => {
      setAutSettings({ RegistryApp: { port: DEFAULT_PORT } });
      API_AUTWrapper.prepareApplication('RegistryApp', { bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler });

      expect(() => API_AUTWrapper.assertRegistryIsEmpty()).toThrow(/1 application\(s\) still registered[\s\S]*RegistryApp/);
    });

    it('prepareApplication with no bootstrapper never remembers the endpoint — assertNoKnownAUTsStillListening stays silent for it even while it is genuinely, correctly reachable', async () => {
      setAutSettings({ ExternalApp: { port: REGISTRY_CHECK_PORT } }); // host/protocol default to localhost/http — matching the real server below
      const server = await makeRawBootstrapper()(REGISTRY_CHECK_PORT); // a real listener, started independently of API_AUTWrapper — simulating an external, already-running target
      try {
        API_AUTWrapper.prepareApplication('ExternalApp', {}); // no bootstrapper at all — the external-target pattern

        await expect(API_AUTWrapper.assertNoKnownAUTsStillListening()).resolves.not.toThrow();
      } finally {
        await rawCloseHandler(server);
      }
    });

    it('prepareApplication WITH a bootstrapper still remembers the endpoint — assertNoKnownAUTsStillListening still catches a genuine leak', async () => {
      setAutSettings({ RegistryApp: { port: REGISTRY_CHECK_PORT_2 } });
      const server = await makeRawBootstrapper()(REGISTRY_CHECK_PORT_2); // simulates the previous test's teardown having failed to actually free the port
      try {
        API_AUTWrapper.prepareApplication('RegistryApp', { bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler });

        await expect(API_AUTWrapper.assertNoKnownAUTsStillListening()).rejects.toThrow(/still have something listening[\s\S]*RegistryApp/);
      } finally {
        await rawCloseHandler(server);
      }
    });
  });

  // ─── create() registration / getApplication() / closeAllRegistered() ──────────

  describe('create() registration, getApplication(), closeAllRegistered()', () => {

    afterEach(async () => {
      // Best-effort — most tests below close what they create themselves, but this
      // guards against a left-over registry entry bleeding into a later test if one
      // throws before reaching its own cleanup. getApplication() throws synchronously
      // (not a rejected promise) when a name isn't registered, hence the try/catch.
      for (const name of ['CreateRegApp', 'CreateRegApp2']) {
        try {
          await API_AUTWrapper.getApplication(name).close();
        } catch {
          // not registered — fine
        }
      }
    });

    it('create() registers the resulting instance, findable by name via getApplication()', async () => {
      const aut = await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });

      expect(API_AUTWrapper.getApplication('CreateRegApp')).toBe(aut);
    });

    it('rejects calling create() again under the same name while the first is still running', async () => {
      await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });

      await expect(
        API_AUTWrapper.create({ appName: 'CreateRegApp', port: DEFAULT_PORT, bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler })
      ).rejects.toThrow(/\[CreateRegApp\] is already running/);
    });

    it('allows calling create() again under the same name once the first has been closed', async () => {
      const first = await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });
      await first.close();

      const second = await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });

      expect(API_AUTWrapper.getApplication('CreateRegApp')).toBe(second);
    });

    it('getApplication() with no name resolves to the single registered AUT', async () => {
      const aut = await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });
      await API_AUTWrapper.closeAllRegistered(); // clear any accumulated history from earlier tests

      const recreated = await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });

      expect(API_AUTWrapper.getApplication()).toBe(recreated);
      expect(aut).not.toBe(recreated); // sanity: genuinely a fresh instance, not a stale reference
    });

    it('getApplication() with no name throws when zero AUTs are registered', async () => {
      await API_AUTWrapper.closeAllRegistered();
      expect(() => API_AUTWrapper.getApplication()).toThrow(/no AUT is currently registered/);
    });

    it('getApplication() with no name throws — ambiguous — when more than one AUT is registered', async () => {
      await API_AUTWrapper.closeAllRegistered();
      await API_AUTWrapper.create({ appName: 'CreateRegApp', port: DEFAULT_PORT, bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler });
      await API_AUTWrapper.create({ appName: 'CreateRegApp2', port: DEFAULT_PORT + 1, bootstrapper: makeStubBootstrapper(), closeHandler: stubCloseHandler });

      expect(() => API_AUTWrapper.getApplication()).toThrow(/2 AUTs are currently registered \(\[CreateRegApp, CreateRegApp2\]\)/);
    });

    it('getApplication(name) throws clearly when nothing is registered under that name', () => {
      expect(() => API_AUTWrapper.getApplication('NeverRegistered')).toThrow(/\[NeverRegistered\] is not registered/);
    });

    it('closeAllRegistered() closes every registered AUT, from both create() and prepareApplication()', async () => {
      Settings.setContext({ sourceName: 'TestProfile', parameters: { testAUTDetails: { CreateRegApp2: { port: DEFAULT_PORT + 1 } } } });
      const createdHandle = makeStubHandle();
      await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle: createdHandle }),
        closeHandler: stubCloseHandler,
      });
      const preparedHandle = makeStubHandle();
      API_AUTWrapper.prepareApplication('CreateRegApp2', {
        bootstrapper: makeStubBootstrapper({ handle: preparedHandle }),
        closeHandler: stubCloseHandler,
      });
      await API_AUTWrapper.startApplication('CreateRegApp2');
      Settings.clearContext();

      await API_AUTWrapper.closeAllRegistered();

      expect(createdHandle.closeFn).toHaveBeenCalledTimes(1);
      expect(preparedHandle.closeFn).toHaveBeenCalledTimes(1);
      expect(() => API_AUTWrapper.getApplication('CreateRegApp')).toThrow(/is not registered/);
      expect(() => API_AUTWrapper.getApplication('CreateRegApp2')).toThrow(/is not registered/);
    });

    it('closeAllRegistered() clears the registry even when a close() call throws, and reports every failure', async () => {
      Settings.setContext({ sourceName: 'TestProfile', parameters: { testAUTDetails: { CreateRegApp2: { port: DEFAULT_PORT + 1 } } } });
      await API_AUTWrapper.create({
        appName: 'CreateRegApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle: makeStubHandle({ closeShouldFail: true }) }),
        closeHandler: stubCloseHandler,
      });
      API_AUTWrapper.prepareApplication('CreateRegApp2', {
        bootstrapper: makeStubBootstrapper({ handle: makeStubHandle({ closeShouldFail: true }) }),
        closeHandler: stubCloseHandler,
      });
      await API_AUTWrapper.startApplication('CreateRegApp2');
      Settings.clearContext();

      await expect(API_AUTWrapper.closeAllRegistered()).rejects.toThrow(/failed to close 2 AUT\(s\)/);
      // Registry is still cleared despite the failures — next test (or scenario) starts clean.
      expect(() => API_AUTWrapper.getApplication('CreateRegApp')).toThrow(/is not registered/);
      expect(() => API_AUTWrapper.getApplication('CreateRegApp2')).toThrow(/is not registered/);
    });
  });

  // ─── loadSettings() ─────────────────────────────────────────────────────────

  describe('loadSettings()', () => {

    const SETTINGS_PORT   = 15000;
    const SETTINGS_PORT_2 = 15001;

    /** Puts a settings block in place for Settings.get()'s profileParameterName resolution. */
    function setAutSettings(prefixKey: string, apps: Record<string, Record<string, unknown>>): void {
      Settings.setContext({ sourceName: 'TestProfile', parameters: { [prefixKey]: apps } });
    }

    afterEach(() => {
      Settings.clearContext();
      delete process.env.CONTROLIUM_AUT_SETTINGS_PREFIX;
    });

    it('throws if no port is available from settings or already set', () => {
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });
      expect(() => aut.loadSettings()).toThrow(/\[SettingsApp\] no 'port' available/);
    });

    it('does not require settings at all if port is already set directly', () => {
      const aut = new API_AUTWrapper({ appName: 'SettingsApp', port: SETTINGS_PORT });
      expect(() => aut.loadSettings()).not.toThrow();
      expect(aut.port).toBe(SETTINGS_PORT); // untouched — nothing configured to override it
    });

    it('resolves and applies every settings-driven field', () => {
      setAutSettings('testAUTDetails', {
        SettingsApp: {
          port: SETTINGS_PORT,
          host: 'localhost',
          protocol: 'https',
          requestTimeout: 9000,
          proxy: 'http://proxy:8080',
          autHandlerTimeout: 8000,
          resourcePathPreamble: '/api/v3',
        },
      });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

      aut.loadSettings();

      expect(aut.port).toBe(SETTINGS_PORT);
      expect(aut.host).toBe('localhost');
      expect(aut.protocol).toBe('https');
      expect(aut.requestTimeout).toBe(9000);
      expect(aut.proxy).toBe('http://proxy:8080');
      expect(aut.autHandlerTimeout).toBe(8000);
      expect(aut.resourcePathPreamble).toBe('/api/v3');
    });

    it('coerces string port/requestTimeout/autHandlerTimeout values (as an env var would produce) to numbers', () => {
      setAutSettings('testAUTDetails', {
        SettingsApp: { port: String(SETTINGS_PORT), requestTimeout: '7000', autHandlerTimeout: '6000' },
      });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

      aut.loadSettings();

      expect(aut.port).toBe(SETTINGS_PORT);
      expect(aut.requestTimeout).toBe(7000);
      expect(aut.autHandlerTimeout).toBe(6000);
    });

    it('rejects a port that resolves to something non-numeric', () => {
      setAutSettings('testAUTDetails', { SettingsApp: { port: 'not-a-port' } });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });
      expect(() => aut.loadSettings()).toThrow(/\[port\] not a valid 'port'/);
    });

    it('leaves unconfigured optional fields at their current/default value', () => {
      setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT } });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

      aut.loadSettings();

      expect(aut.host).toBe('localhost');
      expect(aut.protocol).toBe('http');
      expect(aut.requestTimeout).toBe(30_000);
    });

    it('resolves every settings-driven field with notFoundIsExpected — leaving unconfigured fields unset is never treated as an error by Utils.getSetting', () => {
      setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT } });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });
      const getSettingSpy = vi.spyOn(Settings, 'get');

      aut.loadSettings();

      // Only the per-field calls _resolveAndLogSetting makes (profileParameterName under
      // this app's own testAUTDetails base) — excludes the unrelated settings-prefix
      // resolution (CONTROLIUM_AUT_SETTINGS_PREFIX), which has no profileParameterName at all.
      const perFieldCalls = getSettingSpy.mock.calls
        .map(([, , sources]) => sources as { profileParameterName?: string; notFoundIsExpected?: boolean })
        .filter((sources) => sources.profileParameterName?.includes('.SettingsApp.'));
      expect(perFieldCalls.length).toBeGreaterThan(0);
      for (const sources of perFieldCalls) {
        expect(sources.notFoundIsExpected).toBe(true);
      }

      getSettingSpy.mockRestore();
    });

    it('logs one explicit summary — spread over multiple lines, one field per line — with the effective configuration', () => {
      setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT, protocol: 'https' } });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

      aut.loadSettings();

      const summaryCall = [...vi.mocked(Log.writeLine).mock.calls].reverse().find(([, message]) => (message as string).includes('[SettingsApp] configuration:'));
      expect(summaryCall).toBeDefined();
      const [, message, options] = summaryCall as [unknown, string, { suppressMultilinePreamble?: boolean } | undefined];
      expect(message).toContain(`port: ${SETTINGS_PORT}`);
      expect(message).toContain('protocol: https');
      expect(message).toContain('host: localhost');
      expect(options).toEqual(expect.objectContaining({ suppressMultilinePreamble: true }));
    });

    it('the per-field trail (resolved and not-configured alike) always logs at TestDebug, regardless of logLevel — quieter than the headline summary, not tunable per-call', () => {
      setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT, protocol: 'https' } });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

      aut.loadSettings(LogLevels.Error); // even an unrelated logLevel override doesn't move these

      const calls = [...vi.mocked(Log.writeLine).mock.calls].reverse();
      const resolvedLine = calls.find(([, message]) => (message as string).includes("setting 'protocol' = https"));
      const notConfiguredLine = calls.find(([, message]) => (message as string).includes("setting 'host' not configured"));
      expect(resolvedLine?.[0]).toBe(LogLevels.TestDebug);
      expect(notConfiguredLine?.[0]).toBe(LogLevels.TestDebug);
    });

    it('a caller-supplied logLevel only moves the headline summary line, not the per-field trail', () => {
      setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT, protocol: 'https' } });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

      aut.loadSettings(LogLevels.FrameworkDebug);

      const calls = [...vi.mocked(Log.writeLine).mock.calls].reverse();
      const summaryLine = calls.find(([, message]) => (message as string).includes('[SettingsApp] configuration:'));
      expect(summaryLine?.[0]).toBe(LogLevels.FrameworkDebug);
    });

    it('uses a configurable settings prefix via env var instead of the testAUTDetails default', () => {
      process.env.CONTROLIUM_AUT_SETTINGS_PREFIX = 'myCustomPrefix';
      setAutSettings('myCustomPrefix', { SettingsApp: { port: SETTINGS_PORT_2 } });
      const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

      aut.loadSettings();

      expect(aut.port).toBe(SETTINGS_PORT_2);
    });

    describe('host/port/protocol while already running', () => {

      let aut: API_AUTWrapper<StubHandle>;

      afterEach(async () => {
        await aut?.close();
      });

      it('re-resolving the same value while running is a harmless no-op', async () => {
        setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT } });
        aut = await API_AUTWrapper.create({
          appName: 'SettingsApp',
          port: SETTINGS_PORT,
          bootstrapper: makeStubBootstrapper(),
          closeHandler: stubCloseHandler,
        });

        expect(() => aut.loadSettings()).not.toThrow();
        expect(aut.port).toBe(SETTINGS_PORT);
      });

      it('throws if the resolved port genuinely differs while running', async () => {
        aut = await API_AUTWrapper.create({
          appName: 'SettingsApp',
          port: SETTINGS_PORT,
          bootstrapper: makeStubBootstrapper(),
          closeHandler: stubCloseHandler,
        });
        setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT_2 } });

        expect(() => aut.loadSettings()).toThrow(/cannot change 'port' while running/);
      });

      it('still freely reloads requestTimeout/proxy/autHandlerTimeout/resourcePathPreamble while running', async () => {
        aut = await API_AUTWrapper.create({
          appName: 'SettingsApp',
          port: SETTINGS_PORT,
          bootstrapper: makeStubBootstrapper(),
          closeHandler: stubCloseHandler,
        });
        setAutSettings('testAUTDetails', {
          SettingsApp: { port: SETTINGS_PORT, requestTimeout: 1234, proxy: 'http://newproxy:9090', resourcePathPreamble: '/v9' },
        });

        expect(() => aut.loadSettings()).not.toThrow();
        expect(aut.requestTimeout).toBe(1234);
        expect(aut.proxy).toBe('http://newproxy:9090');
        expect(aut.resourcePathPreamble).toBe('/v9');
      });
    });

    describe('dotEnvPath', () => {

      let tmpDir: string;
      let envFile: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(path.join(os.tmpdir(), 'controlium-dotenv-test-'));
        envFile = path.join(tmpDir, '.env');
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.DOTENV_TEST_VAR;
      });

      it('loads a configured .env file into process.env', () => {
        writeFileSync(envFile, 'DOTENV_TEST_VAR=hello-from-dotenv\n');
        setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT, dotEnvPath: envFile } });
        const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

        aut.loadSettings();

        expect(process.env.DOTENV_TEST_VAR).toBe('hello-from-dotenv');
      });

      it('overrides an already-set process.env value (override: true)', () => {
        process.env.DOTENV_TEST_VAR = 'pre-existing';
        writeFileSync(envFile, 'DOTENV_TEST_VAR=overridden\n');
        setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT, dotEnvPath: envFile } });
        const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

        aut.loadSettings();

        expect(process.env.DOTENV_TEST_VAR).toBe('overridden');
      });

      it('throws if the configured dotEnvPath does not exist', () => {
        setAutSettings('testAUTDetails', {
          SettingsApp: { port: SETTINGS_PORT, dotEnvPath: path.join(tmpDir, 'does-not-exist.env') },
        });
        const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

        expect(() => aut.loadSettings()).toThrow(/does not exist/);
      });

      it('does nothing dotenv-related if dotEnvPath is not configured', () => {
        setAutSettings('testAUTDetails', { SettingsApp: { port: SETTINGS_PORT } });
        const aut = new API_AUTWrapper({ appName: 'SettingsApp' });

        expect(() => aut.loadSettings()).not.toThrow();
      });
    });
  });

  // ─── isLive / autURL edge cases ────────────────────────────────────────────

  describe('isLive / autURL', () => {

    let aut: API_AUTWrapper<StubHandle>;

    afterEach(async () => {
      await aut?.close();
    });

    it('isLive returns false when AUT has not been started', async () => {
      aut = new API_AUTWrapper();
      await expect(aut.isLive()).resolves.toBe(false);
    });

    it('isLive returns false when getUrlHandler returns empty string', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle: makeStubHandle({ getUrlResult: '' }) }),
        closeHandler: stubCloseHandler,
        getUrlHandler: stubGetUrlHandler,
      });
      await expect(aut.isLive()).resolves.toBe(false);
    });

    it('isLive returns false when getUrlHandler throws', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle: makeStubHandle({ getUrlShouldFail: true }) }),
        closeHandler: stubCloseHandler,
        getUrlHandler: stubGetUrlHandler,
      });
      await expect(aut.isLive()).resolves.toBe(false);
    });

    it('autURL throws when AUT has not been started', async () => {
      aut = new API_AUTWrapper();
      await expect(aut.autURL()).rejects.toThrow(/is not running/);
    });

    it('autURL propagates getUrlHandler errors', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle: makeStubHandle({ getUrlShouldFail: true }) }),
        closeHandler: stubCloseHandler,
        getUrlHandler: stubGetUrlHandler,
      });
      await expect(aut.autURL()).rejects.toThrow(/getUrlHandler threw/);
    });

    it('autURL propagates a non-Error getUrlHandler failure without masking it', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
        getUrlHandler: () => Promise.reject(undefined),
      });
      await expect(aut.autURL()).rejects.toBeDefined();
    });

    it('getUrlHandler receives the exact handle the bootstrapper returned', async () => {
      const handle = makeStubHandle();
      const receivedHandles: StubHandle[] = [];
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper({ handle }),
        closeHandler: stubCloseHandler,
        getUrlHandler: (h) => { receivedHandles.push(h); return stubGetUrlHandler(h); },
      });
      // _startAUT's own post-start diagnostic also calls getUrlHandler once, internally —
      // clear that out so this test is isolated to the explicit call below.
      receivedHandles.length = 0;
      await aut.autURL();
      expect(receivedHandles).toEqual([handle]);
    });
  });

  describe('post-start diagnostic (live state log line)', () => {
    let aut: API_AUTWrapper<StubHandle>;

    afterEach(async () => {
      await aut?.close();
    });

    it('logs the resolved URL, isControlled, and current headers at TestDebug', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
        getUrlHandler: stubGetUrlHandler,
      });
      await aut.setHeaders({ Authorization: 'Bearer abc' });
      // Restart to pick up the headers already set, into the diagnostic's own next run.
      await API_AUTWrapper.startApplication('TestApp');

      expect(Log.writeLine).toHaveBeenCalledWith(
        LogLevels.TestDebug,
        expect.stringMatching(/live state:[\s\S]*url: http:\/\/localhost:\d+[\s\S]*isControlled: true[\s\S]*headers:.*Authorization/),
        { suppressMultilinePreamble: true }
      );
    });

    it('falls back to "<unavailable: ...>" for the URL when no getUrlHandler was provided, rather than failing startup', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
      });

      expect(Log.writeLine).toHaveBeenCalledWith(
        LogLevels.TestDebug,
        expect.stringMatching(/url: <unavailable:/),
        { suppressMultilinePreamble: true }
      );
    });

    it('reports headers as "<none>" when none have been set', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: stubCloseHandler,
        getUrlHandler: stubGetUrlHandler,
      });

      expect(Log.writeLine).toHaveBeenCalledWith(
        LogLevels.TestDebug,
        expect.stringMatching(/headers: <none>/),
        { suppressMultilinePreamble: true }
      );
    });
  });

  // ─── Header management ─────────────────────────────────────────────────────

  describe('Header management', () => {

    let aut: API_AUTWrapper;

    beforeEach(() => {
      aut = new API_AUTWrapper({ port: DEFAULT_PORT });
    });

    it('setHeaders replaces all existing headers', async () => {
      await aut.mergeHeaders({ existing: 'old' });
      await aut.setHeaders({ 'x-new': 'header' });
      expect(aut.getHeaders()).toEqual({ 'x-new': 'header' });
    });

    it('mergeHeaders adds to existing headers', async () => {
      await aut.setHeaders({ a: '1' });
      await aut.mergeHeaders({ b: '2' });
      expect(aut.getHeaders()).toEqual({ a: '1', b: '2' });
    });

    it('mergeHeaders overwrites matching keys', async () => {
      await aut.setHeaders({ token: 'old' });
      await aut.mergeHeaders({ token: 'new' });
      expect(aut.getHeaders()['token']).toBe('new');
    });

    // Per JsonUtils.resolveSentinels — the one textual convention for expressing "remove
    // this header"/"a real null" from a source (JSON literal, file, DataTable) that can
    // only ever produce plain strings.
    describe('_undefined / _null sentinels', () => {

      it('setHeaders omits a header whose value is the _undefined sentinel', async () => {
        await aut.setHeaders({ Authorization: '_undefined', 'x-kept': 'abc' });
        expect(aut.getHeaders()).toEqual({ 'x-kept': 'abc' });
      });

      it('setHeaders sets a header to a real null for the _null sentinel', async () => {
        await aut.setHeaders({ 'x-trace': '_null' });
        expect(aut.getHeaders()['x-trace']).toBeNull();
      });

      it('mergeHeaders resolves sentinels against the merged result, removing a header set by an earlier call', async () => {
        await aut.setHeaders({ Authorization: 'Bearer old', 'x-kept': 'abc' });
        await aut.mergeHeaders({ Authorization: '_undefined' });
        expect(aut.getHeaders()).toEqual({ 'x-kept': 'abc' });
      });

      it('mergeHeaders sets a real null for a header set by an earlier call', async () => {
        await aut.setHeaders({ 'x-trace': 'abc' });
        await aut.mergeHeaders({ 'x-trace': '_null' });
        expect(aut.getHeaders()['x-trace']).toBeNull();
      });

      it('a token that resolves to the _undefined sentinel is recognised — detokenisation happens before sentinel resolution', async () => {
        process.env.API_AUTWRAPPER_SPEC_HEADER_SENTINEL_TEST = '_undefined';
        try {
          await aut.setHeaders({
            'X-Beta': '[[setting|processEnvName: "API_AUTWRAPPER_SPEC_HEADER_SENTINEL_TEST"]]',
            'x-kept': 'abc',
          });
          expect(aut.getHeaders()).toEqual({ 'x-kept': 'abc' });
        } finally {
          delete process.env.API_AUTWRAPPER_SPEC_HEADER_SENTINEL_TEST;
        }
      });
    });

    it('clearHeaders empties the header set', async () => {
      await aut.setHeaders({ a: '1' });
      aut.clearHeaders();
      expect(aut.getHeaders()).toEqual({});
    });

    it('getHeaders returns a copy — external mutations do not affect wrapper state', async () => {
      await aut.setHeaders({ a: '1' });
      const copy = aut.getHeaders();
      copy['b'] = '2';
      expect(aut.getHeaders()).toEqual({ a: '1' });
    });

    it('close clears headers', async () => {
      await aut.setHeaders({ a: '1' });
      await aut.close();
      expect(aut.getHeaders()).toEqual({});
    });
  });

  // ─── Transaction recording ─────────────────────────────────────────────────

  describe('Transaction recording', () => {

    let aut: API_AUTWrapper;

    beforeEach(() => {
      aut = new API_AUTWrapper({ port: DEFAULT_PORT });
    });

    it('transactions is empty before any requests', () => {
      expect(aut.transactions).toHaveLength(0);
    });

    it('lastTransaction throws when no transactions recorded', () => {
      expect(() => aut.lastTransaction).toThrow(/No HTTP transactions/);
    });

    it('lastResponse throws when no transactions recorded', () => {
      expect(() => aut.lastResponse).toThrow(/No HTTP transactions/);
    });

    it('clearTransactions empties the transaction list', async () => {
      mockPerform.mockResolvedValue(makeResponse());
      await aut.request('GET', '/test');
      aut.clearTransactions();
      expect(aut.transactions).toHaveLength(0);
    });

    it('close clears transactions', async () => {
      mockPerform.mockResolvedValue(makeResponse());
      await aut.request('GET', '/test');
      await aut.close();
      expect(aut.transactions).toHaveLength(0);
    });
  });

  // ─── request() ─────────────────────────────────────────────────────────────

  describe('request()', () => {

    let aut: API_AUTWrapper;

    beforeEach(() => {
      aut = new API_AUTWrapper({ port: DEFAULT_PORT });
      mockPerform.mockResolvedValue(makeResponse());
    });

    afterEach(() => {
      // Static/global, not per-instance — a test staging one and not consuming it (or this
      // describe block's own afterTest-less unit tests) must not leak into a later test in
      // this same file. Real per-test isolation is afterTest()'s job (see lifecycle.spec.ts);
      // this is just hygiene within this spec file's own test run.
      API_AUTWrapper.clearNextRequestHeaders();
    });

    it('throws immediately when port is not set', async () => {
      const noPort = new API_AUTWrapper();
      await expect(noPort.request('GET', '/test')).rejects.toThrow(/port is not set/);
    });

    it('passes correct HTTP method to performHTTPOperation', async () => {
      await aut.request('DELETE', '/items/1');
      const [req] = mockPerform.mock.calls[0];
      expect(req.method).toBe('DELETE');
    });

    it('passes correct resource path to performHTTPOperation', async () => {
      await aut.request('GET', '/api/users');
      const [req] = mockPerform.mock.calls[0];
      expect(req.resourcePath).toBe('/api/users');
    });

    it('builds host string from wrapper host and port', async () => {
      await aut.request('GET', '/');
      const [req] = mockPerform.mock.calls[0];
      expect(req.host).toBe(`localhost:${DEFAULT_PORT}`);
    });

    it('passes protocol, proxy and requestTimeout to the HTTP request', async () => {
      aut.protocol = 'https';
      aut.proxy    = 'http://proxy:8080';
      aut.requestTimeout  = 5_000;
      await aut.request('GET', '/');
      const [req] = mockPerform.mock.calls[0];
      expect(req.protocol).toBe('https');
      expect(req.proxy).toBe('http://proxy:8080');
      // `req.timeout` — not `req.requestTimeout` — is correct here: this is the outgoing
      // APIUtils.HTTPRequest's own field name, an external contract unrelated to this
      // class's own requestTimeout rename.
      expect(req.timeout).toBe(5_000);
    });

    it('passes queryString to the HTTP request', async () => {
      await aut.request('GET', '/search', { queryString: 'q=test&page=2' });
      const [req] = mockPerform.mock.calls[0];
      expect(req.queryString).toBe('q=test&page=2');
    });

    it('queryString is undefined when not given', async () => {
      await aut.request('GET', '/search');
      const [req] = mockPerform.mock.calls[0];
      expect(req.queryString).toBeUndefined();
    });

    it('per-request requestTimeout overrides the session-level requestTimeout for that call only', async () => {
      aut.requestTimeout = 5_000;
      await aut.request('GET', '/', { requestTimeout: 500 });
      expect(mockPerform.mock.calls[0][0].timeout).toBe(500);
      await aut.request('GET', '/');
      expect(mockPerform.mock.calls[1][0].timeout).toBe(5_000);
    });

    it('per-request proxy overrides the session-level proxy for that call only', async () => {
      aut.proxy = 'http://session-proxy:8080';
      await aut.request('GET', '/', { proxy: 'http://per-call-proxy:9090' });
      expect(mockPerform.mock.calls[0][0].proxy).toBe('http://per-call-proxy:9090');
      await aut.request('GET', '/');
      expect(mockPerform.mock.calls[1][0].proxy).toBe('http://session-proxy:8080');
    });

    it('rejects a non-string queryString', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(aut.request('GET', '/', { queryString: 42 as any })).rejects.toThrow(/options\.queryString must be a string/);
    });

    it('rejects a non-positive per-request requestTimeout', async () => {
      await expect(aut.request('GET', '/', { requestTimeout: 0 })).rejects.toThrow(/\[options\.requestTimeout\] not a valid 'positiveNumber'/);
    });

    it('rejects an empty per-request proxy', async () => {
      await expect(aut.request('GET', '/', { proxy: '' })).rejects.toThrow(/\[options\.proxy\] not a valid 'nonEmptyString'/);
    });

    it('prepends resourcePathPreamble to the path', async () => {
      aut.resourcePathPreamble = '/api/v2';
      await aut.request('GET', '/users');
      const [req] = mockPerform.mock.calls[0];
      expect(req.resourcePath).toBe('/api/v2/users');
    });

    it('merges session headers into the request', async () => {
      await aut.setHeaders({ 'x-session': 'abc' });
      await aut.request('GET', '/');
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['x-session']).toBe('abc');
    });

    it('merges per-request headers on top of session headers', async () => {
      await aut.setHeaders({ 'x-session': 'abc' });
      await aut.request('GET', '/', { headers: { 'x-request': 'xyz' } });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['x-session']).toBe('abc');
      expect(req.headers['x-request']).toBe('xyz');
    });

    it('per-request headers override session headers for matching keys', async () => {
      await aut.setHeaders({ 'x-token': 'session' });
      await aut.request('GET', '/', { headers: { 'x-token': 'request' } });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['x-token']).toBe('request');
    });

    it('a null per-request header suppresses a session header for that request only', async () => {
      await aut.setHeaders({ Authorization: 'Bearer token' });
      await aut.request('GET', '/', { headers: { Authorization: null } });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Authorization']).toBeNull();
      // Session header is untouched for the next request.
      await aut.request('GET', '/');
      const [req2] = mockPerform.mock.calls[1];
      expect(req2.headers['Authorization']).toBe('Bearer token');
    });

    // One-shot "next request" header override — genuinely global static state, not scoped
    // to this instance (see API_AUTWrapper.setNextRequestHeaders's own doc comment).
    describe('setNextRequestHeaders / mergeNextRequestHeaders', () => {

      it('setNextRequestHeaders replaces session headers entirely for the next request only', async () => {
        await aut.setHeaders({ Authorization: 'Bearer session-token', 'x-session-only': 'yes' });
        API_AUTWrapper.setNextRequestHeaders({ Authorization: 'Bearer corrupt-token' });

        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers).toEqual({ Authorization: 'Bearer corrupt-token' });

        // Reverted for the request after.
        await aut.request('GET', '/');
        const [req2] = mockPerform.mock.calls[1];
        expect(req2.headers).toEqual({ Authorization: 'Bearer session-token', 'x-session-only': 'yes' });
      });

      it('mergeNextRequestHeaders merges onto session headers for the next request only', async () => {
        await aut.setHeaders({ Authorization: 'Bearer session-token', 'x-session-only': 'yes' });
        API_AUTWrapper.mergeNextRequestHeaders({ Authorization: 'Bearer override-token' });

        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers).toEqual({ Authorization: 'Bearer override-token', 'x-session-only': 'yes' });

        await aut.request('GET', '/');
        const [req2] = mockPerform.mock.calls[1];
        expect(req2.headers).toEqual({ Authorization: 'Bearer session-token', 'x-session-only': 'yes' });
      });

      it('is consumed by whichever AUT instance requests next, not scoped to the instance that staged it', async () => {
        const other = new API_AUTWrapper({ appName: 'OtherAUT', port: DEFAULT_PORT + 5 });
        API_AUTWrapper.setNextRequestHeaders({ 'x-override': 'applies-anywhere' });

        await other.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers).toEqual({ 'x-override': 'applies-anywhere' });

        // And it's gone now — a second AUT's very next request sees nothing staged.
        await aut.request('GET', '/');
        const [req2] = mockPerform.mock.calls[1];
        expect(req2.headers).toEqual({});
      });

      it('per-request options.headers still wins on top of a next-request override', async () => {
        API_AUTWrapper.setNextRequestHeaders({ 'x-override': 'from-override' });
        await aut.request('GET', '/', { headers: { 'x-override': 'from-per-call-options' } });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['x-override']).toBe('from-per-call-options');
      });

      it('resolves sentinels on the override, including a token that resolves to one', async () => {
        process.env.API_AUTWRAPPER_SPEC_NEXT_REQ_SENTINEL = '_undefined';
        try {
          await aut.setHeaders({ Authorization: 'Bearer session-token' });
          API_AUTWrapper.mergeNextRequestHeaders({
            Authorization: '[[setting|processEnvName: "API_AUTWRAPPER_SPEC_NEXT_REQ_SENTINEL"]]',
          });

          await aut.request('GET', '/');
          const [req] = mockPerform.mock.calls[0];
          expect(req.headers).toEqual({});
        } finally {
          delete process.env.API_AUTWRAPPER_SPEC_NEXT_REQ_SENTINEL;
        }
      });

      it('clearNextRequestHeaders discards a staged override before it is ever used', async () => {
        await aut.setHeaders({ Authorization: 'Bearer session-token' });
        API_AUTWrapper.setNextRequestHeaders({ Authorization: 'Bearer should-never-be-sent' });

        API_AUTWrapper.clearNextRequestHeaders();

        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers).toEqual({ Authorization: 'Bearer session-token' });
      });

      it('is still cleared (not left pending) even when the request that consumes it throws', async () => {
        mockPerform.mockRejectedValueOnce(new Error('network exploded'));
        API_AUTWrapper.setNextRequestHeaders({ Authorization: 'Bearer corrupt-token' });

        await aut.request('GET', '/'); // request() itself does not throw — error lands on lastTransaction
        expect(aut.lastTransaction.error).toBeDefined();

        // Gone regardless of that failure — the next request sees plain session headers.
        mockPerform.mockResolvedValueOnce(makeResponse());
        await aut.setHeaders({ Authorization: 'Bearer session-token' });
        await aut.request('GET', '/');
        const [, req2] = mockPerform.mock.calls;
        expect(req2[0].headers).toEqual({ Authorization: 'Bearer session-token' });
      });

      it('rejects a null override', () => {
        expect(() => API_AUTWrapper.setNextRequestHeaders(null)).toThrow(/\[headers\] not a valid 'nonNullObject'/);
        expect(() => API_AUTWrapper.mergeNextRequestHeaders(null)).toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });
    });

    describe('Query params', () => {

      it('setQueryParams/mergeQueryParams reject null', async () => {
        await expect(aut.setQueryParams(null)).rejects.toThrow(/\[queryParams\] not a valid 'nonNullObject'/);
        await expect(aut.mergeQueryParams(null)).rejects.toThrow(/\[queryParams\] not a valid 'nonNullObject'/);
      });

      it('getQueryParams reflects what was set, and clearQueryParams empties it', async () => {
        await aut.setQueryParams({ a: '1' });
        expect(aut.getQueryParams()).toEqual({ a: '1' });
        aut.clearQueryParams();
        expect(aut.getQueryParams()).toEqual({});
      });

      it('mergeQueryParams combines onto whatever was already set, overwriting matching keys', async () => {
        await aut.setQueryParams({ a: '1', b: '2' });
        await aut.mergeQueryParams({ b: '3', c: '4' });
        expect(aut.getQueryParams()).toEqual({ a: '1', b: '3', c: '4' });
      });

      it('session-level query params appear on the request', async () => {
        await aut.setQueryParams({ a: '1' });
        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.queryString).toBe('a=1');
      });

      it('a string[] session query param sends a genuine repeated key', async () => {
        await aut.setQueryParams({ tag: ['x', 'y'] });
        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.queryString).toBe('tag=x&tag=y');
      });

      it('a null session query param omits that key', async () => {
        await aut.setQueryParams({ a: '1', b: null });
        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.queryString).toBe('a=1');
      });

      it('session query params and options.queryString are merged, never one overriding the other — a shared key survives as a duplicate', async () => {
        await aut.setQueryParams({ a: '1' });
        await aut.request('GET', '/', { queryString: 'a=2&b=3' });
        const [req] = mockPerform.mock.calls[0];
        expect(req.queryString).toBe('a=1&a=2&b=3');
      });

      it('a query string embedded directly in resourcePath is passed through unchanged — merging it with session/options query happens lower down, in APIUtils.buildURL (see its own tests)', async () => {
        await aut.setQueryParams({ b: '2' });
        await aut.request('GET', '/users?a=1');
        const [req] = mockPerform.mock.calls[0];
        // performRawHTTPOperation is mocked here, so buildURL itself never runs — this
        // confirms request() hands resourcePath's own "?a=1" through untouched, and its own
        // queryString field carries only the session-resolved part, ready for buildURL to
        // combine the two once the real send path runs.
        expect(req.resourcePath).toBe('/users?a=1');
        expect(req.queryString).toBe('b=2');
      });

      it('detokenises session query params', async () => {
        await aut.setQueryParams({ q: '[[random|digits|4]]' });
        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.queryString).toMatch(/^q=\d{4}$/);
      });

      describe('setNextRequestQueryParams / mergeNextRequestQueryParams', () => {

        it('setNextRequestQueryParams replaces session query params entirely for the next request only', async () => {
          await aut.setQueryParams({ a: '1', b: '2' });
          API_AUTWrapper.setNextRequestQueryParams({ a: '99' });

          await aut.request('GET', '/');
          const [req] = mockPerform.mock.calls[0];
          expect(req.queryString).toBe('a=99');

          // Session query params are untouched for the next request — one-shot, consumed.
          await aut.request('GET', '/');
          const [req2] = mockPerform.mock.calls[1];
          expect(req2.queryString).toBe('a=1&b=2');
        });

        it('mergeNextRequestQueryParams merges onto session query params for the next request only', async () => {
          await aut.setQueryParams({ a: '1', b: '2' });
          API_AUTWrapper.mergeNextRequestQueryParams({ b: '99' });

          await aut.request('GET', '/');
          const [req] = mockPerform.mock.calls[0];
          expect(req.queryString).toBe('a=1&b=99');
        });

        it('clearNextRequestQueryParams discards a staged override without applying it', async () => {
          await aut.setQueryParams({ a: '1' });
          API_AUTWrapper.setNextRequestQueryParams({ a: '99' });
          API_AUTWrapper.clearNextRequestQueryParams();

          await aut.request('GET', '/');
          const [req] = mockPerform.mock.calls[0];
          expect(req.queryString).toBe('a=1');
        });

        it('rejects a null override', () => {
          expect(() => API_AUTWrapper.setNextRequestQueryParams(null)).toThrow(/\[queryParams\] not a valid 'nonNullObject'/);
          expect(() => API_AUTWrapper.mergeNextRequestQueryParams(null)).toThrow(/\[queryParams\] not a valid 'nonNullObject'/);
        });
      });
    });

    it('infers Content-Type: application/json for an object body', async () => {
      await aut.request('POST', '/', { body: { foo: 'bar' } });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Content-Type']).toBe('application/json');
    });

    it('infers Content-Type: application/json for a JSON string body', async () => {
      await aut.request('POST', '/', { body: '{"foo":"bar"}' });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Content-Type']).toBe('application/json');
    });

    it('infers Content-Type: application/json for a JSON array string body', async () => {
      await aut.request('POST', '/', { body: '[1,2,3]' });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Content-Type']).toBe('application/json');
    });

    it('does not override an explicit Content-Type when body is JSON', async () => {
      await aut.request('POST', '/', {
        headers: { 'Content-Type': 'text/plain' },
        body: { foo: 'bar' },
      });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Content-Type']).toBe('text/plain');
    });

    it('does not override an explicit null Content-Type when body is JSON', async () => {
      await aut.request('POST', '/', {
        headers: { 'Content-Type': null },
        body: { foo: 'bar' },
      });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Content-Type']).toBeNull();
    });

    it('does not set Content-Type for a plain-text string body', async () => {
      await aut.request('POST', '/', { body: 'plain text' });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Content-Type']).toBeUndefined();
    });

    it('does not set Content-Type for a malformed JSON-looking string body', async () => {
      await aut.request('POST', '/', { body: '{not valid json' });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Content-Type']).toBeUndefined();
    });

    describe('Buffer body', () => {

      it('is sent through untouched, byte-exact', async () => {
        const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
        await aut.request('POST', '/', { body: buffer });
        const [req] = mockPerform.mock.calls[0];
        expect(req.body).toBe(buffer);
      });

      it('does not set Content-Type — JSON.stringify(aBuffer) always "succeeds", which would otherwise false-positive as JSON', async () => {
        // A Buffer, run through the old (pre-fix) isJson check unconditionally, would
        // JSON.stringify to {"type":"Buffer","data":[...]} and parse straight back as
        // "valid JSON" — this is the regression this test guards against.
        const buffer = Buffer.from('not json at all, just bytes');
        await aut.request('POST', '/', { body: buffer });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['Content-Type']).toBeUndefined();
      });

      it('an explicit contentType is still honoured for a Buffer body', async () => {
        const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        await aut.request('POST', '/', { body: buffer, contentType: 'image/png' });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['Content-Type']).toBe('image/png');
      });

      it('is never detokenised — binary bytes are never token-bearing', async () => {
        const buffer = Buffer.from('[[random|digits|6]]');
        await aut.request('POST', '/', { body: buffer });
        const [req] = mockPerform.mock.calls[0];
        expect(req.body).toBe(buffer);
        expect((req.body as Buffer).toString()).toBe('[[random|digits|6]]');
      });
    });

    describe('options.contentType', () => {

      it('sets Content-Type when none is already present', async () => {
        await aut.request('POST', '/', { body: '<a>1</a>', contentType: 'application/xml' });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['Content-Type']).toBe('application/xml');
      });

      it('takes priority over the JSON-sniffing fallback, even for a JSON-looking body', async () => {
        await aut.request('POST', '/', { body: '{"foo":"bar"}', contentType: 'application/yaml' });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['Content-Type']).toBe('application/yaml');
      });

      it('does not override an explicit Content-Type header', async () => {
        await aut.request('POST', '/', {
          headers: { 'Content-Type': 'text/plain' },
          body: '<a>1</a>',
          contentType: 'application/xml',
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['Content-Type']).toBe('text/plain');
      });

      it('does not override an explicit null Content-Type header', async () => {
        await aut.request('POST', '/', {
          headers: { 'Content-Type': null },
          body: '<a>1</a>',
          contentType: 'application/xml',
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['Content-Type']).toBeNull();
      });

      it('rejects a non-string value', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(aut.request('POST', '/', { contentType: 42 as any })).rejects.toThrow(/\[options\.contentType\]/);
      });

      it('rejects an empty string', async () => {
        await expect(aut.request('POST', '/', { contentType: '' })).rejects.toThrow(/\[options\.contentType\]/);
      });

      it('omitted entirely still falls back to JSON-sniffing exactly as before — no regression for existing callers', async () => {
        await aut.request('POST', '/', { body: { foo: 'bar' } });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['Content-Type']).toBe('application/json');
      });
    });

    // mockPerform replaces performRawHTTPOperation entirely, so its request/response
    // detail logging (covered against real servers in APIUtils.spec.ts) never runs here;
    // this verifies only that sendRequest passes this AUT's own name through as
    // targetFriendlyName, for that logging to display.
    it('passes this AUT\'s name through to performRawHTTPOperation as targetFriendlyName, for its own request/response detail logging', async () => {
      await aut.request('GET', '/users');

      const [, options] = mockPerform.mock.calls[0];
      expect(options).toEqual({ targetFriendlyName: aut.appName });
    });

    describe('followRedirects', () => {

      it('defaults to false — a 3xx response is returned as-is, no second call made', async () => {
        mockPerform.mockResolvedValueOnce(makeResponse(302, '', { location: 'http://localhost:9999/next' }));
        await aut.request('GET', '/start');

        expect(mockPerform).toHaveBeenCalledTimes(1);
        expect(aut.lastResponse.status).toBe(302);
      });

      it('301/302/303 downgrade the method to GET and drop the body', async () => {
        mockPerform.mockResolvedValueOnce(makeResponse(302, '', { location: 'http://localhost:9999/next' }));
        mockPerform.mockResolvedValueOnce(makeResponse(200, 'done'));

        await aut.request('POST', '/start', { body: { a: 1 }, followRedirects: true });

        expect(mockPerform).toHaveBeenCalledTimes(2);
        const [secondReq] = mockPerform.mock.calls[1];
        expect(secondReq.method).toBe('GET');
        expect(secondReq.body).toBeUndefined();
        expect(secondReq.host).toBe('localhost:9999');
        expect(secondReq.resourcePath).toBe('/next');
        expect(aut.lastResponse.status).toBe(200);
      });

      it('307/308 preserve the method and body exactly', async () => {
        mockPerform.mockResolvedValueOnce(makeResponse(307, '', { location: '/next' }));
        mockPerform.mockResolvedValueOnce(makeResponse(200, 'done'));

        await aut.request('POST', '/start', { body: { a: 1 }, followRedirects: true });

        const [secondReq] = mockPerform.mock.calls[1];
        expect(secondReq.method).toBe('POST');
        expect(secondReq.body).toEqual({ a: 1 });
        // A relative Location resolves against the previous hop's own host.
        expect(secondReq.host).toBe(`localhost:${DEFAULT_PORT}`);
        expect(secondReq.resourcePath).toBe('/next');
      });

      it('throws once the redirect cap is exceeded, rather than looping forever', async () => {
        mockPerform.mockResolvedValue(makeResponse(302, '', { location: '/start' })); // redirects to itself, forever
        await expect(aut.request('GET', '/start', { followRedirects: true })).rejects.toThrow(/exceeded 20 redirects/);
      });

      it('records every hop as its own transaction, with the final hop as lastTransaction', async () => {
        mockPerform.mockResolvedValueOnce(makeResponse(302, '', { location: '/middle' }));
        mockPerform.mockResolvedValueOnce(makeResponse(302, '', { location: '/final' }));
        mockPerform.mockResolvedValueOnce(makeResponse(200, 'arrived'));

        await aut.request('GET', '/start', { followRedirects: true });

        expect(aut.transactions).toHaveLength(3);
        expect(aut.transactions.map((t) => t.response?.status)).toEqual([302, 302, 200]);
        expect(aut.lastResponse.status).toBe(200);
        expect(aut.lastResponse.body).toBe('arrived');
      });
    });

    // Per the "push detokenisation to the narrowest point of certain use" decision: request()
    // detokenises method, resourcePath, headers, queryString and body unconditionally, with
    // no opt-in flag at the call site — Detokeniser.enabled is the only override, reset to
    // true by afterTest().
    describe('detokenisation', () => {

      afterEach(() => {
        Detokeniser.reset();
      });

      it('detokenises a string header value', async () => {
        await aut.request('GET', '/', {
          headers: { 'x-greeting': 'Hello [[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "world"]]' },
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['x-greeting']).toBe('Hello world');
      });

      it('detokenises every entry of a string[] header value', async () => {
        await aut.request('GET', '/', {
          headers: { 'x-multi': ['[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "a"]]', 'plain-b'] },
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['x-multi']).toEqual(['a', 'plain-b']);
      });

      it('leaves a non-string, non-array header value (number/boolean/null) untouched', async () => {
        await aut.request('GET', '/', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          headers: { 'x-count': 42 as any, 'x-flag': true as any, 'x-null': null },
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.headers['x-count']).toBe(42);
        expect(req.headers['x-flag']).toBe(true);
        expect(req.headers['x-null']).toBeNull();
      });

      it('detokenises the method', async () => {
        await aut.request('[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "GET"]]', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.method).toBe('GET');
      });

      it('detokenises the resourcePath', async () => {
        // Token deliberately not placed directly after a '/' — that's the Detokeniser's
        // escape char, and a real (even-length-prefixed) token there leaves the
        // surrounding escape run completely untouched rather than collapsed (de-escaping
        // is skipped entirely once any real token is found in the string) — a sharp,
        // pre-existing Detokeniser edge case for path-building specifically, not
        // something this test is about.
        await aut.request('GET', '/users/id[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "42"]]');
        const [req] = mockPerform.mock.calls[0];
        expect(req.resourcePath).toBe('/users/id42');
      });

      it('detokenises a resourcePathPreamble token as well as the resourcePath itself', async () => {
        aut.resourcePathPreamble = '/api-[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "v1"]]';
        await aut.request('GET', '/users');
        const [req] = mockPerform.mock.calls[0];
        expect(req.resourcePath).toBe('/api-v1/users');
      });

      it('detokenises the queryString', async () => {
        await aut.request('GET', '/search', {
          queryString: 'q=[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "widgets"]]',
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.queryString).toBe('q=widgets');
      });

      it('detokenises a string body', async () => {
        await aut.request('POST', '/', {
          body: 'Hello [[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "world"]]',
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.body).toBe('Hello world');
      });

      it('detokenises an object body leaf-by-leaf, leaving it as an object', async () => {
        await aut.request('POST', '/', {
          body: { greeting: '[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "world"]]', count: 3 },
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.body).toEqual({ greeting: 'world', count: 3 });
      });

      it('detokenises nested object/array string leaves within an object body', async () => {
        await aut.request('POST', '/', {
          body: {
            user: { name: '[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "Alice"]]' },
            tags: ['[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "a"]]', 'plain-b'],
          },
        });
        const [req] = mockPerform.mock.calls[0];
        expect(req.body).toEqual({ user: { name: 'Alice' }, tags: ['a', 'plain-b'] });
      });

      it('leaves a Buffer body untouched', async () => {
        const buffer = Buffer.from('binary data');
        await aut.request('POST', '/', { body: buffer });
        const [req] = mockPerform.mock.calls[0];
        expect(req.body).toBe(buffer);
      });

      it('passes an undefined body through untouched', async () => {
        await aut.request('GET', '/');
        const [req] = mockPerform.mock.calls[0];
        expect(req.body).toBeUndefined();
      });

      it('does not detokenise anything when Detokeniser.enabled is false', async () => {
        Detokeniser.enabled = false;
        await aut.request(
          '[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "GET"]]',
          '/[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "users"]]',
          {
            headers: { 'x-greeting': 'Hello [[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "world"]]' },
            queryString: 'q=[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "widgets"]]',
            body: 'Hello [[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "world"]]',
          }
        );
        const [req] = mockPerform.mock.calls[0];
        expect(req.method).toBe('[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "GET"]]');
        expect(req.resourcePath).toBe('/[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "users"]]');
        expect(req.headers['x-greeting']).toBe('Hello [[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "world"]]');
        expect(req.queryString).toBe('q=[[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "widgets"]]');
        expect(req.body).toBe('Hello [[setting|processEnvName: "DOES_NOT_EXIST_XYZ", defaultValue: "world"]]');
      });
    });

    it('records a successful transaction', async () => {
      mockPerform.mockResolvedValueOnce(makeResponse(201, '{"id":1}'));
      await aut.request('POST', '/items');
      expect(aut.transactions).toHaveLength(1);
      expect(aut.transactions[0].response?.status).toBe(201);
      expect(aut.transactions[0].error).toBeUndefined();
    });

    it('lastResponse returns the response from the last successful transaction', async () => {
      mockPerform.mockResolvedValueOnce(makeResponse(200, '{"data":"x"}'));
      await aut.request('GET', '/data');
      expect(aut.lastResponse.status).toBe(200);
      expect(aut.lastResponse.body).toBe('{"data":"x"}');
    });

    it('records multiple transactions in order and lastResponse reflects the latest', async () => {
      mockPerform
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeResponse(404));
      await aut.request('GET', '/a');
      await aut.request('GET', '/b');
      expect(aut.transactions).toHaveLength(2);
      expect(aut.lastResponse.status).toBe(404);
    });

    it('records a failed transaction without throwing when AUT does not respond', async () => {
      mockPerform.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(aut.request('GET', '/crash')).resolves.not.toThrow();
      expect(aut.transactions).toHaveLength(1);
      expect(aut.transactions[0].response).toBeUndefined();
      expect(aut.transactions[0].error).toContain('ECONNREFUSED');
    });

    it('records a failed transaction without throwing when the AUT rejects with a non-Error value', async () => {
      mockPerform.mockRejectedValueOnce(null);
      await expect(aut.request('GET', '/crash')).resolves.not.toThrow();
      expect(aut.transactions).toHaveLength(1);
      expect(aut.transactions[0].response).toBeUndefined();
      expect(aut.transactions[0].error).toBeDefined();
    });

    it('lastResponse throws when the last transaction has no response', async () => {
      mockPerform.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await aut.request('GET', '/crash');
      expect(() => aut.lastResponse).toThrow(/AUT may have crashed/);
    });

    it('lastTransaction.error contains the error message from a failed request', async () => {
      mockPerform.mockRejectedValueOnce(new Error('connection reset'));
      await aut.request('GET', '/unstable');
      expect(aut.lastTransaction.error).toContain('connection reset');
    });

    it('a failed request followed by a successful one does not pollute lastResponse', async () => {
      mockPerform
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(makeResponse(200));
      await aut.request('GET', '/crash');
      await aut.request('GET', '/ok');
      expect(aut.lastResponse.status).toBe(200);
    });
  });
});
