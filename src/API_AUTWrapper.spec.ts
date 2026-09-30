import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';

import { APIUtils } from '@controlium/utils';

import { API_AUTWrapper } from './API_AUTWrapper';

// ─── Mock @controlium/utils ───────────────────────────────────────────────────

vi.mock('@controlium/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@controlium/utils')>();
  return {
    ...actual,
    Log: { writeLine: vi.fn() },
    APIUtils: {
      ...actual.APIUtils,
      performHTTPOperation: vi.fn(),
    },
  };
});

const mockPerform = vi.mocked(APIUtils.performHTTPOperation);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT      = 14000;
const RAW_SERVER_PORT   = 14001;
const RAW_SERVER_PORT_2 = 14002;

/** Shorthand for a successful HTTP response */
const makeResponse = (
  status  = 200,
  body    = '{"ok":true}',
  headers: Record<string, string> = {},
): APIUtils.HTTPResponse => ({
  status,
  statusMessage: status === 200 ? 'OK' : String(status),
  headers,
  body,
  bodyBuffer: Buffer.from(body),
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

    it('times out a bootstrapper that never settles, using a configurable handlerTimeout', async () => {
      await expect(
        API_AUTWrapper.create({
          appName: 'TestApp',
          port: DEFAULT_PORT,
          bootstrapper: () => new Promise<StubHandle>(() => { /* never resolves */ }),
          closeHandler: stubCloseHandler,
          handlerTimeout: 50,
        })
      ).rejects.toThrow(/bootstrapper threw: bootstrapper: Timeout after 50 ms/);
    });

    it('times out a closeHandler that never settles', async () => {
      aut = await API_AUTWrapper.create({
        appName: 'TestApp',
        port: DEFAULT_PORT,
        bootstrapper: makeStubBootstrapper(),
        closeHandler: () => new Promise<void>(() => { /* never resolves */ }),
        handlerTimeout: 50,
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
        handlerTimeout: 50,
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

      it('rejects a zero or negative timeout', () => {
        expect(() => new API_AUTWrapper({ timeout: 0 })).toThrow(/\[timeout\] not a valid 'positiveNumber'/);
        expect(() => new API_AUTWrapper({ timeout: -5 })).toThrow(/\[timeout\] not a valid 'positiveNumber'/);
      });

      it('rejects a non-numeric handlerTimeout', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => new API_AUTWrapper({ handlerTimeout: 'fast' as any })).toThrow(/\[handlerTimeout\] not a valid 'positiveNumber'/);
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

      it('rejects a non-positive timeout', () => {
        expect(() => { aut.timeout = -1; }).toThrow(/\[timeout\] not a valid 'positiveNumber'/);
      });

      it('rejects a non-positive handlerTimeout', () => {
        expect(() => { aut.handlerTimeout = 0; }).toThrow(/\[handlerTimeout\] not a valid 'positiveNumber'/);
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

    describe('setHeaders / mergeHeaders', () => {

      let aut: API_AUTWrapper;

      beforeEach(() => {
        aut = new API_AUTWrapper({ port: DEFAULT_PORT });
      });

      it('setHeaders rejects null', () => {
        expect(() => aut.setHeaders(null)).toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('setHeaders rejects a non-object', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => aut.setHeaders('x-header: 1' as any)).toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('setHeaders rejects an array', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => aut.setHeaders(['a', 'b'] as any)).toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('mergeHeaders rejects null', () => {
        expect(() => aut.mergeHeaders(null)).toThrow(/\[headers\] not a valid 'nonNullObject'/);
      });

      it('does not crash logging a circular header value', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const circular: any = { a: 1 };
        circular.self = circular;
        expect(() => aut.setHeaders({ weird: circular })).not.toThrow();
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

    it('headers are managed independently per instance', () => {
      const soloAut1 = new API_AUTWrapper({ appName: 'App1', port: DEFAULT_PORT });
      const soloAut2 = new API_AUTWrapper({ appName: 'App2', port: DEFAULT_PORT + 1 });

      soloAut1.setHeaders({ Authorization: 'Bearer token-1' });
      soloAut2.setHeaders({ Authorization: 'Bearer token-2' });

      expect(soloAut1.getHeaders()['Authorization']).toBe('Bearer token-1');
      expect(soloAut2.getHeaders()['Authorization']).toBe('Bearer token-2');
    });

    it('clearing headers on one instance does not affect the other', () => {
      const soloAut1 = new API_AUTWrapper({ appName: 'App1', port: DEFAULT_PORT });
      const soloAut2 = new API_AUTWrapper({ appName: 'App2', port: DEFAULT_PORT + 1 });

      soloAut1.setHeaders({ 'x-custom': 'value' });
      soloAut2.setHeaders({ 'x-custom': 'value' });

      soloAut1.clearHeaders();

      expect(soloAut1.getHeaders()).toEqual({});
      expect(soloAut2.getHeaders()).toEqual({ 'x-custom': 'value' });
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
      await aut.autURL();
      expect(receivedHandles).toEqual([handle]);
    });
  });

  // ─── Header management ─────────────────────────────────────────────────────

  describe('Header management', () => {

    let aut: API_AUTWrapper;

    beforeEach(() => {
      aut = new API_AUTWrapper({ port: DEFAULT_PORT });
    });

    it('setHeaders replaces all existing headers', () => {
      aut.mergeHeaders({ existing: 'old' });
      aut.setHeaders({ 'x-new': 'header' });
      expect(aut.getHeaders()).toEqual({ 'x-new': 'header' });
    });

    it('mergeHeaders adds to existing headers', () => {
      aut.setHeaders({ a: '1' });
      aut.mergeHeaders({ b: '2' });
      expect(aut.getHeaders()).toEqual({ a: '1', b: '2' });
    });

    it('mergeHeaders overwrites matching keys', () => {
      aut.setHeaders({ token: 'old' });
      aut.mergeHeaders({ token: 'new' });
      expect(aut.getHeaders()['token']).toBe('new');
    });

    it('clearHeaders empties the header set', () => {
      aut.setHeaders({ a: '1' });
      aut.clearHeaders();
      expect(aut.getHeaders()).toEqual({});
    });

    it('getHeaders returns a copy — external mutations do not affect wrapper state', () => {
      aut.setHeaders({ a: '1' });
      const copy = aut.getHeaders();
      copy['b'] = '2';
      expect(aut.getHeaders()).toEqual({ a: '1' });
    });

    it('close clears headers', async () => {
      aut.setHeaders({ a: '1' });
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

    it('passes protocol, proxy and timeout to the HTTP request', async () => {
      aut.protocol = 'https';
      aut.proxy    = 'http://proxy:8080';
      aut.timeout  = 5_000;
      await aut.request('GET', '/');
      const [req] = mockPerform.mock.calls[0];
      expect(req.protocol).toBe('https');
      expect(req.proxy).toBe('http://proxy:8080');
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

    it('per-request timeout overrides the session-level timeout for that call only', async () => {
      aut.timeout = 5_000;
      await aut.request('GET', '/', { timeout: 500 });
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

    it('rejects a non-positive per-request timeout', async () => {
      await expect(aut.request('GET', '/', { timeout: 0 })).rejects.toThrow(/\[options\.timeout\] not a valid 'positiveNumber'/);
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
      aut.setHeaders({ 'x-session': 'abc' });
      await aut.request('GET', '/');
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['x-session']).toBe('abc');
    });

    it('merges per-request headers on top of session headers', async () => {
      aut.setHeaders({ 'x-session': 'abc' });
      await aut.request('GET', '/', { headers: { 'x-request': 'xyz' } });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['x-session']).toBe('abc');
      expect(req.headers['x-request']).toBe('xyz');
    });

    it('per-request headers override session headers for matching keys', async () => {
      aut.setHeaders({ 'x-token': 'session' });
      await aut.request('GET', '/', { headers: { 'x-token': 'request' } });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['x-token']).toBe('request');
    });

    it('a null per-request header suppresses a session header for that request only', async () => {
      aut.setHeaders({ Authorization: 'Bearer token' });
      await aut.request('GET', '/', { headers: { Authorization: null } });
      const [req] = mockPerform.mock.calls[0];
      expect(req.headers['Authorization']).toBeNull();
      // Session header is untouched for the next request.
      await aut.request('GET', '/');
      const [req2] = mockPerform.mock.calls[1];
      expect(req2.headers['Authorization']).toBe('Bearer token');
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
