import { Controller, Get } from '@nestjs/common';

import { DownstreamService } from './downstream.service';

@Controller('downstream')
export class DownstreamController {
  constructor(private readonly downstreamService: DownstreamService) {}

  @Get('fetch')
  async viaFetch(): Promise<unknown> {
    return this.downstreamService.callViaFetch();
  }

  @Get('axios')
  async viaAxios(): Promise<unknown> {
    return this.downstreamService.callViaAxios();
  }
}
