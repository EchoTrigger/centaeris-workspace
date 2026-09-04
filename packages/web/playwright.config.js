const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  webServer: {
    command: "node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: true,
    env: {
      ...process.env,
      API_BASE_URL: "http://localhost:8000",
    },
  },
  use: {
    baseURL: process.env.WORKSPACE_AGENT_WEB_URL || "http://localhost:3100",
    trace: "retain-on-failure",
  },
});
