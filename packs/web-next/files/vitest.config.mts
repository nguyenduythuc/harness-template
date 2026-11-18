import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Unit tests: the script "test". Vitest 3.2 runs on Node 18, 20, 22 and 24.
// tsconfigPaths resolves the path aliases and the baseUrl of tsconfig.json, like Next does.
export default defineConfig({
  plugins: [tsconfigPaths()],
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    css: false,
  },
});
