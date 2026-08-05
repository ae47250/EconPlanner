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

// The official catalog snapshots were captured and governed with CRLF bytes.
// Canonicalize both Git's LF blob and Windows checkouts to that same form.
const CRLF_TEXT_EVIDENCE_EXTENSIONS = new Set([".php"]);

export function canonicalizeTextEvidence(value) {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function sourceEvidenceSha256(value, filePath) {
  const extension = extname(filePath).toLowerCase();
  const canonicalText = canonicalizeTextEvidence(value);
  const hashInput = CRLF_TEXT_EVIDENCE_EXTENSIONS.has(extension)
    ? canonicalText.replaceAll("\n", "\r\n")
    : TEXT_EVIDENCE_EXTENSIONS.has(extension)
      ? canonicalText
      : value;
  return createHash("sha256").update(hashInput).digest("hex");
}
