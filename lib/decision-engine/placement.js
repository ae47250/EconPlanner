import { createDecision } from "./contracts.js";

export function canonicalTerm(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (["SPRING", "SPRING/MAY", "MAY", "MAY TERM", "SPRING TERM"].includes(normalized)) return "MAY";
  if (["TBC", "TERM TO BE CONFIRMED", "ACADEMIC YEAR TBC"].includes(normalized)) return "TBC";
  return normalized;
}

export function canonicalTermId(term = {}) {
  const key = canonicalTerm(term.termKey || term.canonicalTerm || term.term);
  const match = String(term.academicYear || "").match(/(\d{4})\D+(\d{4})/);
  if (!match || !["FALL", "WINTER", "MAY", "SUMMER", "TBC"].includes(key)) return null;
  if (key === "TBC") return `${match[1]}-${match[2]}-TBC`;
  return `${key === "FALL" ? match[1] : match[2]}-${key}`;
}

function sectionMatches(section, course) {
  if (section.course !== course.course && !(section.crossListedAs || []).includes(course.course)) return false;
  return !course.section || section.sectionId.endsWith(`-${String(course.section).toUpperCase()}`);
}

export function evaluateOffering(course, term, scheduleRelease, bundle, { traceId, objectPath = "$" } = {}) {
  const termId = canonicalTermId(term);
  const source = String(course?.source || "");
  const indexedTerm = scheduleRelease?.[termId];
  if (source === "requirement-placeholder") {
    const rule = bundle.indexes.byRuleId["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"];
    return createDecision({ bundle, traceId, status: "PRELIMINARY", classification: "EVIDENCE", ruleIds: [rule.ruleId], reasonCode: "UNPUBLISHED_OFFERING_TBC", subject: { course: course.course, termId }, objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs });
  }
  if (!indexedTerm && ["future-placeholder", "projected-offering", "recurring-rule-unconfirmed"].includes(source)) {
    return createDecision({
      bundle,
      traceId,
      status: "ALLOW",
      classification: "EVIDENCE",
      ruleIds: ["FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION"],
      reasonCode: "FUTURE_SCHEDULE_PLANNING_PROJECTION",
      subject: {course: course.course, termId, publicationStatus: "PLANNING_PROJECTION"},
      objectPath,
      sourceRefs: ["OWNER-CONFIRMATION-CP4B-B-FOLLOWUP#PLANNING-FLEXIBILITY"]
    });
  }
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
  if (key === "TBC") {
    const rule = bundle.indexes.byRuleId["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"];
    return createDecision({ bundle, traceId, status: "PRELIMINARY", classification: "EVIDENCE", ruleIds: [rule.ruleId], reasonCode: "TERM_LOAD_TO_BE_CONFIRMED", subject: { termId: canonicalTermId(term) }, objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs });
  }
  const rule = bundle.rules.find(candidate => candidate.ruleType === "termLoad" && candidate.condition.canonicalTerm === key);
  if (!rule) return createDecision({ bundle, traceId, status: "UNKNOWN", classification: "REVIEW", ruleIds: [], reasonCode: "TERM_CAPACITY_RULE_MISSING", subject: { termId: canonicalTermId(term) }, objectPath });
  const reservedCourseUnits = Math.max(0, Number(term.reservedCourseUnits || 0));
  const courseCount = (term.courses || []).length + reservedCourseUnits;
  const economicsCount = (term.courses || []).filter(course => String(course.course || "").toUpperCase().startsWith("ECO ")).length;
  if (courseCount > rule.effect.maxTotalCourses || (rule.effect.maxEconomicsCourses && economicsCount > rule.effect.maxEconomicsCourses)) {
    return createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [rule.ruleId], reasonCode: "TERM_CAPACITY_EXCEEDED", subject: { termId: canonicalTermId(term) }, objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs, messageParams: { courseCount, economicsCount, reservedCourseUnits } });
  }
  const preference = bundle.indexes.byRuleId["PLANNING-ECO-LOAD-PREFERENCE"];
  const abovePreference = ["FALL", "WINTER"].includes(key) && economicsCount > preference.effect.preferredMaxEconomicsCourses;
  return createDecision({ bundle, traceId, status: "ALLOW", classification: abovePreference ? "SOFT" : "HARD", severity: abovePreference ? "warning" : "info", ruleIds: [abovePreference ? preference.ruleId : rule.ruleId], reasonCode: abovePreference ? "ECONOMICS_LOAD_ABOVE_PREFERENCE" : "TERM_CAPACITY_AVAILABLE", subject: { termId: canonicalTermId(term) }, objectPath, messageKeys: (abovePreference ? preference : rule).messageKeys, sourceRefs: (abovePreference ? preference : rule).sourceRefs, messageParams: { courseCount, economicsCount, reservedCourseUnits } });
}

export function evaluateCoursePlacement(course, term, planContext, bundle, options = {}) {
  const code = String(course?.course || "").toUpperCase();
  const key = canonicalTerm(term.termKey || term.canonicalTerm || term.term);
  if (["ECO 213", "ECO 214"].includes(code) && key === "MAY") {
    const pattern = bundle.indexes.offeringPatternsById["PLANNING-INTERMEDIATE-OFFERING-SEPARATION"];
    return createDecision({ bundle, traceId: options.traceId, status: "BLOCK", classification: "HARD", ruleIds: [pattern.patternId], reasonCode: "INTERMEDIATE_NOT_OFFERED_IN_MAY", subject: { course: code, termId: canonicalTermId(term) }, objectPath: options.objectPath, sourceRefs: pattern.sourceRefs });
  }
  if (code === "ECO 461" && !["WINTER", "TBC"].includes(key)) {
    const rule = bundle.indexes.byRuleId["CAPSTONE-WINTER-ONLY"];
    return createDecision({ bundle, traceId: options.traceId, status: "BLOCK", classification: "HARD", ruleIds: [rule.ruleId], reasonCode: rule.reasonCode, subject: { course: code, termId: canonicalTermId(term) }, objectPath: options.objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs });
  }
  if (code === "ECO 461" && String(course.residency || "").toLowerCase() !== "hanover") {
    const rule = bundle.indexes.byRuleId["CAPSTONE-HANOVER-RESIDENCY"];
    return createDecision({ bundle, traceId: options.traceId, status: "BLOCK", classification: "HARD", ruleIds: [rule.ruleId], reasonCode: rule.reasonCode, subject: { course: code, termId: canonicalTermId(term) }, objectPath: options.objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs });
  }
  return evaluateOffering(course, term, bundle.indexes.offeringByTerm, bundle, options);
}

export function evaluatePlanningHorizon(term, context = {}, bundle, { traceId, objectPath = "$" } = {}) {
  const key = canonicalTerm(term.termKey || term.canonicalTerm || term.term);
  if (!Number.isInteger(context.startYear) || !Number.isInteger(Number(context.expectedGraduationYear))) {
    return createDecision({ bundle, traceId, status: "REVIEW_REQUIRED", classification: "REVIEW", ruleIds: [], reasonCode: "PLANNING_CONTEXT_REQUIRED", subject: { termId: canonicalTermId(term) }, objectPath, requiredEvidence: ["PLANNING_CONTEXT"] });
  }
  const match = String(term.academicYear || "").match(/(\d{4})\D+(\d{4})/);
  const start = match ? Number(match[1]) : null;
  const yearIndex = Number(term.yearIndex);
  const withinRange = Number.isInteger(start)
    && Number.isInteger(context.startYear)
    && start >= context.startYear
    && start < Number(context.expectedGraduationYear);
  const indexMatches = key === "TBC" && !Number.isInteger(yearIndex)
    ? true
    : Number.isInteger(yearIndex) && start === context.startYear + yearIndex;
  if (!withinRange || !indexMatches || !["FALL", "WINTER", "MAY", "SUMMER", "TBC"].includes(key)) {
    return createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["PLANNING-CURRENT-TERM-EXCLUDED"], reasonCode: "OUTSIDE_GRADUATION_HORIZON", subject: { termId: canonicalTermId(term) }, objectPath });
  }
  const acceleratedFinalYear = context.acceleratedPlanAssumesSeniorStanding === true
    && yearIndex === Number(context.remainingYears) - 1;
  const expectedStanding = acceleratedFinalYear
    ? 3
    : Math.min(3, ["FRESHMAN", "SOPHOMORE", "JUNIOR", "SENIOR"].indexOf(String(context.effectiveStanding || context.standing || "FRESHMAN").toUpperCase()) + yearIndex);
  if (Number.isInteger(term.absoluteStandingIndex) && term.absoluteStandingIndex !== expectedStanding) {
    return createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["CAPSTONE-SENIOR-STANDING"], reasonCode: "PROJECTED_STANDING_MISMATCH", subject: { termId: canonicalTermId(term) }, objectPath });
  }
  return createDecision({ bundle, traceId, status: key === "TBC" ? "PRELIMINARY" : "ALLOW", classification: "HARD", ruleIds: [], reasonCode: key === "TBC" ? "ACADEMIC_YEAR_TERM_TBC" : "PLANNING_HORIZON_MATCH", subject: { termId: canonicalTermId(term) }, objectPath });
}
