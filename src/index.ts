// `.js` extensions here are required at runtime — the compiled dist/esm output is
// loaded by Node's real ESM resolver, which (unlike Vitest/bundler tooling) rejects
// extensionless relative specifiers. Same bug class already hit and fixed in
// @controlium/utils (see project_controlium_framework memory, fixed 2026-09-29).
export { API_AUTWrapper } from './API_AUTWrapper.js';
export {
  beforeSuite,
  afterSuite,
  beforeTest,
  afterTest,
  resolveLogLevelFromSettings,
  resolveMaxLinesFromSettings,
  resolveStepTimeoutFromSettings,
} from './lifecycle.js';
