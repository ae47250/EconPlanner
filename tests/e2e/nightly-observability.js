import { expect, test as base } from "@playwright/test";

function requestKey(request) {
  try {
    const url = new URL(request.url());
    return `${request.method()} ${url.pathname}`;
  } catch {
    return `${request.method()} ${request.url()}`;
  }
}

export const test = base.extend({
  nightlyObservability: [async ({ page, browserName }, use, testInfo) => {
    const consoleErrors = [];
    const pageErrors = [];
    const networkErrors = [];
    const successfulRequests = {};
    const requestCounts = { api: 0, pdf: 0 };
    const viewportHistory = [];

    page.on("console", message => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", error => pageErrors.push(String(error?.message || error)));
    page.on("request", request => {
      const pathname = (() => {
        try { return new URL(request.url()).pathname; } catch { return request.url(); }
      })();
      if (pathname.startsWith("/api/")) requestCounts.api += 1;
      if (pathname === "/api/reports/economics") requestCounts.pdf += 1;
    });
    page.on("requestfailed", request => networkErrors.push({
      type: "requestfailed",
      request: requestKey(request),
      error: request.failure()?.errorText || "unknown"
    }));
    page.on("response", response => {
      const key = requestKey(response.request());
      let pathname = "";
      try { pathname = new URL(response.url()).pathname; } catch { pathname = response.url(); }
      if (response.ok() && pathname.startsWith("/api/")) successfulRequests[key] = (successfulRequests[key] || 0) + 1;
      else if (response.status() >= 400) networkErrors.push({ type: "http", request: key, status: response.status() });
    });

    await use({
      recordViewport(label = "checkpoint") {
        viewportHistory.push({ label, ...page.viewportSize() });
      }
    });

    const successfulDuplicateRequests = Object.entries(successfulRequests)
      .filter(([, count]) => count > 1)
      .map(([request, count]) => ({ request, count }));
    const record = {
      schemaVersion: 2,
      kind: "econplanner-browser-test-observation",
      testId: testInfo.testId,
      title: testInfo.title,
      browserName,
      viewport: page.viewportSize(),
      viewportHistory,
      retry: testInfo.retry,
      expectedStatus: testInfo.expectedStatus,
      status: testInfo.status,
      durationMs: testInfo.duration,
      consoleErrors,
      pageErrors,
      networkErrors,
      requestCounts,
      successfulDuplicateRequests
    };
    await testInfo.attach("nightly-observability.json", {
      body: Buffer.from(JSON.stringify(record, null, 2)),
      contentType: "application/json"
    });
  }, { auto: true }]
});

export { expect };
