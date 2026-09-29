import type { FastifyInstance } from 'fastify';

import { API_AUTWrapper } from '../src/API_AUTWrapper';

import { bootstrap, closeHandler, getUrlHandler } from './dummy-fastify-server/bootstrap';

const PORT = 14030;

describe('API_AUTWrapper against a real Fastify AUT', () => {
  let aut: API_AUTWrapper<FastifyInstance>;

  beforeAll(async () => {
    aut = await API_AUTWrapper.create({
      appName: 'DummyFastify',
      port: PORT,
      bootstrapper: bootstrap,
      closeHandler,
      getUrlHandler,
    });
  });

  afterAll(async () => {
    await aut.close();
  });

  it('starts a real Fastify server and reports live', async () => {
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
});
