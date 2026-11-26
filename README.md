![License](https://img.shields.io/github/license/TeamControlium/Framework.nodejs)
<p align="center">
  <img src="https://github.com/TeamControlium/.github/raw/main/branding/teamcontrolium-banner.svg" width="100%" alt="TeamControlium — test automation frameworks & tooling">
</p>

# @controlium/framework

**Status: work in progress — API-only so far.** Layer 2 of [Controlium](https://github.com/TeamControlium)
ecosystem, built on [`@controlium/utils`](https://github.com/TeamControlium/Utilities.nodejs).
`API_AUTWrapper` (API-level AUT testing) is the only wrapper that exists today;
`Browser_AUTWrapper` (browser/UI AUT support) is not started. Test-runner-agnostic by design —
`@controlium/cucumber` wires this package's lifecycle functions into Cucumber-JS, but nothing
here assumes Cucumber is the only consumer.

## Requirements

- Node.js >= 22
- ESM only. `package.json` has `"type": "module"`; `exports` declares `"import"` only, no
  `"require"`. No CommonJS build.

## Install

```sh
npm install @controlium/framework
```

## What's in it

```ts
import { API_AUTWrapper, beforeSuite, afterSuite, beforeTest, afterTest } from '@controlium/framework';
```

| Export | What it does |
|---|---|
| `API_AUTWrapper` | Manages HTTP targets for API-level testing — either an AUT/s this process itself bootstraps, make API requests against, and later closes (`startNewApplication`/`prepareApplication`+`startApplication`), and/or API endpoints requests sent to and responses received from (`registerAPI`/`prepareAPI`). Instances of either kind coexist, named in one shared registry. Suite-wide registry/leak cleanup available with per-endpoint instance methods covering session config (headers, query params, resource-path), issuing requests and reading back recorded responses, and a liveness checks. All safe and without endpoint health assumptions. |
| `LifecycleHooks` | Runner-agnostic `beforeSuite`/`afterSuite`/`beforeTest`/`afterTest` static methods test-runner drivers can call from own native hooks. |
| `SettingsRegistry` | Declarative catalogue of cross-cutting settings (env var → npm config → profile parameter → default) — `register()` once per setting, `resolve()` from any call site, so every caller resolves the same setting the same way. `lifecycle.ts` registers the framework's own settings (Log Level, Log Max Lines, Default Step Timeout) at module load. |

### Typical usage — single AUT (e.g. in a Cucumber hook file)

```ts
import { API_AUTWrapper } from '@controlium/framework';
import { NestFactory }     from '@nestjs/core';
import { AppModule }       from '../src/app.module';

let api: API_AUTWrapper<INestApplication>;

Before(async () => {
  api = await API_AUTWrapper.startNewApplication({
    appName: 'MyAPI',
    port: 3000,
    bootstrapper: async (port) => {
      const app = await NestFactory.create(AppModule);
      await app.listen(port);
      return app;
    },
    closeHandler:  (app) => app.close(),
    getUrlHandler: (app) => app.getUrl(),
  });

  api.setHeaders({ Authorization: `Bearer ${token}` });
});

When('I GET /users', async () => {
  await api.request('GET', '/users');
});

Then('the response status is {int}', (status: number) => {
  expect(api.lastResponse.status).toBe(status);
});

After(async () => {
  await api.close();
});
```

## Design principles

Package (as per all TeamControlium repos) follows a specific, non-default set of
conventions — defensive coding as baseline to ensure safety and handling of poorly
behaved AUTs, and framework/wrapper code that exposes primitives rather than baking in
policy (no lifecycle method decides timing/retry on the caller's behalf).

## Development

- `npm run build` — clean + compile to `dist/esm`, with `.d.ts` output
- `npm test` — unit tests (Vitest)
- `npm run test:coverage` — unit tests with coverage
- `npm run lint` — ESLint, with autofix

## License

Apache-2.0.
