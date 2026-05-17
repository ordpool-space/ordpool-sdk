import { InjectionToken } from '@angular/core';

/**
 * Minimal contract for browser-side key/value persistence the SDK
 * needs (cat21 mint history, last-connected-wallet snapshot). Matches
 * the surface ordpool/frontend's `StorageService` already exposes, so
 * the frontend can satisfy this token with `{ provide: STORAGE_LIKE,
 * useExisting: StorageService }`.
 *
 * Pure-Node consumers can pass an in-memory shim if they ever need to;
 * the SDK doesn't care what's behind the interface.
 */
export interface StorageLike {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_LIKE = new InjectionToken<StorageLike>('STORAGE_LIKE');
