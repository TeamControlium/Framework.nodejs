import { createServer, Server } from 'http';

import { createApp } from './app';

/**
 * Starts the dummy Express server on the given port and returns the raw `http.Server`.
 *
 * `server.listen()`'s callback only fires on success — a bind failure (e.g. `EADDRINUSE`)
 * emits an `'error'` event instead, which the callback never sees. Without the `'error'`
 * listener below, that promise would never settle and this bootstrapper would hang forever
 * rather than reject — a common real-world Express footgun this fixture exists to model
 * correctly rather than reproduce.
 */
export async function bootstrap(port: number): Promise<Server> {
  const app = createApp();
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

/** Express/Node's `http.Server.close()` is callback-based — wrap it in a real Promise. */
export const closeHandler = (server: Server): Promise<void> =>
  new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );

/** Derive the URL from the server's actual bound address, not an assumed port. */
export const getUrlHandler = (server: Server): string => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : undefined;
  return `http://localhost:${port}`;
};
