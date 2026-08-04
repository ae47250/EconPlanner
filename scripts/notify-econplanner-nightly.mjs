import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_STATUSES = new Set(["started", "succeeded", "failed"]);
const DEFAULT_PINGRAM_API_URL = "https://api.pingram.io";
export const DEFAULT_NOTIFICATION_SUBJECT_PREFIX = "EconPlanner Nightly";
export const MAX_NOTIFICATION_SUBJECT_PREFIX_LENGTH = 120;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FAILURE_SUMMARY_LENGTH = 300;
const SUBJECT_LABELS = Object.freeze({
  started: "Started",
  succeeded: "Passed",
  failed: "Failed",
  test: "Test",
});

export class NightlyNotificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "NightlyNotificationError";
    this.code = code;
    this.details = details;
  }
}

function compact(value) {
  return String(value ?? "").trim();
}

export function normalizeNotificationSubjectPrefix(value) {
  const prefix = compact(value);
  if (!prefix) return DEFAULT_NOTIFICATION_SUBJECT_PREFIX;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(prefix)) {
    throw new NightlyNotificationError(
      "INVALID_NOTIFICATION_SUBJECT_PREFIX",
      "EconPlanner notification subject prefix must not contain control or newline characters.",
      { field: "ECONPLANNER_NOTIFICATION_SUBJECT_PREFIX" },
    );
  }
  if (prefix.length > MAX_NOTIFICATION_SUBJECT_PREFIX_LENGTH) {
    throw new NightlyNotificationError(
      "INVALID_NOTIFICATION_SUBJECT_PREFIX",
      `EconPlanner notification subject prefix must be ${MAX_NOTIFICATION_SUBJECT_PREFIX_LENGTH} characters or fewer.`,
      { field: "ECONPLANNER_NOTIFICATION_SUBJECT_PREFIX" },
    );
  }
  return prefix;
}

export function buildNotificationSubject(status, prefixValue) {
  const label = SUBJECT_LABELS[compact(status).toLowerCase()];
  if (!label) {
    throw new NightlyNotificationError(
      "UNSUPPORTED_NOTIFICATION_STATUS",
      `Unsupported EconPlanner notification subject status: ${compact(status) || "(missing)"}.`,
    );
  }
  return `${normalizeNotificationSubjectPrefix(prefixValue)} — ${label}`;
}

function safeText(value, maxLength = 160) {
  return compact(value).replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeNonNegativeNumber(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new NightlyNotificationError(
      "INVALID_NOTIFICATION_INPUT",
      `${fieldName} must be a non-negative number.`,
      { field: fieldName },
    );
  }
  return number;
}

function normalizeNonNegativeInteger(value, fieldName) {
  const number = normalizeNonNegativeNumber(value, fieldName);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number)) {
    throw new NightlyNotificationError(
      "INVALID_NOTIFICATION_INPUT",
      `${fieldName} must be a non-negative integer.`,
      { field: fieldName },
    );
  }
  return number;
}

function normalizeHttpUrl(value, fieldName) {
  const text = compact(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw new NightlyNotificationError(
      "INVALID_NOTIFICATION_INPUT",
      `${fieldName} must be a valid HTTP or HTTPS URL.`,
      { field: fieldName },
    );
  }
}

function normalizeInput(input = {}) {
  const status = compact(input.status).toLowerCase();
  if (!SUPPORTED_STATUSES.has(status)) {
    throw new NightlyNotificationError(
      "UNSUPPORTED_NOTIFICATION_STATUS",
      `Unsupported EconPlanner nightly notification status: ${status || "(missing)"}.`,
      { supportedStatuses: [...SUPPORTED_STATUSES] },
    );
  }

  const required = {
    repository: safeText(input.repository),
    branch: safeText(input.branch),
    workflowName: safeText(input.workflowName),
    runUrl: normalizeHttpUrl(input.runUrl, "runUrl"),
    startTime: safeText(input.startTime),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new NightlyNotificationError(
      "INVALID_NOTIFICATION_INPUT",
      `Missing required notification fields: ${missing.join(", ")}.`,
      { missing },
    );
  }

  return {
    application: "EconPlanner",
    status,
    ...required,
    durationSeconds: normalizeNonNegativeNumber(input.durationSeconds, "durationSeconds"),
    failedPhase: safeText(input.failedPhase),
    profileId: safeText(input.profileId),
    randomSeed: safeText(input.randomSeed),
    shard: safeText(input.shard),
    failureSummary: safeText(input.failureSummary, MAX_FAILURE_SUMMARY_LENGTH),
    failedTests: normalizeNonNegativeInteger(input.failedTests, "failedTests"),
  };
}

function formatDuration(seconds) {
  if (seconds === undefined) return "";
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round((seconds - minutes * 60) * 100) / 100;
  return remainder ? `${minutes} minutes ${remainder} seconds` : `${minutes} minutes`;
}

export function buildNightlyNotificationContent(input, options = {}) {
  const notification = normalizeInput(input);
  const subject = buildNotificationSubject(notification.status, options.subjectPrefix);
  const rows = [
    ["Application", notification.application],
    ["Repository", notification.repository],
    ["Branch", notification.branch],
    ["Workflow", notification.workflowName],
    ["Status", notification.status],
    ["Start time", notification.startTime],
    ["Duration", formatDuration(notification.durationSeconds)],
    ["Failed phase", notification.failedPhase],
    ["Fictional profile ID", notification.profileId],
    ["Random seed", notification.randomSeed],
    ["Shard", notification.shard],
    ["Failure summary", notification.failureSummary],
    ["Failed tests", notification.failedTests === undefined ? "" : String(notification.failedTests)],
  ].filter(([, value]) => value !== "");

  const htmlRows = rows
    .map(([label, value]) => `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
  const runUrl = escapeHtml(notification.runUrl);

  return {
    notification,
    subject,
    html: [
      `<h1>EconPlanner nightly ${escapeHtml(notification.status)}</h1>`,
      `<table>${htmlRows}</table>`,
      `<p><a href="${runUrl}">Open GitHub Actions run</a></p>`,
    ].join(""),
  };
}

export function pingramEmailEndpoint(apiUrl) {
  const base = compact(apiUrl || DEFAULT_PINGRAM_API_URL).replace(/\/(?:send|sms|email)\/?$/i, "");
  return `${base}/send`;
}

function notificationMode(env) {
  if (env.MOCK_NOTIFICATIONS === "false") return "live";
  if (env.MOCK_NOTIFICATIONS === "true") return "mock";
  return "dry-run";
}

function liveConfig(env) {
  const values = {
    PINGRAM_API_KEY: compact(env.PINGRAM_API_KEY),
    PINGRAM_API_URL: compact(env.PINGRAM_API_URL),
    PINGRAM_FROM_EMAIL: compact(env.PINGRAM_FROM_EMAIL),
    ECONPLANNER_NOTIFICATION_EMAIL: compact(env.ECONPLANNER_NOTIFICATION_EMAIL),
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new NightlyNotificationError(
      "PINGRAM_LIVE_NOT_CONFIGURED",
      `Live EconPlanner notification requires: ${missing.join(", ")}.`,
      { missing },
    );
  }

  return {
    ...values,
    PINGRAM_FROM_NAME: safeText(env.PINGRAM_FROM_NAME) || "EconPlanner",
    PINGRAM_REPLY_TO: compact(env.PINGRAM_REPLY_TO),
  };
}

function buildPingramPayload({ recipient, fromEmail, fromName, replyTo, subject, html }) {
  return {
    type: "econplanner_nightly_email",
    to: {
      id: "econplanner-nightly-recipient",
      email: recipient,
    },
    forceChannels: ["EMAIL"],
    email: {
      subject,
      html,
      senderName: fromName,
      senderEmail: fromEmail,
    },
    options: {
      email: {
        replyToAddresses: replyTo ? [replyTo] : [],
        fromAddress: fromEmail,
        fromName,
      },
    },
  };
}

function publicResult({ mode, status, sent, httpStatus }) {
  return {
    ok: true,
    provider: "pingram",
    notificationType: "econplanner_nightly_email",
    mode,
    sent,
    status,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

export async function notifyEconPlannerNightly(input, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { notification, subject, html } = buildNightlyNotificationContent(input, {
    subjectPrefix: env.ECONPLANNER_NOTIFICATION_SUBJECT_PREFIX,
  });
  const mode = notificationMode(env);

  if (mode !== "live") {
    return publicResult({ mode, status: notification.status, sent: false });
  }

  if (typeof fetchImpl !== "function") {
    throw new NightlyNotificationError("PINGRAM_REQUEST_FAILED", "Pingram request support is unavailable.");
  }

  const config = liveConfig(env);
  const endpoint = pingramEmailEndpoint(config.PINGRAM_API_URL);
  const payload = buildPingramPayload({
    recipient: config.ECONPLANNER_NOTIFICATION_EMAIL,
    fromEmail: config.PINGRAM_FROM_EMAIL,
    fromName: config.PINGRAM_FROM_NAME,
    replyTo: config.PINGRAM_REPLY_TO,
    subject,
    html,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.PINGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new NightlyNotificationError("PINGRAM_TIMEOUT", "Pingram notification timed out.");
    }
    throw new NightlyNotificationError("PINGRAM_REQUEST_FAILED", "Pingram notification request failed.");
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let responseData;
  try {
    responseData = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseData = null;
  }

  if (!response.ok) {
    throw new NightlyNotificationError(
      "PINGRAM_HTTP_ERROR",
      `Pingram notification failed with HTTP ${response.status}.`,
      { httpStatus: response.status },
    );
  }
  if (!responseData || typeof responseData !== "object" || Array.isArray(responseData)) {
    throw new NightlyNotificationError(
      "PINGRAM_INVALID_RESPONSE",
      "Pingram returned an invalid response body.",
      { httpStatus: response.status },
    );
  }

  return publicResult({
    mode,
    status: notification.status,
    sent: true,
    httpStatus: response.status,
  });
}

function readArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new NightlyNotificationError("INVALID_ARGUMENT", `Missing value for ${key}.`);
    }
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

function githubRunUrl(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return "";
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = readArguments(argv);
  return notifyEconPlannerNightly({
    status: args.status,
    repository: args.repository || env.GITHUB_REPOSITORY,
    branch: args.branch || env.GITHUB_REF_NAME,
    workflowName: args["workflow-name"] || env.GITHUB_WORKFLOW,
    runUrl: args["run-url"] || githubRunUrl(env),
    startTime: args["start-time"] || env.ECONPLANNER_NIGHTLY_START_TIME || new Date().toISOString(),
    durationSeconds: args["duration-seconds"],
    failedPhase: args["failed-phase"],
    profileId: args["profile-id"],
    randomSeed: args.seed,
    shard: args.shard,
    failureSummary: args["failure-summary"],
    failedTests: args["failed-tests"],
  }, { env });
}

function safeErrorResult(error) {
  return {
    ok: false,
    provider: "pingram",
    notificationType: "econplanner_nightly_email",
    sent: false,
    error: {
      code: error?.code || "NOTIFICATION_FAILED",
      ...(Number.isInteger(error?.details?.httpStatus) ? { httpStatus: error.details.httpStatus } : {}),
      ...(Array.isArray(error?.details?.missing) ? { missingConfiguration: error.details.missing } : {}),
    },
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const result = await runCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeErrorResult(error))}\n`);
    process.exitCode = 1;
  }
}
