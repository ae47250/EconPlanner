import { createDecision } from "./contracts.js";

const REQUIREMENT_RULE = Object.freeze({
  "eco-113": "REQ-ECO-113",
  "eco-114": "REQ-ECO-114",
  "eco-213": "REQ-ECO-213",
  "eco-214": "REQ-ECO-214",
  statistics: "REQ-STATISTICS",
  finance: "REQ-FINANCE",
  "eco-461": "REQ-ECO-461",
  cognate: "REQ-COGNATE"
});

function ruleMessage(rule) {
  return rule?.messageKeys || {};
}

export function requirementRuleId(requirementId) {
  return String(requirementId || "").startsWith("eco-elective")
    ? "REQ-ECO-ELECTIVES"
    : REQUIREMENT_RULE[requirementId] || null;
}

export function evaluateRequirementAllocation(course, requirementId, facts, bundle, { traceId, objectPath = "$" } = {}) {
  const code = String(course?.course || course || "").trim().toUpperCase();
  const ruleId = requirementRuleId(requirementId);
  const rule = bundle.indexes.byRuleId[ruleId];
  if (!rule) return createDecision({ bundle, traceId, status: "UNKNOWN", classification: "REVIEW", ruleIds: [], reasonCode: "UNKNOWN_REQUIREMENT", subject: { course: code, requirementId }, objectPath });

  let allowed = false;
  let reasonCode = "REQUIREMENT_OPTION_MATCH";
  const options = rule.effect.options || [];
  if (course?.source === "requirement-placeholder" && Array.isArray(course.options)) {
    allowed = options.every(option => course.options.includes(option));
    reasonCode = "REQUIREMENT_PLACEHOLDER_OPTIONS_MATCH";
  } else
  if (ruleId === "REQ-ECO-ELECTIVES") {
    allowed = code === "ECO ELECTIVE" || code.startsWith("ECO ") || code === "PHI 234";
    if (code === "ECO 257") {
      allowed = false;
      reasonCode = "ECO_257_STATISTICS_ONLY";
    }
    if (["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 307", "ECO 461"].includes(code)) allowed = false;
  } else {
    allowed = options.includes(code);
  }
  const controlling = reasonCode === "ECO_257_STATISTICS_ONLY"
    ? bundle.indexes.byRuleId["ELECTIVE-ECO-257-STATISTICS-ONLY"]
    : rule;
  return createDecision({
    bundle,
    traceId,
    status: allowed ? "ALLOW" : "BLOCK",
    classification: "HARD",
    ruleIds: [controlling.ruleId],
    reasonCode: allowed ? reasonCode : reasonCode === "ECO_257_STATISTICS_ONLY" ? reasonCode : "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT",
    subject: { course: code, requirementId },
    objectPath,
    messageKeys: ruleMessage(controlling),
    sourceRefs: controlling.sourceRefs
  });
}

export function auditRequirements(facts, context, bundle) {
  const traceId = context.traceId;
  return facts.courses.map((course, index) => createDecision({
    bundle,
    traceId,
    status: "ALLOW",
    classification: "EVIDENCE",
    ruleIds: [],
    reasonCode: "RECORDED_COURSE_PRESERVED",
    subject: { course: course.course, status: course.status },
    objectPath: `$.courses[${index}]`
  }));
}
