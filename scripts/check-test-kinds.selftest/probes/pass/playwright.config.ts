import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Zero retries: a retry of 2 would hide a real failure behind a second roll.
  retries: 0,
  timeout: 120_000,
});
