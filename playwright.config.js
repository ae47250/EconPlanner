import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const port = process.env.PLAYWRIGHT_PORT || "3100";
const baseURL = `http://127.0.0.1:${port}`;
const testMcpKey = process.env.ECONPLANNER_TEST_MCP_KEY || randomBytes(32).toString("hex");
process.env.ECONPLANNER_TEST_MCP_KEY = testMcpKey;
process.env.ECONPLANNER_MCP_STATE_KEY = testMcpKey;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure"
  },
  webServer: {
    command: `pnpm dev --hostname 127.0.0.1 --port ${port}`,
    env: { ECONPLANNER_MCP_STATE_KEY: testMcpKey },
    url: `${baseURL}/?layout=apple`,
    reuseExistingServer: !process.env.CI && !process.env.PLAYWRIGHT_PORT,
    timeout: 120000
  }
});
