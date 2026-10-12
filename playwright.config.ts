import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './test/e2e',
  use: { baseURL: 'http://127.0.0.1:5186', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'npm run dev:web -- --host 127.0.0.1 --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186/',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: 'list',
  outputDir: 'test-results',
  workers: 1,
});
