import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  busyRetryDelayMs,
  createPdfFromHtml,
  parseRetryAfterSeconds
} from "../lib/pdf-creation-client.js";

const environment = {
  PDF_CREATION_ENABLED: "true",
  PDF_CREATION_API_URL: "https://pdf-creator.example",
  PDF_CREATION_API_KEY: "test-api-key-".padEnd(43, "x"),
  PDF_CREATION_BYPASS_TOKEN: "test-preview-bypass"
};
const pdf = new Uint8Array(Buffer.from("%PDF-1.4\nfictional\n%%EOF\n"));

function storedResult(overrides = {}) {
  return {
    status: "complete",
    requestId: "request-1",
    reportId: "r30_00000000-0000-4000-8000-000000000001",
    caller: "econplanner",
    durationMs: 200,
    pdfBytes: pdf.byteLength,
    pageCount: 3,
    sha256: createHash("sha256").update(pdf).digest("hex"),
    links: {
      download: "https://pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000001/download"
    },
    ...overrides
  };
}

function serviceError(status, code, retryAfter) {
  return Response.json(
    { error: { code, message: code, requestId: `request-${code}` } },
    { status, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } }
  );
}

function successfulStoredFetch({ creationResponses = [], downloadResponse, submitted = [] } = {}) {
  let creationIndex = 0;
  return async (url, options = {}) => {
    if (url.pathname === "/api/v1/pdfs") {
      submitted.push(JSON.parse(options.body));
      const next = creationResponses[creationIndex++];
      return next || Response.json(storedResult());
    }
    return downloadResponse || new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
  };
}

function ids(...values) {
  let index = 0;
  return () => values[index++] || `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

test("manual retries can reuse the stored operation and report a changed-content conflict", async () => {
  const submitted = [];
  const input = {html: "<p>Fictional report</p>", downloadOperationId: "00000000-0000-4000-8000-000000000001"};
  for (let attempt = 0; attempt < 2; attempt++) {
    await createPdfFromHtml(input, {environment, fetchImpl: successfulStoredFetch({submitted})});
  }
  assert.equal(submitted[0].idempotencyKey, submitted[1].idempotencyKey);
  assert.notEqual(submitted[0].correlationId, submitted[1].correlationId);
  await assert.rejects(createPdfFromHtml(input, {environment, fetchImpl: async () => serviceError(409, "idempotency_conflict")}), error => error.code === "PDF_REPORT_CHANGED" && error.status === 409);
});

test("PDF client succeeds on the first stored attempt and uses a new operation key for identical HTML", async () => {
  const firstSubmitted = [];
  const secondSubmitted = [];
  const input = { html: "<!doctype html><html><body>same fictional report</body></html>" };

  await createPdfFromHtml(input, {
    environment,
    fetchImpl: successfulStoredFetch({ submitted: firstSubmitted }),
    randomUUIDImpl: ids("operation-one", "correlation-one")
  });
  await createPdfFromHtml(input, {
    environment,
    fetchImpl: successfulStoredFetch({ submitted: secondSubmitted }),
    randomUUIDImpl: ids("operation-two", "correlation-two")
  });

  assert.equal(firstSubmitted.length, 1);
  assert.equal(firstSubmitted[0].storeResult, true);
  assert.equal(firstSubmitted[0].storeHtml, false);
  assert.equal(firstSubmitted[0].retentionDays, 30);
  assert.equal(firstSubmitted[0].idempotencyKey, "econplanner:operation-one");
  assert.equal(secondSubmitted[0].idempotencyKey, "econplanner:operation-two");
  assert.notEqual(firstSubmitted[0].idempotencyKey, secondSubmitted[0].idempotencyKey);
  assert.equal(firstSubmitted[0].correlationId, "correlation-one");
});

test("PDF retention can change without enabling HTML storage", async () => {
  const submitted = [];
  await createPdfFromHtml({ html: "<!doctype html><p>fictional report</p>", retentionDays: 7, storeHtml: true }, {
    environment,
    fetchImpl: successfulStoredFetch({ submitted })
  });
  assert.equal(submitted[0].storeResult, true);
  assert.equal(submitted[0].storeHtml, false);
  assert.equal(submitted[0].retentionDays, 7);
});

test("renderer_busy retries reuse one idempotency key and apply bounded full-jitter delays", async () => {
  const submitted = [];
  const delays = [];
  const result = await createPdfFromHtml({ html: "<!doctype html><p>busy then success</p>" }, {
    environment,
    fetchImpl: successfulStoredFetch({
      submitted,
      creationResponses: [
        serviceError(429, "renderer_busy", "1"),
        serviceError(429, "renderer_busy", "1"),
        serviceError(429, "renderer_busy", "1")
      ]
    }),
    sleepImpl: async delay => { delays.push(delay); },
    randomImpl: () => 1,
    randomUUIDImpl: ids("stable-operation", "stable-correlation")
  });

  assert.equal(result.pdf.byteLength, pdf.byteLength);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
  assert.equal(submitted.length, 4);
  assert.deepEqual(new Set(submitted.map(item => item.idempotencyKey)), new Set(["econplanner:stable-operation"]));
});

test("renderer_busy stops after five total creation attempts", async () => {
  let attempts = 0;
  await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>always busy</p>" }, {
    environment,
    fetchImpl: async () => {
      attempts += 1;
      return serviceError(429, "renderer_busy", "1");
    },
    sleepImpl: async () => {},
    randomImpl: () => 0,
    randomUUIDImpl: ids("operation", "correlation")
  }), error => {
    assert.equal(error.code, "PDF_CREATION_BUSY");
    assert.equal(error.diagnostics.attemptCount, 5);
    assert.equal(error.diagnostics.retryFailure, "maximum-attempts-exhausted");
    return true;
  });
  assert.equal(attempts, 5);
});

test("renderer_busy fails before a retry that would reach the 15-second admission deadline", async () => {
  let attempts = 0;
  let sleeps = 0;
  await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>deadline</p>" }, {
    environment,
    fetchImpl: async () => {
      attempts += 1;
      return serviceError(429, "renderer_busy", "15");
    },
    nowImpl: () => 10_000,
    sleepImpl: async () => { sleeps += 1; },
    randomImpl: () => 0,
    randomUUIDImpl: ids("operation", "correlation")
  }), error => {
    assert.equal(error.code, "PDF_CREATION_BUSY");
    assert.equal(error.diagnostics.retryFailure, "admission-deadline-exhausted");
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test("a delayed sleep cannot start a retry at or beyond the admission deadline", async () => {
  let now = 0;
  let attempts = 0;
  await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>overslept deadline</p>" }, {
    environment,
    fetchImpl: async () => {
      attempts += 1;
      return serviceError(429, "renderer_busy", "1");
    },
    nowImpl: () => now,
    sleepImpl: async () => { now = 15_000; },
    randomImpl: () => 0,
    randomUUIDImpl: ids("operation", "correlation")
  }), error => error.diagnostics.retryFailure === "admission-deadline-exhausted");
  assert.equal(attempts, 1);
});

test("Retry-After accepts integer seconds only and jitter never exceeds four seconds", () => {
  assert.equal(parseRetryAfterSeconds("0"), 0);
  assert.equal(parseRetryAfterSeconds("1"), 1);
  assert.equal(parseRetryAfterSeconds("60"), 60);
  for (const value of [null, "", "-1", "1.5", " 1", "1 ", "Wed, 21 Oct 2026 07:28:00 GMT", "999999999999999999999"]) {
    assert.throws(() => parseRetryAfterSeconds(value), /invalid-retry-after/);
  }
  assert.equal(busyRetryDelayMs(1, 0, 0), 0);
  assert.equal(busyRetryDelayMs(2, 0, 1), 2_000);
  assert.equal(busyRetryDelayMs(3, 0, 1), 4_000);
  assert.equal(busyRetryDelayMs(9, 0, 1), 4_000);
  assert.equal(busyRetryDelayMs(9, 1, 1), 4_000);
});

test("renderer_busy with an unusable Retry-After fails closed without sleeping", async t => {
  for (const value of [undefined, "", "-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
    await t.test(String(value), async () => {
      let attempts = 0;
      let sleeps = 0;
      await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>bad retry</p>" }, {
        environment,
        fetchImpl: async () => {
          attempts += 1;
          return serviceError(429, "renderer_busy", value);
        },
        sleepImpl: async () => { sleeps += 1; },
        randomUUIDImpl: ids("operation", "correlation")
      }), error => error.diagnostics.retryFailure === "invalid-retry-after");
      assert.equal(attempts, 1);
      assert.equal(sleeps, 0);
    });
  }
});

test("rate_limited is returned as a bounded recoverable response and is never retried", async () => {
  let attempts = 0;
  await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>limited</p>" }, {
    environment,
    fetchImpl: async () => {
      attempts += 1;
      return serviceError(429, "rate_limited", "60");
    },
    randomUUIDImpl: ids("operation", "correlation")
  }), error => {
    assert.equal(error.code, "PDF_CREATION_RATE_LIMITED");
    assert.equal(error.status, 429);
    assert.equal(error.responseHeaders["Retry-After"], "60");
    return true;
  });
  assert.equal(attempts, 1);
});

test("a later independent operation recovers after rate limiting with a new idempotency key", async () => {
  const submitted = [];
  await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>same report</p>" }, {
    environment,
    fetchImpl: async (url, options) => {
      submitted.push(JSON.parse(options.body));
      return serviceError(429, "rate_limited", "60");
    },
    randomUUIDImpl: ids("limited-operation", "limited-correlation")
  }), error => error.code === "PDF_CREATION_RATE_LIMITED");

  await createPdfFromHtml({ html: "<!doctype html><p>same report</p>" }, {
    environment,
    fetchImpl: successfulStoredFetch({ submitted }),
    randomUUIDImpl: ids("recovery-operation", "recovery-correlation")
  });

  assert.equal(submitted[0].idempotencyKey, "econplanner:limited-operation");
  assert.equal(submitted[1].idempotencyKey, "econplanner:recovery-operation");
  assert.notEqual(submitted[0].idempotencyKey, submitted[1].idempotencyKey);
});

test("ordinary 429, 4xx, and ambiguous 5xx creation responses are never retried", async t => {
  for (const [status, code] of [
    [429, "other_overload"],
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [500, "internal_error"],
    [502, "bad_gateway"],
    [503, "unavailable"]
  ]) {
    await t.test(`${status} ${code}`, async () => {
      let attempts = 0;
      await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>no retry</p>" }, {
        environment,
        fetchImpl: async () => {
          attempts += 1;
          return serviceError(status, code);
        },
        randomUUIDImpl: ids("operation", "correlation")
      }), error => error.diagnostics.upstreamStatus === status && error.diagnostics.upstreamCode === code);
      assert.equal(attempts, 1);
    });
  }
});

test("network failures and creation timeouts are not retried and do not expose credentials", async t => {
  for (const failure of [new Error("network failed with test-api-key"), new DOMException("timed out", "TimeoutError")]) {
    await t.test(failure.name, async () => {
      let attempts = 0;
      let caught;
      try {
        await createPdfFromHtml({ html: "<!doctype html><p>transport</p>" }, {
          environment,
          fetchImpl: async () => {
            attempts += 1;
            throw failure;
          },
          randomUUIDImpl: ids("operation", "correlation")
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(attempts, 1);
      assert.equal(caught.diagnostics.failure, failure.name === "TimeoutError" ? "timeout" : "network");
      const serialized = JSON.stringify({ message: caught.message, code: caught.code, diagnostics: caught.diagnostics });
      assert.doesNotMatch(serialized, /test-api-key|test-preview-bypass/);
    });
  }
});

test("direct requests omit storage identity and do not retry ambiguous timeouts", async () => {
  let directPayload;
  const direct = await createPdfFromHtml({
    html: "<!doctype html><p>direct</p>",
    storeResult: false
  }, {
    environment,
    fetchImpl: async (url, options) => {
      directPayload = JSON.parse(options.body);
      return new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
    },
    randomUUIDImpl: ids("direct-correlation")
  });
  assert.equal(direct.pdf.byteLength, pdf.byteLength);
  assert.equal(directPayload.storeResult, false);
  assert.equal(directPayload.storeHtml, false);
  assert.equal("idempotencyKey" in directPayload, false);
  assert.equal("retentionDays" in directPayload, false);

  let attempts = 0;
  await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>direct timeout</p>", storeResult: false }, {
    environment,
    fetchImpl: async () => {
      attempts += 1;
      throw new DOMException("timed out", "TimeoutError");
    },
    randomUUIDImpl: ids("direct-correlation")
  }), error => error.diagnostics.failure === "timeout");
  assert.equal(attempts, 1);
});

test("stored download timeout is not retried", async () => {
  let calls = 0;
  await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>download timeout</p>" }, {
    environment,
    fetchImpl: async url => {
      calls += 1;
      if (url.pathname === "/api/v1/pdfs") return Response.json(storedResult());
      throw new DOMException("timed out", "TimeoutError");
    },
    randomUUIDImpl: ids("operation", "correlation")
  }), error => error.diagnostics.phase === "stored-download" && error.diagnostics.failure === "timeout");
  assert.equal(calls, 2);
});

test("stored metadata rejects malformed ownership and download locations before download", async t => {
  for (const [name, overrides] of [
    ["missing metadata", { requestId: null }],
    ["wrong caller", { caller: "pathfinder" }],
    ["bad report id", { reportId: "other-report" }],
    ["cross origin", { links: { download: "https://untrusted.example/reports/r30_00000000-0000-4000-8000-000000000001/download" } }],
    ["different report path", { links: { download: "https://pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000999/download" } }],
    ["credential-bearing URL", { links: { download: "https://user:password@pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000001/download" } }],
    ["query-bearing path", { links: { download: "https://pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000001/download?token=bad" } }]
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>metadata</p>" }, {
        environment,
        fetchImpl: async () => {
          calls += 1;
          return Response.json(storedResult(overrides));
        },
        randomUUIDImpl: ids("operation", "correlation")
      }), /invalid stored result/i);
      assert.equal(calls, 1);
    });
  }
});

test("stored PDF rejects non-PDF, signature, byte-count, and SHA-256 failures", async t => {
  const cases = [
    ["content type", storedResult(), new Response(pdf, { headers: { "Content-Type": "text/plain" } }), /invalid response/i],
    ["signature", storedResult({ pdfBytes: 6, sha256: createHash("sha256").update("notpdf").digest("hex") }), new Response("notpdf", { headers: { "Content-Type": "application/pdf" } }), /integrity/i],
    ["byte count", storedResult({ pdfBytes: pdf.byteLength + 1 }), new Response(pdf, { headers: { "Content-Type": "application/pdf" } }), /integrity/i],
    ["sha256", storedResult({ sha256: "a".repeat(64) }), new Response(pdf, { headers: { "Content-Type": "application/pdf" } }), /integrity/i]
  ];
  for (const [name, metadata, response, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(createPdfFromHtml({ html: "<!doctype html><p>integrity</p>" }, {
        environment,
        fetchImpl: successfulStoredFetch({ creationResponses: [Response.json(metadata)], downloadResponse: response }),
        randomUUIDImpl: ids("operation", "correlation")
      }), expected);
    });
  }
});

test("disabled and invalid configuration fail before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  await assert.rejects(createPdfFromHtml({ html: "safe" }, {
    environment: { PDF_CREATION_ENABLED: "false" }, fetchImpl
  }), error => error.code === "PDF_CREATION_DISABLED");
  await assert.rejects(createPdfFromHtml({ html: "safe" }, {
    environment: { PDF_CREATION_ENABLED: "true" }, fetchImpl
  }), error => error.code === "PDF_CREATION_NOT_CONFIGURED");
  await assert.rejects(createPdfFromHtml({ html: "safe" }, {
    environment: { ...environment, PDF_CREATION_API_URL: "http://pdf-creator.example" }, fetchImpl
  }), error => error.code === "PDF_CREATION_NOT_CONFIGURED");
  assert.equal(calls, 0);
});
