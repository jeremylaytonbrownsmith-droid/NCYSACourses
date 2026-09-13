const { defineConfig } = require('@playwright/test');
const fs = require('fs');

// Prefer the system-provisioned Chromium when the pinned Playwright build
// isn't downloaded (e.g. CI images with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
const systemChromium = '/opt/pw-browsers/chromium';
const executablePath = fs.existsSync(systemChromium) ? systemChromium : undefined;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1, // the journey is one sequential story
  use: {
    baseURL: 'http://localhost:3100',
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'rm -rf .test-data && DATA_DIR=.test-data PORT=3100 INTEGRATION_SECRET=test-secret-123 INTEGRATION_API_KEY=test-api-key-456 INTEGRATION_WEBHOOK_URL=http://127.0.0.1:3131/hook node server.js',
    url: 'http://localhost:3100/api/courses',
    reuseExistingServer: false,
  },
});
