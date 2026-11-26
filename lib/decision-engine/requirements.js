import { createDecision, decisionTraceId } from "./contracts.js";

import { REQUIREMENT_PLACEHOLDERS, electiveMaximum100, electivePairings, electivePlaceholderMinimumLevel } from "../policy/requirement-choices.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function findCanonicalCourse(rulesById, normalized) {
  const equivalency = Object.values(rulesById).find(rule =>
    rule.condition.equivalentCodes?.includes(normalized) && rule.effect.canonicalCourse);
  return equivalency?.effect.canonicalCourse || normalized;
}

// For a locked (frozen) rule set, as loaded in production, the table of equivalent
// codes is built once from the rules themselves, so it holds only real equivalents
// and never grows with the codes students enter. Any other rule set is searched every time.
const equivalentCodeTables = new WeakMap();
function equivalentCodeTable(rulesById) {
  let table = equivalentCodeTables.get(rulesById);
  if (!table) {
    table = new Map();
    for (const rule of Object.values(rulesById)) {
      if (!rule.effect?.canonicalCourse) continue;
      for (const code of rule.condition?.equivalentCodes || []) if (!table.has(code)) table.set(code, rule.effect.canonicalCourse);
    }
    equivalentCodeTables.set(rulesById, table);
  }
  return table;
}

export function canonicalAllocationCourse(code, bundle = runtimePolicyBundle()) {
  const normalized = upper(code);
  const rulesById = bundle.indexes.byRuleId;
  if (!Object.isFrozen(rulesById)) return findCanonicalCourse(rulesById, normalized);
  return equivalentCodeTable(rulesById).get(normalized) || normalized;
}

export function requirementRuleId(requirementId, bundle = runtimePolicyBundle()) {
  return Object.values(bundle.indexes.byRuleId).find(rule => rule.ruleType === "requirementDefinition" && rule.effect.kind
    && (rule.scope.requirements.includes(requirementId)
      || (rule.effect.kind === "elective" && String(requirementId).startsWith("eco-elective-"))))?.ruleId || null;
}

function electiveEligibility(code, bundle, context) {
  const canonical = canonicalAllocationCourse(code, bundle);
  const rules = Object.values(bundle.indexes.byRuleId);
  const elective = bundle.indexes.byRuleId["REQ-ECO-ELECTIVES"];
  const maximum = electiveMaximum100(bundle);
  const placeholder = upper(code) === "ECO ELECTIVE";
  if (!(canonical.startsWith(`${elective.effect.subject} `) || placeholder)) return { allowed: false, reasonCode: "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" };
  if (placeholder && Number(context.level100Electives || 0) >= maximum && Number(context.minimumLevel) !== electivePlaceholderMinimumLevel(bundle)) {
    return { allowed: false, reasonCode: "ELECTIVE_PLACEHOLDER_MINIMUM_LEVEL_REQUIRED" };
  }
  const exclusion = rules.find(rule => rule.condition.course === canonical
    && rule.effect.excludedRequirementRuleIds?.includes(elective.ruleId));
  const required = rules.some(rule => rule.ruleType === "requirementDefinition" && rule.effect.kind === "exact" && rule.effect.options?.includes(canonical));
  if (required || exclusion) return { allowed: false, reasonCode: exclusion?.reasonCode || "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT", ruleId: exclusion?.ruleId };
  const pairing = electivePairings(bundle)[canonical];
  if (pairing && !(context.assignments || []).some(item => item.slotId === pairing.slotId && canonicalAllocationCourse(item.code, bundle) === pairing.assignedCode)) {
    return { allowed: false, reasonCode: "ECO_321_REQUIRES_BUSN_323_FINANCE_ALLOCATION" };
  }
  if (/^ECO 1\d\d$/.test(canonical) && Number(context.level100Electives || 0) >= maximum) return { allowed: false, reasonCode: "MAX_ONE_100_LEVEL_ELECTIVE" };
  const catalogCourse = bundle.indexes.coursesByCode?.[canonical];
  if (catalogCourse && Number(catalogCourse.units ?? elective.effect.minimumCourseUnits) < elective.effect.minimumCourseUnits) return { allowed: false, reasonCode: "ELECTIVE_REQUIRES_FULL_COURSE_UNIT" };
  return { allowed: true, reasonCode: "REQUIREMENT_OPTION_MATCH" };
}

export function evaluateRequirementAllocation(course, requirementId, facts, bundle, {
  traceId = decisionTraceId({ course, requirementId, bundle: bundle.contentHash }),
  objectPath = "$",
  assignments = [],
  level100Electives = 0
} = {}) {
  const code = upper(course?.course || course);
  const ruleId = requirementRuleId(requirementId, bundle);
  const rule = bundle.indexes.byRuleId[ruleId];
  if (!rule) return createDecision({ bundle, traceId, status: "REVIEW_REQUIRED", classification: "REVIEW", ruleIds: [], reasonCode: "UNKNOWN_REQUIREMENT", subject: { course: code, requirementId }, objectPath, requiredEvidence: ["CANONICAL_REQUIREMENT_RULE"] });

  let outcome;
  if (REQUIREMENT_PLACEHOLDERS[requirementId] === code) {
    outcome = { allowed: true, reasonCode: "REQUIREMENT_PLACEHOLDER_REQUIRES_CONFIRMATION" };
  } else if (ruleId !== "REQ-ECO-ELECTIVES" && course?.source === "requirement-placeholder" && Array.isArray(course.options)) {
    const options = rule.effect.options || [];
    outcome = {
      allowed: options.every(option => course.options.includes(option)),
      reasonCode: "REQUIREMENT_PLACEHOLDER_OPTIONS_MATCH"
    };
  } else if (ruleId === "REQ-ECO-ELECTIVES") {
    outcome = electiveEligibility(code, bundle, { assignments, level100Electives, minimumLevel: course?.minimumLevel });
  } else {
    outcome = {
      allowed: (rule.effect.options || []).includes(canonicalAllocationCourse(code, bundle)),
      reasonCode: "REQUIREMENT_OPTION_MATCH"
    };
  }
  const controlling = outcome.ruleId ? bundle.indexes.byRuleId[outcome.ruleId] : outcome.reasonCode === "ECO_257_STATISTICS_ONLY"
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

// The caller supplies only full-unit, verified completed course evidence.
export function financeElectivePetitionNotices(completedCourses, bundle) {
  const rule = bundle.indexes.byRuleId["ELECTIVE-ECO-321-FINANCE-ONLY"];
  const notice = rule?.effect.petitionNotice;
  if (!notice || !notice.requiredCompletedCourses.every(code => completedCourses.has(code))) return [];
  return [{
    code: notice.code, title: notice.title, message: bundle.messages[notice.messageKey],
    audience: notice.audience, severity: "info", blocking: false, readinessImpact: "NONE",
    category: "ELECTIVE_PETITION", controllingRuleIds: [rule.ruleId],
    sourceRefs: rule.sourceRefs, policyVersion: bundle.bundleVersion
  }];
}
