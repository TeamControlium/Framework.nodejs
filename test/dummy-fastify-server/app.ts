import Fastify, { FastifyInstance } from 'fastify';

export function createApp(): FastifyInstance {
  const app = Fastify();

  app.get('/ping', async () => ({ status: 'ok' }));

  app.get('/users/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { id };
  });

  app.post('/echo', async (request) => request.body);

  return app;
}
