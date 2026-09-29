import { INestApplication } from '@nestjs/common';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { API_AUTWrapper } from '../src/API_AUTWrapper';

import { bootstrap, closeHandler, getUrlHandler } from './dummy-nestJS-server/bootstrap';
import { DOWNSTREAM_URL } from './dummy-nestJS-server/downstream/downstream.constants';

const PORT = 14010;

// No `onUnhandledRequest` override — unmatched requests (including our own calls
// from this test to the real localhost AUT) bypass to the real network untouched.
// Only requests to DOWNSTREAM_URL are ever mocked, per-test, via mockServer.use().
const mockServer = setupServer();

describe('API_AUTWrapper against a real NestJS AUT', () => {
  let aut: API_AUTWrapper<INestApplication>;

  beforeAll(async () => {
    mockServer.listen();
    aut = await API_AUTWrapper.create({
      appName: 'DummyNest',
      port: PORT,
      bootstrapper: bootstrap,
      closeHandler,
      getUrlHandler,
    });
  });

  afterEach(() => {
    mockServer.resetHandlers();
  });

  afterAll(async () => {
    await aut.close();
    mockServer.close();
  });

  it('starts a real NestJS server and reports live', async () => {
    expect(aut.isControlled).toBe(true);
    await expect(aut.isLive()).resolves.toBe(true);
  });

  it('talks to the real NestJS server for a plain endpoint', async () => {
    await aut.request('GET', '/ping');
    expect(aut.lastResponse.status).toBe(200);
    expect(JSON.parse(aut.lastResponse.body)).toEqual({ status: 'ok' });
  });

  it('mocks a downstream call the AUT makes via fetch', async () => {
    mockServer.use(
      http.get(DOWNSTREAM_URL, () => HttpResponse.json({ source: 'mocked-fetch' }))
    );
    await aut.request('GET', '/downstream/fetch');
    expect(aut.lastResponse.status).toBe(200);
    expect(JSON.parse(aut.lastResponse.body)).toEqual({ source: 'mocked-fetch' });
  });

  it('mocks a downstream call the AUT makes via axios', async () => {
    mockServer.use(
      http.get(DOWNSTREAM_URL, () => HttpResponse.json({ source: 'mocked-axios' }))
    );
    await aut.request('GET', '/downstream/axios');
    expect(aut.lastResponse.status).toBe(200);
    expect(JSON.parse(aut.lastResponse.body)).toEqual({ source: 'mocked-axios' });
  });

  it('surfaces a mocked downstream failure as a 502 (fetch)', async () => {
    mockServer.use(http.get(DOWNSTREAM_URL, () => new HttpResponse(null, { status: 500 })));
    await aut.request('GET', '/downstream/fetch');
    expect(aut.lastResponse.status).toBe(502);
  });

  it('surfaces a mocked downstream failure as a 502 (axios)', async () => {
    mockServer.use(http.get(DOWNSTREAM_URL, () => new HttpResponse(null, { status: 500 })));
    await aut.request('GET', '/downstream/axios');
    expect(aut.lastResponse.status).toBe(502);
  });
});
