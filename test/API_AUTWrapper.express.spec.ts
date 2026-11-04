import type { Server } from 'http';

import { API_AUTWrapper } from '../src/API_AUTWrapper';

import { bootstrap, closeHandler, getUrlHandler } from './dummy-express-server/bootstrap';

const PORT = 14020;

describe('API_AUTWrapper against a real Express AUT', () => {
  let aut: API_AUTWrapper<Server>;

  beforeAll(async () => {
    aut = await API_AUTWrapper.create({
      appName: 'DummyExpress',
      port: PORT,
      bootstrapper: bootstrap,
      closeHandler,
      getUrlHandler,
    });
  });

  afterAll(async () => {
    await aut.close();
  });

  it('starts a real Express server and reports live', async () => {
    expect(aut.isControlled).toBe(true);
    await expect(aut.isLive()).resolves.toBe(true);
  });

  it('talks to a GET endpoint', async () => {
    await aut.request('GET', '/ping');
    expect(aut.lastResponse.status).toBe(200);
    expect(JSON.parse(aut.lastResponse.body)).toEqual({ status: 'ok' });
  });

  it('talks to a GET endpoint with a path parameter', async () => {
    await aut.request('GET', '/users/42');
    expect(aut.lastResponse.status).toBe(200);
    expect(JSON.parse(aut.lastResponse.body)).toEqual({ id: '42' });
  });

  it('talks to a POST endpoint and round-trips a JSON body', async () => {
    await aut.request('POST', '/echo', { body: { hello: 'world' } });
    expect(aut.lastResponse.status).toBe(200);
    expect(JSON.parse(aut.lastResponse.body)).toEqual({ hello: 'world' });
  });

  it('rejects clearly (not hangs) when the port is already bound by another instance', async () => {
    // Regression test for the bootstrap fixture's own bind-failure handling: `server.listen()`'s
    // callback never fires on error, so without an `'error'` listener this would hang until
    // autHandlerTimeout instead of rejecting immediately with the real EADDRINUSE cause.
    await expect(
      API_AUTWrapper.create({
        appName: 'ExpressPortClash',
        port: PORT,
        bootstrapper: bootstrap,
        closeHandler,
        autHandlerTimeout: 2_000,
      })
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
