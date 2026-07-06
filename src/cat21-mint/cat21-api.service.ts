import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';

import { cat21Config } from './cat21-sdk-config';
import {
  buildCatImageUrl,
  buildLatestCatNumbersUrl,
  buildStatusUrl,
} from './cat21-api.urls';

export interface StatusResult {
  totalCats: number;
  lastSyncedCatNumber: number;
  proofOfCatWork: number;
}

export interface CatNumbersResult {
  catNumbers: number[];
  total: number;
  currentPage: number;
  itemsPerPage: number;
}

export interface Cat21 {
  transactionId: string;
  blockId: string;
  number: number;
  feeRate: number;
  blockHeight: number;
  blockTime: number;
  fee: number;
  size: number;
  weight: number;
  value: number;
  sat: number;
  firstOwner: string;
}

export interface Cat21PaginatedResult {
  cats: Cat21[];
  totalResults: number;
  itemsPerPage: number;
  currentPage: number;
}

export interface Cat21SingleResult {
  cat: Cat21;
  previousTransactionId: string | null;
  nextTransactionId: string | null;
}

export interface ErrorResponse {
  statusCode: number;
  timestamp: string;
  path: string;
  message: string;
  stack?: string;
}

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
