import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: { port: 5174, proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: 'dist' },
});
