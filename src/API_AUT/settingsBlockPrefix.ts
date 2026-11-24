import { Settings, Log, LogLevels } from '@controlium/utils';

/** Default top-level settings key `loadSettings` nests every AUT's settings under. */
const DEFAULT_SETTINGS_PREFIX = 'testAUTs';

/**
 * Resolves the configurable top-level settings prefix `loadSettings` nests every AUT's
 * settings block under. Resolved via env var / npm package config only — never via the
 * profile itself (`profileParameterName`), which would be a chicken-and-egg problem: the
 * prefix has to be known before anything can look inside the profile for it.
 *
 * Always logged at `FrameworkDebug` — which prefix convention is in play is rarely-changed,
 * deep framework infrastructure, essentially never test-authoring signal, so it's the
 * quietest tier of `loadSettings`'s whole resolution trail, not something a caller can
 * promote by passing a louder level in.
 */
export function resolveAUTSettingsPrefix(): string {
  const { value, source } = Settings.get<string>(LogLevels.FrameworkDebug, 'AUT settings prefix', {
    processEnvName: 'CONTROLIUM_AUT_SETTINGS_PREFIX',
    npmPackageConfigName: 'autSettingsPrefix',
    defaultValue: DEFAULT_SETTINGS_PREFIX,
  });
  Log.writeLine(LogLevels.FrameworkDebug, `AUT settings prefix: [${value}] (${source})`);
  return value as string;
}

/** Default top-level settings key `loadSettings` nests every API's settings under. */
const DEFAULT_API_SETTINGS_PREFIX = 'testAPIs';

/**
 * Resolves the configurable top-level settings prefix `loadSettings` nests every API's
 * settings block under — the API-flavoured mirror of {@link resolveAUTSettingsPrefix} (see its
 * own doc comment; only the env var/npm-config names and default differ).
 */
export function resolveAPISettingsPrefix(): string {
  const { value, source } = Settings.get<string>(LogLevels.FrameworkDebug, 'API settings prefix', {
    processEnvName: 'CONTROLIUM_API_SETTINGS_PREFIX',
    npmPackageConfigName: 'apiSettingsPrefix',
    defaultValue: DEFAULT_API_SETTINGS_PREFIX,
  });
  Log.writeLine(LogLevels.FrameworkDebug, `API settings prefix: [${value}] (${source})`);
  return value as string;
}
