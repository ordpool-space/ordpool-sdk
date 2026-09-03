/**
 * Framework-agnostic cat21 data-API client — the plain-async twin of the
 * Observable-returning `Cat21ApiService`. Plain async functions over `fetch`;
 * the caller passes the base URL (from its own config/port) and owns any
 * caching or reactivity (a signal, a memo). No shared state.
 *
 * The image URL is a pure builder (`buildCatImageUrl`), not a fetch — call it
 * directly; there is no twin function for it.
 */

import { fetchJsonAsync } from './http-fetch.helper';
import { buildLatestCatNumbersUrl, buildStatusUrl } from './cat21-api.urls';
import { CatNumbersResult, StatusResult } from './cat21-api.types';

/** `GET /api/status` → indexer status (total cats, last synced, PoCW). */
export function fetchCat21Status(baseUrl: string): Promise<StatusResult> {
  return fetchJsonAsync<StatusResult>(buildStatusUrl(baseUrl));
}

/** `GET /api/cat/numbers?itemsPerPage=N` → the latest N cat numbers. */
export function fetchLatestCatNumbers(
  baseUrl: string,
  itemsPerPage: number,
): Promise<CatNumbersResult> {
  return fetchJsonAsync<CatNumbersResult>(buildLatestCatNumbersUrl(baseUrl, itemsPerPage));
}
