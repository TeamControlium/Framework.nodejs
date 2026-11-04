import { Detokeniser, Log, Logger, Settings, Utils } from '@controlium/utils';

import { API_AUTWrapper } from './API_AUTWrapper';
import {
  afterSuite,
  afterTest,
  beforeSuite,
  beforeTest,
  resolveLogLevelFromSettings,
  resolveMaxLinesFromSettings,
  resolveStepTimeoutFromSettings,
} from './lifecycle';

describe('lifecycle', () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('beforeSuite / afterSuite', () => {

    it('beforeSuite does not throw and logs', () => {
      const spy = vi.spyOn(Log, 'writeLine');
      expect(() => beforeSuite()).not.toThrow();
      expect(spy).toHaveBeenCalled();
    });

    it('afterSuite does not throw and logs', () => {
      const spy = vi.spyOn(Log, 'writeLine');
      expect(() => afterSuite()).not.toThrow();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('beforeTest', () => {

    it('resets the outstanding promise count and logs', async () => {
      const resetSpy = vi.spyOn(Utils, 'resetPromiseCount');
      const logSpy = vi.spyOn(Log, 'writeLine');
      await beforeTest();
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining('test starting'));
    });

    afterEach(() => {
      delete process.env.TEST_LOG_LEVEL;
      delete process.env.TEST_LOG_MAX_LINES;
      Logger.loggingLevel = 'Framework Debug';
      Logger.maxLines = 55;
    });

    it('resolves and applies the logging level from settings', async () => {
      process.env.TEST_LOG_LEVEL = 'Test Information';
      await beforeTest();
      expect(Logger.loggingLevel).toBe(Logger.Levels.TestInformation);
    });

    it('resolves and applies maxLines from settings', async () => {
      process.env.TEST_LOG_MAX_LINES = '500';
      await beforeTest();
      expect(Logger.maxLines).toBe(500);
    });

    it('resolves logging level/maxLines before logging its own "test starting" line, so that line is already governed by the newly-resolved level', async () => {
      process.env.TEST_LOG_LEVEL = 'Test Information';
      // Loggers resolve relative to Logger.loggingLevel at call time — capture what it
      // already was by the point the "test starting" line itself is written.
      let levelAtLogTime: number | undefined;
      vi.spyOn(Log, 'writeLine').mockImplementation((level: number, text: string) => {
        if (text.includes('test starting')) levelAtLogTime = Logger.loggingLevel;
      });
      await beforeTest();
      expect(levelAtLogTime).toBe(Logger.Levels.TestInformation);
    });
  });

  describe('resolveLogLevelFromSettings', () => {

    afterEach(() => {
      delete process.env.TEST_LOG_LEVEL;
    });

    it('applies the built-in default (Framework Debug) when no overriding source is set', () => {
      expect(resolveLogLevelFromSettings()).toBe('Framework Debug');
    });

    it('resolves from the TEST_LOG_LEVEL env var', () => {
      process.env.TEST_LOG_LEVEL = 'Test Information';
      expect(resolveLogLevelFromSettings()).toBe('Test Information');
    });

    it('resolves from Settings context profile parameters ($.logLevel) when no env var is set', () => {
      Settings.setContext({ sourceName: 'test', parameters: { logLevel: 'Warning' } });
      try {
        expect(resolveLogLevelFromSettings()).toBe('Warning');
      } finally {
        Settings.clearContext();
      }
    });

    it('an env var takes precedence over profile parameters', () => {
      process.env.TEST_LOG_LEVEL = 'Error';
      Settings.setContext({ sourceName: 'test', parameters: { logLevel: 'Warning' } });
      try {
        expect(resolveLogLevelFromSettings()).toBe('Error');
      } finally {
        Settings.clearContext();
      }
    });
  });

  describe('resolveMaxLinesFromSettings', () => {

    afterEach(() => {
      delete process.env.TEST_LOG_MAX_LINES;
    });

    it('applies the built-in default (200) when no overriding source is set', () => {
      expect(resolveMaxLinesFromSettings()).toBe(200);
    });

    it('parses a numeric value that comes back as a string from an env var', () => {
      process.env.TEST_LOG_MAX_LINES = '500';
      expect(resolveMaxLinesFromSettings()).toBe(500);
    });

    it('rejects a resolved value below 3', () => {
      process.env.TEST_LOG_MAX_LINES = '2';
      expect(() => resolveMaxLinesFromSettings()).toThrow(/must be an integer >= 3/);
    });

    it('rejects a non-numeric resolved value', () => {
      process.env.TEST_LOG_MAX_LINES = 'not-a-number';
      expect(() => resolveMaxLinesFromSettings()).toThrow(/must be an integer >= 3/);
    });
  });

  describe('resolveStepTimeoutFromSettings', () => {

    afterEach(() => {
      delete process.env.TEST_STEP_TIMEOUT;
      delete process.env.CUCUMBER_STEP_TIMEOUT;
    });

    it('applies the built-in default (30000) when no overriding source is set', () => {
      expect(resolveStepTimeoutFromSettings()).toBe(30000);
    });

    it('applies a caller-supplied default value', () => {
      expect(resolveStepTimeoutFromSettings({ defaultValue: 5000 })).toBe(5000);
    });

    it('resolves from the TEST_STEP_TIMEOUT env var by default', () => {
      process.env.TEST_STEP_TIMEOUT = '12345';
      expect(resolveStepTimeoutFromSettings()).toBe(12345);
    });

    it('a caller can override the env var name entirely (e.g. a driver with its own established convention)', () => {
      process.env.CUCUMBER_STEP_TIMEOUT = '98765';
      expect(resolveStepTimeoutFromSettings({ processEnvName: 'CUCUMBER_STEP_TIMEOUT' })).toBe(98765);
    });

    it('rejects a resolved value that is not a valid number', () => {
      process.env.TEST_STEP_TIMEOUT = 'not-a-number';
      expect(() => resolveStepTimeoutFromSettings()).toThrow(/must be a positive finite number/);
    });

    it('rejects a non-positive resolved value', () => {
      process.env.TEST_STEP_TIMEOUT = '0';
      expect(() => resolveStepTimeoutFromSettings()).toThrow(/must be a positive finite number/);
    });
  });

  describe('afterTest', () => {

    it('resets the outstanding promise count when nothing is outstanding', async () => {
      vi.spyOn(Utils, 'promiseCount', 'get').mockReturnValue(0);
      const resetSpy = vi.spyOn(Utils, 'resetPromiseCount');
      const logSpy = vi.spyOn(Log, 'writeLine');

      await afterTest();

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining('test ending'));
    });

    it('warns (but does not throw) when a promise is still outstanding, then resets', async () => {
      vi.spyOn(Utils, 'promiseCount', 'get').mockReturnValue(2);
      const resetSpy = vi.spyOn(Utils, 'resetPromiseCount');
      const logSpy = vi.spyOn(Log, 'writeLine');

      await expect(afterTest()).resolves.not.toThrow();

      expect(logSpy).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining('2 promise(s) still outstanding'));
      expect(resetSpy).toHaveBeenCalledTimes(1);
    });

    // Per [[feedback_test_atomicity_non_negotiable]]: afterTest owns clearing every
    // per-test, framework-level ambient static — a driver's own Before-side wiring
    // only ever sets these, never clears them, so a test must never be able to leak
    // this state into whatever runs next regardless of which driver is in use.
    it('clears the Settings context', async () => {
      const clearSpy = vi.spyOn(Settings, 'clearContext');
      await afterTest();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('clears the Logger output callback', async () => {
      const clearSpy = vi.spyOn(Logger, 'clearOutputCallback');
      await afterTest();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('resets Detokeniser (enabled toggle, escape char, callbacks) via its own reset()', async () => {
      const resetSpy = vi.spyOn(Detokeniser, 'reset');
      await afterTest();
      expect(resetSpy).toHaveBeenCalledTimes(1);
    });

    it('end-to-end: a test turning Detokeniser off does not leak into the next test', async () => {
      Detokeniser.enabled = false;
      await afterTest();
      expect(Detokeniser.enabled).toBe(true);
    });

    it('closes and deregisters every registered AUT via closeAllRegistered()', async () => {
      const closeAllSpy = vi.spyOn(API_AUTWrapper, 'closeAllRegistered').mockResolvedValue(undefined);
      await afterTest();
      expect(closeAllSpy).toHaveBeenCalledTimes(1);
    });

    it('clears any staged-but-unconsumed one-shot next-request header override', async () => {
      const clearSpy = vi.spyOn(API_AUTWrapper, 'clearNextRequestHeaders');
      await afterTest();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('clears Settings before its own logging, closes registered AUTs (and clears any pending override) next, logs the active-resources diagnostic and outstanding-promise state after that, and the Logger callback last — so its own log lines are still captured by whatever callback was active', async () => {
      const callOrder: string[] = [];
      vi.spyOn(Settings, 'clearContext').mockImplementation(() => callOrder.push('settings'));
      vi.spyOn(API_AUTWrapper, 'closeAllRegistered').mockImplementation(async () => { callOrder.push('autclose'); });
      vi.spyOn(API_AUTWrapper, 'clearNextRequestHeaders').mockImplementation(() => { callOrder.push('nextreqclear'); });
      vi.spyOn(Log, 'writeLine').mockImplementation(() => callOrder.push('log') as unknown as void);
      vi.spyOn(Logger, 'clearOutputCallback').mockImplementation(() => callOrder.push('logger'));

      await afterTest();

      expect(callOrder).toEqual(['settings', 'autclose', 'nextreqclear', 'log', 'log', 'logger']);
    });
  });
});
