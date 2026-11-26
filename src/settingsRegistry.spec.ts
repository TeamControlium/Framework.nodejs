import { Settings } from '@controlium/utils';

import { SettingsRegistry } from './settingsRegistry';

describe('SettingsRegistry', () => {
  const key = `Test Setting ${Math.random()}`;

  afterEach(() => {
    delete process.env.TEST_SETTINGS_REGISTRY_SPEC;
    Settings.clearContext();
  });

  describe('resolve', () => {
    it('throws a clear error for a key that was never registered', () => {
      expect(() => SettingsRegistry.resolve(`${key}-unregistered`)).toThrow(
        /no setting registered under key/
      );
    });

    it('resolves the registered default value when no overriding source is set', () => {
      SettingsRegistry.register<string>(key, { defaultValue: 'default-value' });
      expect(SettingsRegistry.resolve<string>(key)).toBe('default-value');
    });

    it('resolves from the registered env var name, taking precedence over the default', () => {
      SettingsRegistry.register<string>(key, { processEnvName: 'TEST_SETTINGS_REGISTRY_SPEC', defaultValue: 'default-value' });
      process.env.TEST_SETTINGS_REGISTRY_SPEC = 'from-env';
      expect(SettingsRegistry.resolve<string>(key)).toBe('from-env');
    });

    it('resolves from a bound Settings profile parameter when no env var is set', () => {
      SettingsRegistry.register<string>(key, { profileParameterName: '$.testSettingsRegistrySpec', defaultValue: 'default-value' });
      Settings.setContext({ sourceName: 'test', parameters: { testSettingsRegistrySpec: 'from-profile' } });
      expect(SettingsRegistry.resolve<string>(key)).toBe('from-profile');
    });

    it('applies the registered cast function to the raw resolved value', () => {
      SettingsRegistry.register<number>(key, { defaultValue: 42 as unknown as number, cast: (raw) => Number(raw) * 2 });
      expect(SettingsRegistry.resolve<number>(key)).toBe(84);
    });

    it('propagates a thrown error from the registered cast function unchanged', () => {
      SettingsRegistry.register<number>(key, {
        defaultValue: 'not-a-number' as unknown as number,
        cast: () => {
          throw new Error('cast rejected this value');
        },
      });
      expect(() => SettingsRegistry.resolve<number>(key)).toThrow('cast rejected this value');
    });

    it('overrides lets one call site use a different source/default without redefining the whole setting', () => {
      SettingsRegistry.register<string>(key, { processEnvName: 'TEST_SETTINGS_REGISTRY_SPEC', defaultValue: 'registered-default' });
      expect(SettingsRegistry.resolve<string>(key, { defaultValue: 'overridden-default' })).toBe('overridden-default');
    });

    it('re-registering the same key overwrites the previous definition entirely', () => {
      SettingsRegistry.register<string>(key, { defaultValue: 'first' });
      SettingsRegistry.register<string>(key, { defaultValue: 'second' });
      expect(SettingsRegistry.resolve<string>(key)).toBe('second');
    });
  });

  describe('has', () => {
    it('is false for a key never registered', () => {
      expect(SettingsRegistry.has(`${key}-never`)).toBe(false);
    });

    it('is true once a key has been registered', () => {
      SettingsRegistry.register<string>(key, { defaultValue: 'x' });
      expect(SettingsRegistry.has(key)).toBe(true);
    });
  });
});
