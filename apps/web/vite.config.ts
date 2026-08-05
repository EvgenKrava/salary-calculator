import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
    // Tests import ../src/lib/auth (and anything that pulls in config.ts) without a real
    // .env; config.ts throws readably at import time if VITE_* is missing, so tests need
    // placeholder values rather than real Cognito/API config.
    env: {
      VITE_API_URL: 'https://api.test',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_test',
      VITE_COGNITO_CLIENT_ID: 'test-client-id',
    },
  },
});
