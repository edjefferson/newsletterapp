import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Shown in the settings menu, so it's obvious which build a device is running
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
})();
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  base: './',
  define: {
    __BUILD__: JSON.stringify(`${commit} · ${built} UTC`),
  },
  build: {
    outDir: 'dist',
  },
  server: {
    // The feed view is shared with the web app and lives in ../static
    fs: { allow: ['..'] },
  },
});
