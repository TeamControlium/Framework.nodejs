import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { DownstreamController } from './downstream.controller';
import { DownstreamService } from './downstream.service';

@Module({
  imports: [HttpModule],
  controllers: [DownstreamController],
  providers: [DownstreamService],
})
export class DownstreamModule {}
