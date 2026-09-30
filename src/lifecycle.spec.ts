import { Log, Utils } from '@controlium/utils';

import { afterSuite, afterTest, beforeSuite, beforeTest } from './lifecycle';

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

    it('resets the outstanding promise count and logs', () => {
      const resetSpy = vi.spyOn(Utils, 'resetPromiseCount');
      const logSpy = vi.spyOn(Log, 'writeLine');
      beforeTest();
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining('test starting'));
    });
  });

  describe('afterTest', () => {

    it('resets the outstanding promise count when nothing is outstanding', () => {
      vi.spyOn(Utils, 'promiseCount', 'get').mockReturnValue(0);
      const resetSpy = vi.spyOn(Utils, 'resetPromiseCount');
      const logSpy = vi.spyOn(Log, 'writeLine');

      afterTest();

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining('test ending'));
    });

    it('warns (but does not throw) when a promise is still outstanding, then resets', () => {
      vi.spyOn(Utils, 'promiseCount', 'get').mockReturnValue(2);
      const resetSpy = vi.spyOn(Utils, 'resetPromiseCount');
      const logSpy = vi.spyOn(Log, 'writeLine');

      expect(() => afterTest()).not.toThrow();

      expect(logSpy).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining('2 promise(s) still outstanding'));
      expect(resetSpy).toHaveBeenCalledTimes(1);
    });
  });
});
