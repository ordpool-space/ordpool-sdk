// Pure URL builders for the cat21-indexer REST API. Extracted from
// `Cat21ApiService` so they're testable without spinning up Angular DI
// — a typo in `buildCatImageUrl` ships broken `<img>` tags everywhere
// it's bound.

export function buildStatusUrl(baseUrl: string): string {
  return `${baseUrl}/api/status`;
}

export function buildLatestCatNumbersUrl(baseUrl: string, itemsPerPage: number): string {
  return `${baseUrl}/api/cats/numbers/${itemsPerPage}/1`;
}

export function buildCatImageUrl(baseUrl: string, catNumber: number): string {
  return `${baseUrl}/api/cat/${catNumber}/image.webp`;
}
