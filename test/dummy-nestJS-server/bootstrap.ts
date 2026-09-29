import 'reflect-metadata';

import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

/** Starts the dummy NestJS server on the given port and returns the raw `INestApplication`. */
export async function bootstrap(port: number): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(port);
  return app;
}

/** Closes the app via its own built-in `close()`. */
export const closeHandler = (app: INestApplication): Promise<void> => app.close();

/** NestJS's `INestApplication` already knows its own URL. */
export const getUrlHandler = (app: INestApplication): Promise<string> => app.getUrl();
