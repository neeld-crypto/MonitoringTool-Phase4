import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Express backend (npm run dev in the project root) serves the monitoring and proxy APIs.
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:4173';

export default defineConfig({
  // Relative base so the static build works from any sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/__srt': { target: backend, changeOrigin: false },
      '/__proxy': { target: backend, changeOrigin: false },
      '/__app': { target: backend, changeOrigin: false },
    },
  },
  preview: { port: 4174 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['test/**/*.test.js'] },
});
