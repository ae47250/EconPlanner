import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildNotificationSubject } from "./notify-econplanner-nightly.mjs";

const DEFAULT_API_URL = "https://api.pingram.io";
const CHANNELS = new Set(["email", "sms", "both"]);

function compact(value) {
  return typeof value === "string" ? value.trim() : "";
}

function baseApiUrl(value) {
  return compact(value || DEFAULT_API_URL).replace(/\/(?:send|sms|email)\/?$/i, "");
}

function required(env, name) {
  const value = compact(env[name]);
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

export function emailPayload(env) {
  const recipient = required(env, "ECONPLANNER_NOTIFICATION_EMAIL");
  const fromEmail = required(env, "PINGRAM_FROM_EMAIL");
  const fromName = compact(env.PINGRAM_FROM_NAME) || "EconPlanner";
  const replyTo = compact(env.PINGRAM_REPLY_TO);
  return {
    type: "econplanner_notification_test",
    to: { id: "econplanner-notification-test", email: recipient },
    forceChannels: ["EMAIL"],
    email: {
      subject: buildNotificationSubject("test", env.ECONPLANNER_NOTIFICATION_SUBJECT_PREFIX),
      html: "<p>This is a fictional EconPlanner notification test.</p>",
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

function smsPayload(env) {
  return {
    type: "econplanner_notification_test",
    to: required(env, "PINGRAM_TEST_PHONE"),
    message: "EconPlanner Pingram SMS test.",
  };
}

export async function send({ channel, env, fetchImpl = globalThis.fetch }) {
  const base = baseApiUrl(env.PINGRAM_API_URL);
  const isSms = channel === "sms";
  const payload = isSms ? smsPayload(env) : emailPayload(env);
  if (env.MOCK_NOTIFICATIONS === "true") {
    return { channel, ok: true, mode: "mock", sent: false };
  }
  const apiKey = required(env, "PINGRAM_API_KEY");
  const response = await fetchImpl(`${base}/${isSms ? "sms" : "send"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await response.text();
  if (!response.ok) throw new Error(`Pingram ${channel} request failed with HTTP ${response.status}.`);
  return { channel, ok: true, httpStatus: response.status };
}

export async function runDiagnostic(env = process.env, fetchImpl = globalThis.fetch) {
  const channel = compact(env.PINGRAM_TEST_CHANNEL || "email").toLowerCase();
  if (!CHANNELS.has(channel)) throw new Error(`Unsupported test channel: ${channel || "(missing)"}.`);
  const channels = channel === "both" ? ["email", "sms"] : [channel];
  const results = [];
  for (const selected of channels) results.push(await send({ channel: selected, env, fetchImpl }));
  return { ok: true, results };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  && !process.env.NODE_TEST_CONTEXT;

if (isMain) {
  try {
    console.log(JSON.stringify(await runDiagnostic()));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
