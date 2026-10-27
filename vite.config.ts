import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works under https://<user>.github.io/nvim-memo-web/
  base: './',
  server: { port: 5173 },
});
