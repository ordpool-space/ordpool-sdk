/**
 * Response shapes for the cat21 data API (`backend2.cat21.space` /
 * cat21-indexer). Framework-agnostic — shared by the Angular
 * `Cat21ApiService` and the fetch-based `cat21-api.fetch` twin so the
 * wire contract has ONE definition.
 */

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
