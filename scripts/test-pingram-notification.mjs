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

function emailPayload(env) {
  const recipient = required(env, "ECONPLANNER_NOTIFICATION_EMAIL");
  const fromEmail = required(env, "PINGRAM_FROM_EMAIL");
  const fromName = compact(env.PINGRAM_FROM_NAME) || "EconPlanner";
  const replyTo = compact(env.PINGRAM_REPLY_TO);
  return {
    type: "econplanner_notification_test",
    to: { id: "econplanner-notification-test", email: recipient },
    forceChannels: ["EMAIL"],
    email: {
      subject: "EconPlanner Pingram notification test",
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

async function send({ channel, env, fetchImpl = globalThis.fetch }) {
  const apiKey = required(env, "PINGRAM_API_KEY");
  const base = baseApiUrl(env.PINGRAM_API_URL);
  const isSms = channel === "sms";
  const response = await fetchImpl(`${base}/${isSms ? "sms" : "send"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(isSms ? smsPayload(env) : emailPayload(env)),
  });
  await response.text();
  if (!response.ok) throw new Error(`Pingram ${channel} request failed with HTTP ${response.status}.`);
  return { channel, ok: true, httpStatus: response.status };
}

const channel = compact(process.env.PINGRAM_TEST_CHANNEL || "email").toLowerCase();
if (!CHANNELS.has(channel)) throw new Error(`Unsupported test channel: ${channel || "(missing)"}.`);

const channels = channel === "both" ? ["email", "sms"] : [channel];
try {
  const results = [];
  for (const selected of channels) results.push(await send({ channel: selected, env: process.env }));
  console.log(JSON.stringify({ ok: true, results }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
