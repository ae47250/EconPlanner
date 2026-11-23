import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256 } from "./canonical-json.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPILED_ROOT = path.join(REPOSITORY_ROOT, "data/compiled/policy");
const cache = new Map();

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function immutable(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

export function loadEconomicsPolicyCompatibility({
  catalogYear = "2025-2026",
  allowPending = false,
  compiledRoot = COMPILED_ROOT,
  useCache = true
} = {}) {
  const active = readJson(path.join(compiledRoot, "active.json"));
  const reference = active.programs?.ECONOMICS?.[catalogYear];
  if (!reference) throw new Error(`No compiled Economics policy bundle is pinned for ${catalogYear}.`);
  if (!allowPending && reference.activationStatus !== "ACTIVE") {
    throw new Error(`Policy bundle ${reference.bundleVersion} is not active.`);
  }
  const cacheKey = `${compiledRoot}|${reference.releasePath}|${reference.contentHash}|${canonicalSha256(reference.compatibilityHashes || {})}`;
  if (useCache && cache.has(cacheKey)) return cache.get(cacheKey);

  const bundlePath = path.join(compiledRoot, reference.releasePath);
  const bundle = readJson(bundlePath);
  const { contentHash, ...payload } = bundle;
  const computedHash = `sha256:${canonicalSha256(payload)}`;
  if (contentHash !== reference.contentHash || computedHash !== reference.contentHash) {
    throw new Error(`Compiled policy digest mismatch for ${reference.bundleVersion}.`);
  }

  const compatibilityRoot = path.join(path.dirname(bundlePath), "compatibility");
  function readCompatibility(name) {
    const expectedHash = reference.compatibilityHashes?.[`compatibility/${name}`];
    if (!expectedHash) throw new Error(`No compatibility digest is pinned for ${name}.`);
    const document = readJson(path.join(compatibilityRoot, name));
    if (`sha256:${canonicalSha256(document)}` !== expectedHash) {
      throw new Error(`Compiled compatibility digest mismatch for ${name}.`);
    }
    return document;
  }
  const loaded = immutable({
    bundle: { ...bundle, activationStatus: reference.activationStatus },
    requirements: readCompatibility("requirements.json"),
    prerequisites: readCompatibility("prerequisites.json"),
    planningConstraints: readCompatibility("planning-constraints.json"),
    schedule: readCompatibility("schedule-2026-2027.json"),
    courses: readCompatibility("courses.json")
  });
  if (useCache) cache.set(cacheKey, loaded);
  return loaded;
}

export function runtimePolicyBundle() {
  return loadEconomicsPolicyCompatibility().bundle;
}

export function runtimeEconomicsSchedule() {
  return loadEconomicsPolicyCompatibility().schedule;
}
