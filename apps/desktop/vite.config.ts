import { defineConfig } from 'vite';

export default defineConfig({
  // Electron loads dist/index.html from disk (file://) — asset URLs must be
  // relative, not /absolute.
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
  clearScreen: false,
});
