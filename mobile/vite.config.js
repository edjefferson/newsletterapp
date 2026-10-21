import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    // The feed view is shared with the web app and lives in ../static
    fs: { allow: ['..'] },
  },
});
