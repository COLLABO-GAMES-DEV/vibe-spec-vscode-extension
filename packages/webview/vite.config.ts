import { defineConfig } from 'vite';
import { fakeHostServer } from './dev/server.js';

export default defineConfig({
  base: './', plugins: [fakeHostServer()],
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: {
    output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]' },
  } },
});
