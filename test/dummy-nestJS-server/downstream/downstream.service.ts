import { HttpService } from '@nestjs/axios';
import { BadGatewayException, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

import { DOWNSTREAM_URL } from './downstream.constants';

@Injectable()
export class DownstreamService {
  constructor(private readonly httpService: HttpService) {}

  async callViaFetch(): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(DOWNSTREAM_URL);
    } catch (err) {
      throw new BadGatewayException(`Downstream call (fetch) failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new BadGatewayException(`Downstream call (fetch) returned ${response.status}`);
    }
    return response.json();
  }

  async callViaAxios(): Promise<unknown> {
    try {
      const { data } = await firstValueFrom(this.httpService.get(DOWNSTREAM_URL));
      return data;
    } catch (err) {
      throw new BadGatewayException(`Downstream call (axios) failed: ${(err as Error).message}`);
    }
  }
}
