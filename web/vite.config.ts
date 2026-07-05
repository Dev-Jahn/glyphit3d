import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Self-locating root so `vite` works from web/ or `vite --config web/vite.config.ts`
// from the repo. base './' keeps the built bundle relocatable under GitHub Pages.
// vitest runs from the repo root and never loads this config (it lives under web/).
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
