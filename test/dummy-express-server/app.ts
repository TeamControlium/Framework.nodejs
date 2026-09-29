import express, { Express, Request, Response } from 'express';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/ping', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/users/:id', (req: Request, res: Response) => {
    res.json({ id: req.params.id });
  });

  app.post('/echo', (req: Request, res: Response) => {
    res.json(req.body);
  });

  return app;
}
