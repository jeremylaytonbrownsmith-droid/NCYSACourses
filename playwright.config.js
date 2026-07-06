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
    command: 'rm -rf .test-data && DATA_DIR=.test-data PORT=3100 node server.js',
    url: 'http://localhost:3100/api/courses',
    reuseExistingServer: false,
  },
});
