import { createHash } from "node:crypto";

const ID_KEYS = ["ruleId", "sourceId", "sectionId", "patternId", "code", "id"];

function stableArray(values) {
  const normalized = values.map(canonicalizeValue);
  const idKey = ID_KEYS.find(key => normalized.every(value => value && typeof value === "object" && !Array.isArray(value) && typeof value[key] === "string"));
  return idKey
    ? normalized.toSorted((left, right) => left[idKey].localeCompare(right[idKey]))
    : normalized;
}

export function canonicalizeValue(value) {
  if (Array.isArray(value)) return stableArray(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map(key => [key, canonicalizeValue(value[key])])
  );
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalizeValue(value), null, 2)}\n`;
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
