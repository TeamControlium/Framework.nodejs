import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { DownstreamModule } from './downstream/downstream.module';

@Module({
  imports: [DownstreamModule],
  controllers: [AppController],
})
export class AppModule {}
