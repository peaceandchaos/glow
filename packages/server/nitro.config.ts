import { defineConfig } from 'nitro';
import type {} from 'workflow/nitro';

export default defineConfig({
  serverDir: './src/http',
  modules: ['workflow/nitro'],
  features: { websocket: true },
  workflow: { runtime: 'nodejs22.x' },
  vercel: { functions: { maxDuration: 300 } },
});
