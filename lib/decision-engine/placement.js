import { createDecision } from "./contracts.js";
import { plannedCourseUnits, termLoadCapacity } from "../policy/term-load.js";
import { preliminaryEvidenceFor } from "../policy/preliminary-schedule.js";

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

function projectionClaim(bundle, course, termId) {
  const [year, key] = String(termId || "").split("-");
  if (!/^\d{4}$/.test(year) || !["FALL", "WINTER", "MAY"].includes(key)) return null;
  if (["catalog-statement", "recurring-rule-unconfirmed"].includes(course.source)) {
    const capstone = bundle.indexes.byRuleId["CAPSTONE-WINTER-ONLY"];
    if (course.source === "recurring-rule-unconfirmed" && course.course === capstone?.condition.course
      && capstone.effect.allowedCanonicalTerms.includes(key)
      && capstone.effective.from <= `${year}-01-01`
      && (!capstone.effective.through || capstone.effective.through >= `${year}-12-31`)) return capstone;
    const evidenceType = course.source === "catalog-statement" ? "OFFICIAL_CATALOG_STATEMENT" : "DEPARTMENT_RECURRING";
    // Without exact future term dates, require the evidence to cover the whole
    // calendar year. A boundary within that year needs dated evidence, not a guess.
    return Object.values(bundle.indexes.offeringPatternsById || {}).find(pattern => (
      [pattern.course].flat().includes(course.course)
      && pattern.evidenceType === evidenceType && pattern.authorityBoundary
      && pattern.sourceRefs?.length
      && pattern.approvedRecurringTerms?.includes(key)
      && !pattern.hardExcludedTerms?.includes(key)
      && pattern.projectionPolicy?.scheduleCoverage?.some(value => ["UNKNOWN", "UNAVAILABLE"].includes(value))
      && pattern.effective?.from <= `${year}-01-01`
      && (!pattern.effective.through || pattern.effective.through >= `${year}-12-31`)
      && !Object.values(bundle.indexes.offeringPatternsById || {}).some(other => other.supersedes?.includes(pattern.patternId))
    )) || null;
  }
  if (course.source === "historical-pattern") {
    const history = bundle.indexes.historicalOfferingByCourse?.[course.course];
    return history?.activationStatus === "ACTIVE_OWNER_APPROVED" && history.ownerApproval?.approved === true
      && history.conditionalTermDistribution?.[key] !== undefined ? history : null;
  }
  return null;
}

export function evaluateOffering(course, term, scheduleRelease, bundle, { traceId, objectPath = "$" } = {}) {
  const termId = canonicalTermId(term);
  const source = String(course?.source || "");
  const indexedTerm = scheduleRelease?.[termId];
  if (source === "requirement-placeholder") {
    const rule = bundle.indexes.byRuleId["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"];
    return createDecision({ bundle, traceId, status: "PRELIMINARY", classification: "EVIDENCE", ruleIds: [rule.ruleId], reasonCode: "UNPUBLISHED_OFFERING_TBC", subject: { course: course.course, termId }, objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs });
  }
  if (!indexedTerm && ["future-placeholder", "projected-offering", "catalog-statement", "historical-pattern", "recurring-rule-unconfirmed"].includes(source)) {
    const claim = projectionClaim(bundle, course, termId);
    if (["catalog-statement", "historical-pattern", "recurring-rule-unconfirmed"].includes(source) && !claim) {
      return createDecision({ bundle, traceId, status: "UNKNOWN", classification: "EVIDENCE", ruleIds: [], reasonCode: "PROJECTION_EVIDENCE_OUT_OF_SCOPE", subject: { course: course.course, termId }, objectPath });
    }
    const preliminary = preliminaryEvidenceFor(bundle, termId, course.course);
    return createDecision({
      bundle,
      traceId,
      status: "ALLOW",
      classification: "EVIDENCE",
      ruleIds: [preliminary ? "PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY" : "FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION"],
      reasonCode: preliminary ? "PRELIMINARY_SCHEDULE_COURSE_TERM" : "FUTURE_SCHEDULE_PLANNING_PROJECTION",
      subject: {course: course.course, termId, publicationStatus: "PLANNING_PROJECTION"},
      objectPath,
      sourceRefs: preliminary?.sourceRefs || claim?.sourceRefs || ["OWNER-PRELIMINARY-SCHEDULE-2026-09-22"],
      offeringEvidence: preliminary ? { preliminarySchedule: preliminary } : claim ? { projectionPatternId: claim.patternId } : {}
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
  const courseUnits = plannedCourseUnits(term.courses) + reservedCourseUnits;
  const economicsCount = (term.courses || []).filter(course => String(course.course || "").toUpperCase().startsWith("ECO ")).length;
  const capacity = termLoadCapacity(bundle, term);
  if (courseUnits > capacity.conditionalMaximumCourseUnits || (rule.effect.maxEconomicsCourses && economicsCount > rule.effect.maxEconomicsCourses)) {
    return createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [rule.ruleId], reasonCode: "TERM_CAPACITY_EXCEEDED", subject: { termId: canonicalTermId(term) }, objectPath, messageKeys: rule.messageKeys, sourceRefs: rule.sourceRefs, messageParams: { courseCount, courseUnits, economicsCount, reservedCourseUnits } });
  }
  if (courseUnits > capacity.normalCourseUnits && !capacity.overloadApproved) {
    const probation = term.termLoadEvidence?.academicProbationStatus === "ON_ACADEMIC_PROBATION";
    return createDecision({
      bundle,
      traceId,
      status: "BLOCK",
      classification: "HARD",
      ruleIds: [rule.ruleId],
      reasonCode: probation ? "TERM_OVERLOAD_NOT_ALLOWED_ON_ACADEMIC_PROBATION" : "TERM_OVERLOAD_EVIDENCE_REQUIRED",
      subject: { termId: canonicalTermId(term) },
      objectPath,
      messageKeys: rule.messageKeys,
      sourceRefs: rule.sourceRefs,
      requiredEvidence: ["ADVISOR_OVERLOAD_APPROVAL", "NOT_ON_ACADEMIC_PROBATION"],
      messageParams: { courseCount, courseUnits, economicsCount, reservedCourseUnits }
    });
  }
  const preference = bundle.indexes.byRuleId["PLANNING-ECO-LOAD-PREFERENCE"];
  const abovePreference = ["FALL", "WINTER"].includes(key) && economicsCount > preference.effect.preferredMaxEconomicsCourses;
  const overloadUsed = courseUnits > capacity.normalCourseUnits;
  return createDecision({ bundle, traceId, status: overloadUsed ? "CONDITIONAL" : "ALLOW", classification: abovePreference ? "SOFT" : "HARD", severity: abovePreference || overloadUsed ? "warning" : "info", ruleIds: [abovePreference ? preference.ruleId : rule.ruleId], reasonCode: overloadUsed ? "TERM_OVERLOAD_APPROVED" : abovePreference ? "ECONOMICS_LOAD_ABOVE_PREFERENCE" : "TERM_CAPACITY_AVAILABLE", subject: { termId: canonicalTermId(term) }, objectPath, messageKeys: (abovePreference ? preference : rule).messageKeys, sourceRefs: (abovePreference ? preference : rule).sourceRefs, messageParams: { courseCount, courseUnits, economicsCount, reservedCourseUnits } });
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
