import { createDecision } from "./contracts.js";

export function canonicalTerm(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (["SPRING", "SPRING/MAY", "MAY", "MAY TERM", "SPRING TERM"].includes(normalized)) return "MAY";
  return normalized;
}

export function canonicalTermId(term = {}) {
  const key = canonicalTerm(term.termKey || term.canonicalTerm || term.term);
  const match = String(term.academicYear || "").match(/(\d{4})\D+(\d{4})/);
  if (!match || !["FALL", "WINTER", "MAY", "SUMMER"].includes(key)) return null;
  return `${key === "FALL" ? match[1] : match[2]}-${key}`;
}

function sectionMatches(section, course) {
  if (section.course !== course.course && !(section.crossListedAs || []).includes(course.course)) return false;
  return !course.section || section.sectionId.endsWith(`-${String(course.section).toUpperCase()}`);
}

export function evaluateOffering(course, term, scheduleRelease, bundle, { traceId, objectPath = "$" } = {}) {
  const termId = canonicalTermId(term);
  const source = String(course?.source || "");
  if (["future-placeholder", "projected-offering", "recurring-rule-unconfirmed", "requirement-placeholder"].includes(source)) {
    const rule = bundle.indexes.byRuleId["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"];
    return createDecision({ bundle, traceId, status: "PRELIMINARY", classification: "EVIDENCE", ruleIds: [rule.ruleId], reasonCode: "UNPUBLISHED_OFFERING_TBC", subject: { course: course.course, termId }, objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs });
  }
  const indexedTerm = scheduleRelease?.[termId];
  if (!indexedTerm) return createDecision({ bundle, traceId, status: "UNKNOWN", classification: "EVIDENCE", ruleIds: [], reasonCode: "SCHEDULE_TERM_NOT_COVERED", subject: { course: course.course, termId }, objectPath });
  const section = indexedTerm.sections.find(candidate => sectionMatches(candidate, course));
  if (!section) {
    return createDecision({ bundle, traceId, status: indexedTerm.coverage === "COMPLETE" ? "BLOCK" : "UNKNOWN", classification: "EVIDENCE", ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"], reasonCode: indexedTerm.coverage === "COMPLETE" ? "NOT_OFFERED_IN_COMPLETE_SCHEDULE" : "OFFERING_UNKNOWN", subject: { course: course.course, termId }, objectPath, offeringEvidence: { scheduleCoverage: indexedTerm.coverage } });
  }
  const behavior = bundle.indexes.byRuleId["SCHEDULE-AVAILABILITY-BEHAVIOR"];
  const state = section.enrollmentState;
  const mapped = behavior.effect[state] || "UNKNOWN";
  const status = mapped === "VERIFIED" ? "ALLOW" : mapped === "BLOCK" ? "BLOCK" : mapped === "CONDITIONAL" ? "CONDITIONAL" : mapped === "PRELIMINARY" ? "PRELIMINARY" : mapped;
  return createDecision({ bundle, traceId, status, classification: "EVIDENCE", ruleIds: [behavior.ruleId], reasonCode: `ENROLLMENT_${state}`, subject: { course: course.course, termId }, objectPath, messageKeys: behavior.messageKeys, sourceRefs: [...behavior.sourceRefs, ...section.sourceRefs], offeringEvidence: { offeringExistence: section.offeringExistence, enrollmentState: state, scheduleCoverage: indexedTerm.coverage, sectionId: section.sectionId } });
}

export function evaluateTermLoad(term, planContext, bundle, { traceId, objectPath = "$" } = {}) {
  const key = canonicalTerm(term.termKey || term.term);
  const rule = bundle.rules.find(candidate => candidate.ruleType === "termLoad" && candidate.condition.canonicalTerm === key);
  if (!rule) return createDecision({ bundle, traceId, status: "UNKNOWN", classification: "REVIEW", ruleIds: [], reasonCode: "TERM_CAPACITY_RULE_MISSING", subject: { termId: canonicalTermId(term) }, objectPath });
  const courseCount = (term.courses || []).length;
  const economicsCount = (term.courses || []).filter(course => String(course.course || "").startsWith("ECO ") || course.course === "ECO elective").length;
  if (courseCount > rule.effect.maxTotalCourses || (rule.effect.maxEconomicsCourses && economicsCount > rule.effect.maxEconomicsCourses)) {
    return createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [rule.ruleId], reasonCode: "TERM_CAPACITY_EXCEEDED", subject: { termId: canonicalTermId(term) }, objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs, messageParams: { courseCount, economicsCount } });
  }
  const preference = bundle.indexes.byRuleId["PLANNING-ECO-LOAD-PREFERENCE"];
  const abovePreference = ["FALL", "WINTER"].includes(key) && economicsCount > preference.effect.preferredMaxEconomicsCourses;
  return createDecision({ bundle, traceId, status: "ALLOW", classification: abovePreference ? "SOFT" : "HARD", severity: abovePreference ? "warning" : "info", ruleIds: [abovePreference ? preference.ruleId : rule.ruleId], reasonCode: abovePreference ? "ECONOMICS_LOAD_ABOVE_PREFERENCE" : "TERM_CAPACITY_AVAILABLE", subject: { termId: canonicalTermId(term) }, objectPath, messageKeys: (abovePreference ? preference : rule).messageKeys, sourceRefs: (abovePreference ? preference : rule).sourceRefs, messageParams: { courseCount, economicsCount } });
}

export function evaluateCoursePlacement(course, term, planContext, bundle, options = {}) {
  return evaluateOffering(course, term, bundle.indexes.offeringByTerm, bundle, options);
}
