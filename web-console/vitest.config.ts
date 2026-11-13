import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    server: {
      deps: {
        inline: ['antd', '@ant-design/icons', /^@rc-component\//, /^rc-/],
      },
    },
  },
});
