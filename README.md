![License](https://img.shields.io/github/license/TeamControlium/framework)
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
| `API_AUTWrapper` | Wraps one locally-running HTTP service under test — start it, send requests, record every transaction, shut it down. Never touches the AUT handle itself (it's opaque, caller-supplied `bootstrapper`/`closeHandler`/`getUrlHandler` functions do that), so it stays framework-agnostic to whatever actually runs the AUT (NestJS, a raw `http.Server`, Fastify, …). Four static factories cover the two shapes a target can take: `startNewApplication`/`prepareApplication` for an AUT this process starts and owns; `registerAPI`/`prepareAPI` for an already-running API this process only talks to. |
| `beforeSuite`, `afterSuite`, `beforeTest`, `afterTest` | Runner-agnostic lifecycle functions a test-runner driver calls from its own native hooks (see `@controlium/cucumber`'s `wireCucumberHooks` for the reference wiring). Expose primitives, not policy — a driver decides when to call them, this package doesn't assume a particular hook model. |
| `resolveLogLevelFromSettings`, `resolveMaxLinesFromSettings`, `resolveStepTimeoutFromSettings` | Settings resolution (env var → npm config → profile parameter → default) for the three cross-cutting values every test-runner driver needs the same way — log level, log line-count cap, and default step timeout. Called by `beforeTest` itself, so any driver gets per-test resolution for free with no wiring of its own. |

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
