import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The earlier IndexedDB-only UI snapshots remain as migration references.
  // Current acceptance tests exercise the shared service and protected writes.
  testMatch: ['**/permissions.spec.ts', '**/privacy-import.spec.ts', '**/navigation.spec.ts', '**/reading-settings.spec.ts', '**/directory-move.spec.ts', '**/directory-context.spec.ts', '**/profile.spec.ts', '**/note-tabs.spec.ts', '**/import-titles.spec.ts', '**/fast-loading.spec.ts', '**/linked-import.spec.ts', '**/linked-import-parser.spec.ts', '**/avatar.spec.ts', '**/reading-analytics.spec.ts', '**/import-overwrite.spec.ts', '**/auto-account.spec.ts', '**/live-editor.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1100 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
});
