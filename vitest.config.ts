import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
});
