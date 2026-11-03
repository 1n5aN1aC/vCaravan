import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the build runs from any path on any static host —
  // GitHub Pages serves a project from a subdirectory.
  base: './',
  // Keeps production stack traces readable — this is a debugging tool, not a
  // shipping app.
  build: { sourcemap: true },
  test: { environment: 'jsdom' },
  server: {
    host: '0.0.0.0', // reachable from other machines on the LAN
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 8787,
  },
});
