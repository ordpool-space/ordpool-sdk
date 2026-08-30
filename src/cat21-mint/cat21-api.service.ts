import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';

import { cat21Config } from './cat21-sdk-config';
import {
  buildCatImageUrl,
  buildLatestCatNumbersUrl,
  buildStatusUrl,
} from './cat21-api.urls';
import { CatNumbersResult, StatusResult } from './cat21-api.types';

// Wire contract shared with the framework-agnostic `cat21-api.fetch` twin.
export * from './cat21-api.types';

@Injectable({ providedIn: 'root' })
export class Cat21ApiService {

  private config = inject(cat21Config);
  private baseUrl = this.config.cat21ApiUrl;
  private http = inject(HttpClient);

  getStatus(): Observable<StatusResult> {
    return this.http.get<StatusResult>(buildStatusUrl(this.baseUrl)).pipe(
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  getLatestCatNumbers(itemsPerPage: number): Observable<CatNumbersResult> {
    return this.http.get<CatNumbersResult>(buildLatestCatNumbersUrl(this.baseUrl, itemsPerPage)).pipe(
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  getCatImageUrl(catNumber: number): string {
    return buildCatImageUrl(this.baseUrl, catNumber);
  }
}
