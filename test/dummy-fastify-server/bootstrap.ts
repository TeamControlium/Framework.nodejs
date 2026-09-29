import { FastifyInstance } from 'fastify';

import { createApp } from './app';

/** Starts the dummy Fastify server on the given port and returns the raw `FastifyInstance`. */
export async function bootstrap(port: number): Promise<FastifyInstance> {
  const app = createApp();
  await app.listen({ port, host: 'localhost' });
  return app;
}

/** Fastify's own `close()` already returns a real Promise. */
export const closeHandler = (app: FastifyInstance): Promise<void> => app.close();

/** Derive the URL from the underlying server's actual bound address. */
export const getUrlHandler = (app: FastifyInstance): string => {
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : undefined;
  return `http://localhost:${port}`;
};
