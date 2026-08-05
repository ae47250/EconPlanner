import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256 } from "./canonical-json.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPILED_ROOT = path.join(REPOSITORY_ROOT, "data/compiled/policy");
const cache = new Map();

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function immutable(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

export async function loadPolicyBundle({
  program = "ECONOMICS",
  catalogYear = "2025-2026",
  expectedVersion = null,
  expectedHash = null,
  allowPending = false,
  compiledRoot = COMPILED_ROOT,
  useCache = true
} = {}) {
  const active = await readJson(path.join(compiledRoot, "active.json"));
  const reference = active.programs?.[program]?.[catalogYear];
  if (!reference) throw new Error(`No compiled policy bundle is pinned for ${program}/${catalogYear}.`);
  if (!allowPending && reference.activationStatus !== "ACTIVE") throw new Error(`Policy bundle ${reference.bundleVersion} is not active.`);
  if (expectedVersion && reference.bundleVersion !== expectedVersion) throw new Error(`Expected policy bundle ${expectedVersion}, found ${reference.bundleVersion}.`);
  if (expectedHash && reference.contentHash !== expectedHash) throw new Error(`Expected policy digest ${expectedHash}, found ${reference.contentHash}.`);

  const cacheKey = `${compiledRoot}|${reference.releasePath}|${reference.contentHash}`;
  if (useCache && cache.has(cacheKey)) return cache.get(cacheKey);
  const bundle = await readJson(path.join(compiledRoot, reference.releasePath));
  const { contentHash, ...payload } = bundle;
  const computedHash = `sha256:${canonicalSha256(payload)}`;
  if (contentHash !== reference.contentHash || computedHash !== reference.contentHash) {
    throw new Error(`Compiled policy digest mismatch for ${reference.bundleVersion}.`);
  }
  const shaFile = (await readFile(path.join(compiledRoot, path.dirname(reference.releasePath), "bundle.sha256"), "utf8")).trim();
  if (`sha256:${shaFile}` !== reference.contentHash) throw new Error(`Bundle digest file mismatch for ${reference.bundleVersion}.`);

  const loaded = immutable({ ...bundle, activationStatus: reference.activationStatus });
  if (useCache) cache.set(cacheKey, loaded);
  return loaded;
}

export function clearPolicyBundleCache() {
  cache.clear();
}

export function resolveReviewPolicyRecord(bundle, ruleId) {
  const record = (bundle?.unresolved || []).find(candidate => candidate.ruleId === ruleId);
  if (!record) return null;
  if (record.status !== "REVIEW_REQUIRED") {
    throw new Error(`Unresolved policy record ${ruleId} cannot be used as a review-only decision.`);
  }
  const sourceIds = new Set((record.sourceRefs || []).map(reference => String(reference).split("#")[0]));
  const provenance = (bundle.provenance?.sources || []).filter(source => sourceIds.has(source.sourceId));
  return Object.freeze({
    ...record,
    disposition: "REVIEW_ONLY",
    enforcement: "NON_ENFORCING",
    provenance
  });
}
