import { LogLevels, Settings, Utils } from '@controlium/utils';
import type { LogLevel } from '@controlium/utils';

/**
 * Everything needed to resolve one named setting via {@link Settings.get}'s own env var →
 * npm config → profile parameter → default precedence. Identical in shape to
 * `Utils.getSetting`'s own `sources` parameter, plus two additions specific to registering a
 * setting once and resolving it from many call sites: `logLevel` (which level `Settings.get`
 * logs its own "got setting from X" line at — each setting may reasonably want a different
 * one) and `cast` (parse/validate the raw resolved value into `TValue`, since an env var or
 * npm config value always comes back as a plain string, never already the real type).
 */
export interface SettingDefinition<TValue> {
  processEnvName?: string;
  npmPackageConfigName?: string;
  profileParameterName?: string;
  defaultValue?: TValue;
  logLevel?: LogLevel;
  /**
   * Parses/validates the raw resolved value (whatever `Settings.get` returned, before any
   * type assumption) into `TValue`. Receives `source` too — the human-readable "where this
   * came from" string `Settings.get` already produces — so a thrown validation error can
   * name it, the same way `resolveMaxLinesFromSettings`/`resolveStepTimeoutFromSettings`
   * (this registry's own predecessors) already did by hand. Omit for a setting whose raw
   * value needs no further parsing (e.g. a plain string).
   * @throws Whatever this function itself throws, propagated unchanged by {@link SettingsRegistry.resolve}.
   */
  cast?: (raw: unknown, source: string) => TValue;
}

/**
 * A flat, declarative catalogue of every setting `@controlium/framework` (or a package built
 * on it) knows how to resolve, keyed by name — `register()` once per setting, `resolve()` any
 * number of times from any number of call sites, all referencing the exact same descriptor so
 * they can never drift apart into resolving the "same" setting two different ways.
 *
 * Replaces the previous one-bespoke-function-per-setting pattern
 * (`resolveLogLevelFromSettings`, `resolveMaxLinesFromSettings`,
 * `resolveStepTimeoutFromSettings`), which doesn't scale to a framework expected to grow to
 * hundreds of settings over time — adding setting #101 is one `register()` call, never a new
 * function. Deliberately not named `Settings` — `@controlium/utils` already exports a class
 * with that name (the context-binding layer this registry's own `resolve()` delegates to via
 * `Settings.get`), and a second same-named export from this package would force every caller
 * needing both to alias one of them.
 *
 * @example
 * SettingsRegistry.register('Log Level', {
 *   processEnvName: 'TEST_LOG_LEVEL',
 *   npmPackageConfigName: 'testLogLevel',
 *   profileParameterName: '$.logLevel',
 *   defaultValue: 'Framework Debug',
 * });
 * const level = SettingsRegistry.resolve<string>('Log Level');
 */
export class SettingsRegistry {
  private static readonly _definitions = new Map<string, SettingDefinition<unknown>>();

  /**
   * Registers (or re-registers, overwriting) the descriptor for `key`. Framework-level
   * settings are registered once, at module load, by whichever file owns that setting's
   * meaning (e.g. `lifecycle.ts` for `Log Level`) — a test-runner driver or consumer suite
   * with its own additional settings calls this the same way for its own.
   */
  public static register<TValue>(key: string, definition: SettingDefinition<TValue>): void {
    Utils.assertShape(key, 'nonEmptyString', 'SettingsRegistry.register', 'key');
    Utils.assertShape(definition, 'nonNullObject', 'SettingsRegistry.register', 'definition');
    this._definitions.set(key, definition as SettingDefinition<unknown>);
  }

  /**
   * Resolves `key`'s current value via {@link Settings.get} (so a bound
   * `profileParameterName` context, if any, is honoured automatically), using the descriptor
   * `register()` stored for it — merged with `overrides`, if given, for a call site that
   * needs this specific call to use a different env var/npm config name or default without
   * redefining the whole setting (e.g. a driver with its own pre-existing env var naming for
   * an otherwise-generic setting).
   *
   * @throws {Error} If `key` was never registered, or if the resolved value's own `cast`
   *   (if the descriptor has one) throws.
   */
  public static resolve<TValue>(key: string, overrides?: Partial<SettingDefinition<TValue>>): TValue {
    Utils.assertShape(key, 'nonEmptyString', 'SettingsRegistry.resolve', 'key');
    const definition = this._definitions.get(key) as SettingDefinition<TValue> | undefined;
    if (!definition) {
      throw new Error(`SettingsRegistry.resolve: no setting registered under key [${key}] — call SettingsRegistry.register first.`);
    }
    const merged: SettingDefinition<TValue> = { ...definition, ...overrides };
    const { value, source } = Settings.get<TValue>(merged.logLevel ?? LogLevels.FrameworkInformation, key, {
      processEnvName: merged.processEnvName,
      npmPackageConfigName: merged.npmPackageConfigName,
      profileParameterName: merged.profileParameterName,
      defaultValue: merged.defaultValue,
    });
    return merged.cast ? merged.cast(value, source) : (value as TValue);
  }

  /** Whether `key` has a registered descriptor — mainly for tests; not a general-purpose API. */
  public static has(key: string): boolean {
    return this._definitions.has(key);
  }
}
