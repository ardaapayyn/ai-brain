import { defineConfig } from 'vite';

const API = `http://127.0.0.1:${process.env.BRAIN_PORT ?? 7777}`;

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
