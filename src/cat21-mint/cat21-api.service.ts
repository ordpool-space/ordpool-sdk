import { Observable, shareReplay } from 'rxjs';

import { Cat21SdkConfig } from './cat21-sdk-config';
import { fetchJson } from './http-fetch.helper';
import {
  buildCatImageUrl,
  buildLatestCatNumbersUrl,
  buildStatusUrl,
} from './cat21-api.urls';
import { CatNumbersResult, StatusResult } from './cat21-api.types';

// Wire contract shared with the framework-agnostic `cat21-api.fetch` twin.
export * from './cat21-api.types';

/**
 * Stateful `Observable`-returning client over the cat21-indexer REST API.
 * Plain class: the consumer passes the SDK config to the constructor and owns
 * the instance's lifetime. The `cat21-api.fetch` twin is the plain-async form.
 */
export class Cat21ApiService {

  private readonly baseUrl: string;

  constructor(config: Cat21SdkConfig) {
    this.baseUrl = config.cat21ApiUrl;
  }

  getStatus(): Observable<StatusResult> {
    return fetchJson<StatusResult>(buildStatusUrl(this.baseUrl)).pipe(
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  getLatestCatNumbers(itemsPerPage: number): Observable<CatNumbersResult> {
    return fetchJson<CatNumbersResult>(buildLatestCatNumbersUrl(this.baseUrl, itemsPerPage)).pipe(
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  getCatImageUrl(catNumber: number): string {
    return buildCatImageUrl(this.baseUrl, catNumber);
  }
}
