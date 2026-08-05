import { createDecision, decisionTraceId } from "./contracts.js";

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
const REQUIRED_ECONOMICS = new Set(["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 461"]);
const REQUIREMENT_PLACEHOLDERS = Object.freeze({
  statistics: "STATISTICS REQUIREMENT",
  cognate: "MATHEMATICS COGNATE",
  finance: "FINANCE REQUIREMENT"
});

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

export function canonicalAllocationCourse(code) {
  const normalized = upper(code);
  return normalized === "PHI 234" ? "ECO 234" : normalized;
}

export function requirementRuleId(requirementId) {
  return String(requirementId || "").startsWith("eco-elective")
    ? "REQ-ECO-ELECTIVES"
    : REQUIREMENT_RULE[requirementId] || null;
}

function electiveEligibility(code, bundle, context) {
  const canonical = canonicalAllocationCourse(code);
  if (!(canonical.startsWith("ECO ") || upper(code) === "ECO ELECTIVE")) return { allowed: false, reasonCode: "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" };
  if (canonical === "ECO ELECTIVE" && Number(context.level100Electives || 0) >= 1 && Number(context.minimumLevel) !== 200) {
    return { allowed: false, reasonCode: "ELECTIVE_PLACEHOLDER_MINIMUM_LEVEL_REQUIRED" };
  }
  if (REQUIRED_ECONOMICS.has(canonical) || ["ECO 257", "ECO 307"].includes(canonical)) {
    return { allowed: false, reasonCode: canonical === "ECO 257" ? "ECO_257_STATISTICS_ONLY" : "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" };
  }
  if (canonical === "ECO 321") {
    const finance = (context.assignments || []).find(item => item.slotId === "finance");
    if (!finance || canonicalAllocationCourse(finance.code) !== "BUSN 323") {
      return { allowed: false, reasonCode: "ECO_321_REQUIRES_BUSN_323_FINANCE_ALLOCATION" };
    }
  }
  if (/^ECO 1\d\d$/.test(canonical) && Number(context.level100Electives || 0) >= 1) {
    return { allowed: false, reasonCode: "MAX_ONE_100_LEVEL_ELECTIVE" };
  }
  const catalogCourse = bundle.indexes.coursesByCode?.[canonical];
  if (catalogCourse && Number(catalogCourse.units || 1) < 1) return { allowed: false, reasonCode: "ELECTIVE_REQUIRES_FULL_COURSE_UNIT" };
  return { allowed: true, reasonCode: "REQUIREMENT_OPTION_MATCH" };
}

export function evaluateRequirementAllocation(course, requirementId, facts, bundle, {
  traceId = decisionTraceId({ course, requirementId, bundle: bundle.contentHash }),
  objectPath = "$",
  assignments = [],
  level100Electives = 0
} = {}) {
  const code = upper(course?.course || course);
  const ruleId = requirementRuleId(requirementId);
  const rule = bundle.indexes.byRuleId[ruleId];
  if (!rule) return createDecision({ bundle, traceId, status: "REVIEW_REQUIRED", classification: "REVIEW", ruleIds: [], reasonCode: "UNKNOWN_REQUIREMENT", subject: { course: code, requirementId }, objectPath, requiredEvidence: ["CANONICAL_REQUIREMENT_RULE"] });

  let outcome;
  if (REQUIREMENT_PLACEHOLDERS[requirementId] === code) {
    outcome = { allowed: true, reasonCode: "REQUIREMENT_PLACEHOLDER_REQUIRES_CONFIRMATION" };
  } else if (course?.source === "requirement-placeholder" && Array.isArray(course.options)) {
    const options = rule.effect.options || [];
    outcome = {
      allowed: options.every(option => course.options.includes(option)),
      reasonCode: "REQUIREMENT_PLACEHOLDER_OPTIONS_MATCH"
    };
  } else if (ruleId === "REQ-ECO-ELECTIVES") {
    outcome = electiveEligibility(code, bundle, { assignments, level100Electives, minimumLevel: course?.minimumLevel });
  } else {
    outcome = {
      allowed: (rule.effect.options || []).includes(canonicalAllocationCourse(code)),
      reasonCode: "REQUIREMENT_OPTION_MATCH"
    };
  }
  const controlling = outcome.reasonCode === "ECO_257_STATISTICS_ONLY"
    ? bundle.indexes.byRuleId["ELECTIVE-ECO-257-STATISTICS-ONLY"]
    : outcome.reasonCode === "MAX_ONE_100_LEVEL_ELECTIVE"
      ? bundle.indexes.byRuleId["ELECTIVE-MAX-ONE-100-LEVEL"]
      : rule;
  return createDecision({
    bundle,
    traceId,
    status: outcome.allowed ? "ALLOW" : "BLOCK",
    classification: "HARD",
    ruleIds: [controlling.ruleId],
    reasonCode: outcome.allowed ? outcome.reasonCode : outcome.reasonCode,
    subject: { course: code, requirementId },
    objectPath,
    messageKeys: controlling.messageKeys,
    sourceRefs: controlling.sourceRefs
  });
}

export function auditRequirements(facts, context = {}, bundle) {
  const traceId = context.traceId || decisionTraceId({ facts, bundle: bundle.contentHash });
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
