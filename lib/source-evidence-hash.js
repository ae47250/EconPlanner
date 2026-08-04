import { createHash } from "node:crypto";
import { extname } from "node:path";

const TEXT_EVIDENCE_EXTENSIONS = new Set([
  ".csv",
  ".htm",
  ".html",
  ".json",
  ".md",
  ".txt"
]);

export function canonicalizeTextEvidence(value) {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function sourceEvidenceSha256(value, filePath) {
  const hashInput = TEXT_EVIDENCE_EXTENSIONS.has(extname(filePath).toLowerCase())
    ? canonicalizeTextEvidence(value)
    : value;
  return createHash("sha256").update(hashInput).digest("hex");
}
