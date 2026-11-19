import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The worker runs on Cloudflare; its tests use Node's fetch, streams and Web Crypto, with every
// binding (Durable Object, R2, container) replaced by an in-memory fake.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
