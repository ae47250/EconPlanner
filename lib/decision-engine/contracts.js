import { createHash } from "node:crypto";
import { canonicalJson } from "../policy/canonical-json.js";

export const DECISION_STATUS = Object.freeze({
  ALLOW: "ALLOW",
  BLOCK: "BLOCK",
  CONDITIONAL: "CONDITIONAL",
  PRELIMINARY: "PRELIMINARY",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  UNKNOWN: "UNKNOWN"
});

export const DECISION_CLASSIFICATION = Object.freeze({
  HARD: "HARD",
  SOFT: "SOFT",
  EVIDENCE: "EVIDENCE",
  REVIEW: "REVIEW"
});

const STATUS_PRIORITY = ["BLOCK", "UNKNOWN", "REVIEW_REQUIRED", "PRELIMINARY", "CONDITIONAL", "ALLOW"];

function shortHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").slice(0, 20);
}

export function createDecision({
  bundle,
  traceId,
  status,
  classification = "HARD",
  severity,
  ruleIds = [],
  reasonCode,
  subject = {},
  objectPath = "$",
  messageKeys = {},
  messageParams = {},
  sourceRefs = [],
  requiredEvidence = [],
  requiredApproval = null,
  responsibleAuthority = null,
  offeringEvidence = {},
  supportingDecisionIds = [],
  policyDisposition = null,
  provenance = []
}) {
  const identity = { traceId, status, ruleIds, reasonCode, subject, objectPath };
  return Object.freeze({
    decisionId: `decision-${shortHash(identity)}`,
    status,
    classification,
    severity: severity || (status === "BLOCK" ? "error" : status === "ALLOW" ? "info" : "warning"),
    ruleIds: [...new Set(ruleIds)].sort(),
    reasonCode,
    subject,
    objectPath,
    messageKeys,
    messageParams,
    sourceRefs: [...new Set(sourceRefs)].sort(),
    requiredEvidence: [...new Set(requiredEvidence)].sort(),
    requiredApproval,
    responsibleAuthority,
    offeringEvidence,
    policyBundleVersion: bundle.bundleVersion,
    policyBundleHash: bundle.contentHash,
    supportingDecisionIds: [...new Set(supportingDecisionIds)].sort(),
    traceId,
    ...(policyDisposition ? { policyDisposition } : {}),
    ...(provenance.length ? { provenance } : {})
  });
}

export function aggregateDecisionStatus(decisions) {
  return STATUS_PRIORITY.find(status => decisions.some(decision => decision.status === status)) || "ALLOW";
}

export function decisionTraceId(value) {
  return `trace-${shortHash(value)}`;
}
