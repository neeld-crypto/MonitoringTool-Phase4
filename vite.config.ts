/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { corsProxyPlugin } from './server/proxy-plugin.ts';
import { srtMonitorPlugin } from './server/srt/srt-plugin.ts';

export default defineConfig({
  // Relative base so the static build works from any sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [corsProxyPlugin(), srtMonitorPlugin()],
  // Files the SRT monitor writes while running (and the packaged app) must not trigger reloads or restarts.
  server: { port: 5173, watch: { ignored: ['**/.playprobe/**', '**/logs/**', '**/release/**', '**/build/**'] } },
  preview: { port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
