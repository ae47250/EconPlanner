import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const STATE_LIFETIME_MS = 60 * 60 * 1000;
const MAX_STATE_BYTES = 200_000;

export function validStateKey(secret) {
  return typeof secret === "string" && /^[a-f\d]{64}$/i.test(secret);
}

export function encodeState(state, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "hex"), iv);
  const json = Buffer.from(JSON.stringify({ ...state, expiresAt: Date.now() + STATE_LIFETIME_MS }));
  if (json.length > MAX_STATE_BYTES) throw new Error("The plan is too large to continue in chat.");
  const body = Buffer.concat([cipher.update(deflateRawSync(json)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function decodeState(token, secret) {
  if (typeof token !== "string" || token.length < 38 || token.length > 100_000
    || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid plan token");
  const bytes = Buffer.from(token, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secret, "hex"), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  const state = JSON.parse(inflateRawSync(compressed, { maxOutputLength: MAX_STATE_BYTES }));
  if (!Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()
    || !state.student || !Array.isArray(state.plans)
    || typeof state.fingerprint !== "string") throw new Error("Invalid or expired plan token");
  return state;
}

export async function verifyPlanningState(token, secret, getPlannerFingerprint) {
  let state;
  try {
    state = decodeState(token, secret);
  } catch {
    return { kind: "invalid" };
  }
  try {
    const response = await getPlannerFingerprint();
    const { plannerFingerprint } = await response.json();
    if (!response.ok || state.fingerprint !== plannerFingerprint) return { kind: "policy-mismatch" };
  } catch {
    return { kind: "policy-mismatch" };
  }
  return { kind: "valid", state };
}

export function publicSiteOrigin() {
  const configured = process.env.ECONPLANNER_PUBLIC_URL;
  const deployed = process.env.VERCEL_URL;
  const candidate = configured || (deployed ? `https://${deployed}` : "");
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash
      || !url.hostname.includes(".") || /(^|\.)localhost$|\.local$|^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function openInEconPlannerUrl(stateToken, planId) {
  const origin = publicSiteOrigin();
  if (!origin) throw new Error("The deployed EconPlanner address is not configured.");
  return `${origin}/#openPlan=${encodeURIComponent(stateToken)}&plan=${encodeURIComponent(planId)}`;
}
