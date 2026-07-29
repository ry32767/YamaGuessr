import { defineConfig } from 'vitest/config';

// GitHub Pages（https://<user>.github.io/YamaGuessr/）で配信するため base を付ける。
// ローカル開発と `vite preview` では '/' のままにする。
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/YamaGuessr/' : '/',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
}));
