import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DEFAULT_NOTIFICATION_SUBJECT_PREFIX,
  MAX_NOTIFICATION_SUBJECT_PREFIX_LENGTH,
  NightlyNotificationError,
  buildNotificationSubject,
  buildNightlyNotificationContent,
  notifyEconPlannerNightly,
  normalizeNotificationSubjectPrefix,
  pingramEmailEndpoint,
} from "../scripts/notify-econplanner-nightly.mjs";
import {
  emailPayload as buildDiagnosticEmailPayload,
  runDiagnostic,
} from "../scripts/test-pingram-notification.mjs";

const fictionalInput = Object.freeze({
  status: "started",
  repository: "fictional/econplanner-test",
  branch: "fictional-nightly-branch",
  workflowName: "Fictional EconPlanner nightly",
  runUrl: "https://example.test/actions/runs/1001",
  startTime: "2026-08-03T07:17:00.000Z",
});

const fictionalLiveEnv = Object.freeze({
  MOCK_NOTIFICATIONS: "false",
  PINGRAM_API_KEY: "fictional-secret-key",
  PINGRAM_API_URL: "https://pingram.example.test",
  PINGRAM_FROM_EMAIL: "sender@example.test",
  PINGRAM_FROM_NAME: "Fictional EconPlanner",
  PINGRAM_REPLY_TO: "reply@example.test",
  ECONPLANNER_NOTIFICATION_EMAIL: "administrator@example.test",
});

function fakeResponse({ ok = true, status = 202, body = { id: "fictional-message-1" } } = {}) {
  return {
    ok,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

async function captureLiveRequest(input = fictionalInput, response = fakeResponse(), env = fictionalLiveEnv) {
  const calls = [];
  const result = await notifyEconPlannerNightly(input, {
    env,
    fetchImpl: async (...args) => {
      calls.push(args);
      return response;
    },
  });
  assert.equal(calls.length, 1);
  return { result, endpoint: calls[0][0], request: calls[0][1], body: JSON.parse(calls[0][1].body) };
}

async function assertNotificationError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof NightlyNotificationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("default behavior is a dry run and performs no request", async () => {
  let requestCount = 0;
  const result = await notifyEconPlannerNightly(fictionalInput, {
    env: {},
    fetchImpl: async () => {
      requestCount += 1;
      throw new Error("network must not be called");
    },
  });

  assert.deepEqual(result, {
    ok: true,
    provider: "pingram",
    notificationType: "econplanner_nightly_email",
    mode: "dry-run",
    sent: false,
    status: "started",
  });
  assert.equal(requestCount, 0);
});

test("explicit mock mode performs no request", async () => {
  let requestCount = 0;
  const result = await notifyEconPlannerNightly(fictionalInput, {
    env: { MOCK_NOTIFICATIONS: "true" },
    fetchImpl: async () => {
      requestCount += 1;
      throw new Error("network must not be called");
    },
  });

  assert.equal(result.mode, "mock");
  assert.equal(result.sent, false);
  assert.equal(requestCount, 0);
});

test("live mode rejects missing explicit configuration", async () => {
  await assertNotificationError(
    notifyEconPlannerNightly(fictionalInput, {
      env: { MOCK_NOTIFICATIONS: "false" },
      fetchImpl: async () => {
        throw new Error("network must not be called");
      },
    }),
    "PINGRAM_LIVE_NOT_CONFIGURED",
  );
});

test("unsupported notification status is rejected", async () => {
  await assertNotificationError(
    notifyEconPlannerNightly({ ...fictionalInput, status: "cancelled" }, { env: {} }),
    "UNSUPPORTED_NOTIFICATION_STATUS",
  );
});

test("notification subject prefix defaults when unset or blank", () => {
  assert.equal(normalizeNotificationSubjectPrefix(undefined), DEFAULT_NOTIFICATION_SUBJECT_PREFIX);
  assert.equal(normalizeNotificationSubjectPrefix("   "), DEFAULT_NOTIFICATION_SUBJECT_PREFIX);
  assert.equal(buildNotificationSubject("started"), "EconPlanner Nightly — Started");
});

test("notification subject prefix accepts custom text and trims surrounding whitespace", () => {
  assert.equal(normalizeNotificationSubjectPrefix("  Economics QA  "), "Economics QA");
  assert.equal(buildNotificationSubject("succeeded", "  Economics QA  "), "Economics QA — Passed");
});

test("notification subject prefix rejects newline and control characters", () => {
  for (const prefix of ["Economics\nInjected-Header: blocked", "Economics\rNightly", "Economics\u0000Nightly"]) {
    assert.throws(
      () => normalizeNotificationSubjectPrefix(prefix),
      (error) => error instanceof NightlyNotificationError
        && error.code === "INVALID_NOTIFICATION_SUBJECT_PREFIX",
    );
  }
});

test("notification subject prefix rejects excessively long values", () => {
  assert.equal(normalizeNotificationSubjectPrefix("x".repeat(MAX_NOTIFICATION_SUBJECT_PREFIX_LENGTH)).length, 120);
  assert.throws(
    () => normalizeNotificationSubjectPrefix("x".repeat(MAX_NOTIFICATION_SUBJECT_PREFIX_LENGTH + 1)),
    (error) => error instanceof NightlyNotificationError
      && error.code === "INVALID_NOTIFICATION_SUBJECT_PREFIX",
  );
});

test("nightly subjects use Started, Passed, and Failed labels", () => {
  assert.equal(buildNotificationSubject("started", "Economics QA"), "Economics QA — Started");
  assert.equal(buildNotificationSubject("succeeded", "Economics QA"), "Economics QA — Passed");
  assert.equal(buildNotificationSubject("failed", "Economics QA"), "Economics QA — Failed");
});

test("standalone diagnostic subject uses the same prefix and Test label", () => {
  const payload = buildDiagnosticEmailPayload({
    ...fictionalLiveEnv,
    ECONPLANNER_NOTIFICATION_SUBJECT_PREFIX: "  Economics QA  ",
  });
  assert.equal(payload.email.subject, "Economics QA — Test");
  assert.equal(payload.to.email, fictionalLiveEnv.ECONPLANNER_NOTIFICATION_EMAIL);
  assert.equal(payload.email.senderEmail, fictionalLiveEnv.PINGRAM_FROM_EMAIL);
  assert.equal(payload.email.senderName, fictionalLiveEnv.PINGRAM_FROM_NAME);
  assert.deepEqual(payload.options.email.replyToAddresses, [fictionalLiveEnv.PINGRAM_REPLY_TO]);
  assert.deepEqual(payload.forceChannels, ["EMAIL"]);
});

test("started payload follows the confirmed Pingram email contract", async () => {
  const { endpoint, request, body } = await captureLiveRequest();
  assert.equal(endpoint, "https://pingram.example.test/send");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer fictional-secret-key");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(body.type, "econplanner_nightly_email");
  assert.deepEqual(body.forceChannels, ["EMAIL"]);
  assert.equal(body.to.email, "administrator@example.test");
  assert.equal(body.email.senderEmail, "sender@example.test");
  assert.equal(body.email.subject, "EconPlanner Nightly — Started");
  assert.match(body.email.html, /Fictional EconPlanner nightly/);
  assert.deepEqual(body.options.email.replyToAddresses, ["reply@example.test"]);
  assert.equal(body.options.email.fromAddress, fictionalLiveEnv.PINGRAM_FROM_EMAIL);
  assert.equal(body.options.email.fromName, fictionalLiveEnv.PINGRAM_FROM_NAME);
});

test("succeeded payload identifies a successful run", async () => {
  const { body } = await captureLiveRequest({ ...fictionalInput, status: "succeeded" });
  assert.equal(body.email.subject, "EconPlanner Nightly — Passed");
  assert.match(body.email.html, /succeeded/);
});

test("failed payload includes a short safe failure summary and failed count", async () => {
  const { body } = await captureLiveRequest({
    ...fictionalInput,
    status: "failed",
    failureSummary: "Two fictional planner assertions failed.",
    failedTests: 2,
  });
  assert.equal(body.email.subject, "EconPlanner Nightly — Failed");
  assert.match(body.email.html, /Two fictional planner assertions failed\./);
  assert.match(body.email.html, />2</);
});

test("optional duration is included when known", () => {
  const { html } = buildNightlyNotificationContent({ ...fictionalInput, durationSeconds: 125 });
  assert.match(html, /2 minutes 5 seconds/);
});

test("optional failed phase is included when known", () => {
  const { html } = buildNightlyNotificationContent({
    ...fictionalInput,
    status: "failed",
    failedPhase: "fictional profile shard",
  });
  assert.match(html, /fictional profile shard/);
});

test("optional fictional profile, seed, and shard are included when known", () => {
  const { html } = buildNightlyNotificationContent({
    ...fictionalInput,
    status: "failed",
    profileId: "fictional-profile-17",
    randomSeed: "20260803",
    shard: "2/4",
  });
  assert.match(html, /fictional-profile-17/);
  assert.match(html, /20260803/);
  assert.match(html, /2\/4/);
});

test("mocked successful Pingram response returns a non-secret structured result", async () => {
  const { result } = await captureLiveRequest(fictionalInput, fakeResponse({ status: 201 }));
  assert.deepEqual(result, {
    ok: true,
    provider: "pingram",
    notificationType: "econplanner_nightly_email",
    mode: "live",
    sent: true,
    status: "started",
    httpStatus: 201,
  });
});

test("HTTP failure is reported without returning the provider body", async () => {
  const providerBody = { error: "fictional provider rejection", credential: "do-not-return" };
  await assert.rejects(
    notifyEconPlannerNightly(fictionalInput, {
      env: fictionalLiveEnv,
      fetchImpl: async () => fakeResponse({ ok: false, status: 429, body: providerBody }),
    }),
    (error) => {
      assert.equal(error.code, "PINGRAM_HTTP_ERROR");
      assert.equal(error.details.httpStatus, 429);
      assert.doesNotMatch(JSON.stringify(error), /fictional provider rejection|do-not-return/);
      return true;
    },
  );
});

test("timeout aborts the request and returns a safe timeout code", async () => {
  await assertNotificationError(
    notifyEconPlannerNightly(fictionalInput, {
      env: fictionalLiveEnv,
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    }),
    "PINGRAM_TIMEOUT",
  );
});

test("invalid successful Pingram response body is rejected", async () => {
  await assertNotificationError(
    notifyEconPlannerNightly(fictionalInput, {
      env: fictionalLiveEnv,
      fetchImpl: async () => fakeResponse({ body: "not-json" }),
    }),
    "PINGRAM_INVALID_RESPONSE",
  );
});

test("Pingram error body is not exposed", async () => {
  const privateBody = "private fictional provider failure details";
  await assert.rejects(
    notifyEconPlannerNightly(fictionalInput, {
      env: fictionalLiveEnv,
      fetchImpl: async () => fakeResponse({ ok: false, status: 500, body: privateBody }),
    }),
    (error) => {
      assert.equal(error.code, "PINGRAM_HTTP_ERROR");
      assert.doesNotMatch(error.message, /private fictional provider failure details/);
      return true;
    },
  );
});

test("secret is absent from the structured result", async () => {
  const { result } = await captureLiveRequest();
  assert.doesNotMatch(JSON.stringify(result), /fictional-secret-key/);
});

test("recipient is absent from the structured result", async () => {
  const { result } = await captureLiveRequest();
  assert.doesNotMatch(JSON.stringify(result), /administrator@example\.test/);
});

test("student data and arbitrary private payloads are never added to the email", async () => {
  const { body } = await captureLiveRequest({
    ...fictionalInput,
    studentName: "Fictional Student Secret",
    studentId: "student-secret-123",
    studentSchedule: ["Secret Course 101"],
    privateFailurePayload: { secret: "private-payload-secret" },
  });
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Fictional Student Secret|student-secret-123|Secret Course 101|private-payload-secret/);
});

test("all safety-mode test paths prove no live request occurs", async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    throw new Error("unexpected live request");
  };

  await notifyEconPlannerNightly(fictionalInput, { env: {}, fetchImpl });
  await notifyEconPlannerNightly(fictionalInput, { env: { MOCK_NOTIFICATIONS: "true" }, fetchImpl });
  assert.equal(requestCount, 0);
});

test("standalone diagnostic mock mode preserves email delivery behavior without sending", async () => {
  let requestCount = 0;
  const result = await runDiagnostic({
    ...fictionalLiveEnv,
    MOCK_NOTIFICATIONS: "true",
    PINGRAM_TEST_CHANNEL: "email",
  }, async () => {
    requestCount += 1;
    throw new Error("network must not be called");
  });
  assert.deepEqual(result.results, [
    { channel: "email", ok: true, mode: "mock", sent: false },
  ]);
  assert.equal(requestCount, 0);
});

test("workflows use the non-secret subject variable without changing notification counts or triggers", () => {
  const nightly = fs.readFileSync(new URL("../.github/workflows/econplanner-nightly.yml", import.meta.url), "utf8");
  const diagnostic = fs.readFileSync(new URL("../.github/workflows/econplanner-pingram-test.yml", import.meta.url), "utf8");
  const variableReference = "ECONPLANNER_NOTIFICATION_SUBJECT_PREFIX: ${{ vars.ECONPLANNER_NOTIFICATION_SUBJECT_PREFIX }}";

  assert.equal(nightly.split(variableReference).length - 1, 2);
  assert.equal(nightly.split("node scripts/notify-econplanner-nightly.mjs").length - 1, 2);
  assert.equal(nightly.split("--status started").length - 1, 1);
  assert.equal(nightly.split("--status \"${{ steps.outcome.outputs.status }}\"").length - 1, 1);
  assert.equal(diagnostic.split(variableReference).length - 1, 1);
  assert.match(diagnostic, /^on:\r?\n  workflow_dispatch:/m);
  assert.doesNotMatch(diagnostic, /^  (schedule|push|pull_request):/m);
});

test("endpoint normalization matches the existing Pingram integration", () => {
  assert.equal(pingramEmailEndpoint("https://api.pingram.io"), "https://api.pingram.io/send");
  assert.equal(pingramEmailEndpoint("https://api.pingram.io/send"), "https://api.pingram.io/send");
});
