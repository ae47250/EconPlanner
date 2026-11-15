import { extraCourseError, extraCourseChoices } from "./extra-courses.js";
import { courseOfferingInformation } from "./plan-notes.js";
import { requirementOptions, electiveMaximum100, electivePlaceholderMinimumLevel } from "../policy/requirement-choices.js";
import { canonicalTerm, canonicalTermId, courseTermEligibility, evaluateTermLoad } from "../decision-engine/placement.js";
import { buildEarlyGraduationContext, buildPlanningSlots, resolvePlanningContext, selectedPlanContext } from "./horizon.js";
import { isPlanningStrategyEligible } from "./strategyEligibility.js";
import { evaluatePlan as evaluatePolicyPlan } from "../decision-engine/plan.js";
import { normalizeStudentFacts } from "../decision-engine/student-facts.js";
import { resolveCatalogApplicability } from "../catalog/applicability.js";
import { prerequisitesForCatalogYear } from "../catalog/policy-releases.js";
import { economicsPlanningStrategyContract } from "../catalog/policy-releases.js";
import { loadEconomicsPolicyCompatibility, runtimeEconomicsSchedule, runtimePolicyBundle } from "../policy/compat-normalized.js";
import {termLoadCapacity, termLoadEvidenceForSlot, plannedCourseUnits, termLoadMessage, termLoadTuitionAdvisories} from "../policy/term-load.js";
import { annotatePreliminaryScheduleEvidence } from "../policy/preliminary-schedule.js";
import { scheduleCoverageForCourse } from "../policy/schedule-coverage.js";
import { buildDegreeDesignationInformation } from "./degree-designations.js";
import { buildEconomicsPlanNotes } from "./plan-notes.js";
import { buildMajorRequirementsChecklist, buildPlanConditions, studentFacingPlanReviewMessage } from "./plan-presentation.js";
import { seatStatusPresentation } from "./seat-status.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";
import {
  canonicalScheduleCode,
  availabilityIsStale,
  meetingsConflict,
  normalizeEconomicsSchedule,
  scheduleOfferings,
  selectConflictFreeOffering
} from "./scheduleProvider.js";
import { buildPrerequisiteStatusNotices, evaluatePlanPrerequisites } from "./prerequisiteEvaluator.js";
import { economicsReplacementCandidates, applyEconomicsPlanEdit, annotateEconomicsMoveDestinations, solveEconomicsTermPlan, TERM_SOLVER_NODE_LIMIT, TERM_SOLVER_SOLUTION_BUDGET } from "./termSolver.js";
import {
  buildCapacityAwareDistribution,
  plannerTrackedTermLoad,
  plannerTrackedYearLoads,
  termShapePenalty
} from "./distribution.js";

export { exploreAnnualTargets as explorePreferredYearTargets } from "./distribution.js";
import {
  buildRequirementAllocation,
  requirementAllocationSummary
} from "./requirementAllocation.js";
import {
  buildPlanNotices,
  courseScheduleProvenance,
  planPublicationStatus,
  SCHEDULE_PROVENANCE
} from "./notices.js";

const LEGACY_TERM_ORDER = ["Fall", "Winter", "May"];
const PLANNING_TERM_INDEX = new Map(["Fall", "Winter", "Spring", "May", "Summer"].map((term, index) => [term, index]));
const STANDING_INDEX = { freshman: 0, sophomore: 1, junior: 2, senior: 3 };
const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const STATISTICS_REQUIREMENT = "Statistics requirement";
const STATISTICS_OPTIONS = requirementOptions(runtimePolicyBundle(), "statistics");
const MATH_OPTIONS = requirementOptions(runtimePolicyBundle(), "cognate");
const SUPPORTING_REQUIREMENT_PLACEHOLDERS = new Map([
  [STATISTICS_REQUIREMENT, "statistics"],
  ["Mathematics cognate", "cognate"],
  ["Finance requirement", "finance"]
]);
const STRATEGY_CONTRACT = economicsPlanningStrategyContract();

function strategyVariantFromPolicy(id) {
  const strategy = STRATEGY_CONTRACT.strategies.find(item => item.id === id);
  if (!strategy) throw new Error(`Missing compiled Economics planning strategy ${id}.`);
  return Object.freeze({
    id: strategy.id,
    label: strategy.publicLabel,
    strategy: strategy.id,
    description: strategy.definition,
    eligibility: strategy.eligibility,
    rankingPreferences: strategy.rankingPreferences
  });
}

const PLAN_VARIANTS = [
  strategyVariantFromPolicy("balanced"),
  strategyVariantFromPolicy("explore-first")
];

function catalogYearFromBundle(policyBundle) {
  const match = String(policyBundle?.bundleVersion || "").match(/(\d{4}-\d{4})/);
  return match?.[1] || null;
}

function withCatalogApplicability(context, student, policyBundle, supplied = null) {
  const release = catalogYearFromBundle(policyBundle);
  return {
    ...context,
    catalogApplicability: supplied || context?.catalogApplicability || resolveCatalogApplicability({
      majorDeclarationCatalogYear: context?.majorDeclarationCatalogYear || student?.majorDeclarationCatalogYear,
      entryCatalogYear: context?.entryCatalogYear,
      currentCatalogYear: context?.currentCatalogYear,
      availableCatalogYears: release ? [release] : [],
      sourceRefs: [policyBundle?.releaseRefs?.catalog, release ? `POLICY-RELEASE#${release}` : null].filter(Boolean)
    })
  };
}
const EARLY_GRADUATION_VARIANT = strategyVariantFromPolicy("one-year-early");
export const FEASIBILITY_STATUS = Object.freeze({
  VERIFIED: "VERIFIED_FEASIBLE",
  CONDITIONAL: "CONDITIONALLY_FEASIBLE",
  PRELIMINARY: "PRELIMINARY_ONLY",
  SEARCH_INCOMPLETE: "SEARCH_INCOMPLETE",
  NOT_FEASIBLE: "NOT_FEASIBLE"
});
export const SEARCH_INCOMPLETE_MESSAGE = "The planner could not finish checking all possible course arrangements. This does not mean that completion is impossible. The schedule requires another planning attempt or advisor review.";
const REQUIREMENT_PLANNING_PRIORITY = new Map([
  ["eco-113", 1],
  ["eco-114", 2],
  ["cognate", 3],
  ["statistics", 4],
  ["finance", 5],
  ["eco-213", 6],
  ["eco-214", 7],
  ["eco-elective-1", 8],
  ["eco-elective-2", 9],
  ["eco-elective-3", 10],
  ["eco-elective-4", 11],
  ["eco-461", 12]
]);

function is100LevelEconomicsCourse(code) {
  return /^ECO 1\d{2}$/.test(String(code || "").trim());
}

export function assigned100LevelElectives(mapping = {}) {
  return [...new Set((mapping.assignments || [])
    .filter(assignment => (
      String(assignment.slotId || "").startsWith("eco-elective")
      && is100LevelEconomicsCourse(assignment.code)
    ))
    .map(assignment => assignment.code))];
}

function legacySlots() {
  return LEGACY_TERM_ORDER.map((termKey, index) => ({
    id: termKey.toLowerCase(),
    termKey,
    scheduleTerm: termKey,
    label: termKey,
    displayTerm: termKey === "May" ? "Spring/May" : termKey,
    academicYear: null,
    yearIndex: 0,
    absoluteStandingIndex: 3,
    isSummer: false,
    order: index
  }));
}

function normalizedAcademicYear(value) {
  return value ? String(value).replace(/-/g, "/") : null;
}

function normalizedTermKey(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(spring(?:\/may)?|may)(?:\s|$)/.test(normalized)) return "Spring";
  if (/^fall(?:\s|$)/.test(normalized)) return "Fall";
  if (/^winter(?:\s|$)/.test(normalized)) return "Winter";
  if (/^summer(?:\s|$)/.test(normalized)) return "Summer";
  if (["tbc", "term to be confirmed"].includes(normalized)) return "TBC";
  return null;
}

function normalizedDays(value) {
  const aliases = new Map([
    ["mon", "Mon"], ["monday", "Mon"],
    ["tue", "Tue"], ["tues", "Tue"], ["tuesday", "Tue"],
    ["wed", "Wed"], ["wednesday", "Wed"],
    ["thu", "Thu"], ["thur", "Thu"], ["thurs", "Thu"], ["thursday", "Thu"],
    ["fri", "Fri"], ["friday", "Fri"]
  ]);
  const days = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(days
    .map(day => aliases.get(String(day).trim().toLowerCase()) || String(day).trim())
    .filter(Boolean))].sort();
}

function normalizedTimeMinutes(value, fallback) {
  const cleaned = String(value || "").trim().replaceAll(".", "");
  const twelveHour = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]) % 12;
    if (twelveHour[3].toUpperCase() === "PM") hour += 12;
    return hour * 60 + Number(twelveHour[2]);
  }
  const twentyFourHour = cleaned.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFourHour) return Number(twentyFourHour[1]) * 60 + Number(twentyFourHour[2]);
  return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
}

function normalizedAvailabilityStatus(value) {
  const status = String(value || "unknown").trim().toLowerCase();
  if (["full", "closed"].includes(status)) return status;
  if (["waitlist", "waitlisted"].includes(status)) return "waitlisted";
  return status === "open" ? "open" : "unknown";
}

function normalizedSourceFiles(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => String(item).trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .sort();
}

function scheduleIntegrityErrors(course, canonicalOffering, term, schedule) {
  if (!canonicalOffering || !["verified-offering", "summer-last-resort"].includes(course.source)) return [];
  const mismatches = [];
  const noteMismatch = field => mismatches.push(`${course.course}-${course.section} does not match the canonical verified schedule for ${field}.`);
  const canonicalCourse = canonicalScheduleCode(schedule, course.course);
  if (canonicalCourse !== canonicalOffering.course) noteMismatch("course identity");
  if (String(course.section || "").trim() !== String(canonicalOffering.section || "").trim()) noteMismatch("section");
  if (normalizedAcademicYear(course.academicYear) !== normalizedAcademicYear(canonicalOffering.academicYear)) noteMismatch("academic year");
  if (normalizedTermKey(course.term) !== normalizedTermKey(canonicalOffering.term)) noteMismatch("term");
  if (normalizedAcademicYear(term.academicYear) !== normalizedAcademicYear(canonicalOffering.academicYear)
    || normalizedTermKey(term.scheduleTerm || term.termKey) !== normalizedTermKey(canonicalOffering.term)) {
    noteMismatch("plan term");
  }

  const meeting = course.meeting || {};
  const canonicalMeeting = canonicalOffering.meeting || {};
  if (canonicalMeeting.days?.length
    && JSON.stringify(normalizedDays(meeting.days)) !== JSON.stringify(normalizedDays(canonicalMeeting.days))) {
    noteMismatch("meeting days");
  }
  if (normalizedTimeMinutes(canonicalMeeting.startTime, canonicalMeeting.startMinutes) !== null
    && normalizedTimeMinutes(meeting.startTime, meeting.startMinutes)
      !== normalizedTimeMinutes(canonicalMeeting.startTime, canonicalMeeting.startMinutes)) {
    noteMismatch("meeting start time");
  }
  if (normalizedTimeMinutes(canonicalMeeting.endTime, canonicalMeeting.endMinutes) !== null
    && normalizedTimeMinutes(meeting.endTime, meeting.endMinutes)
      !== normalizedTimeMinutes(canonicalMeeting.endTime, canonicalMeeting.endMinutes)) {
    noteMismatch("meeting end time");
  }

  const availability = course.availability || {};
  const canonicalAvailability = canonicalOffering.availability || {};
  if (normalizedAvailabilityStatus(availability.status) !== normalizedAvailabilityStatus(canonicalAvailability.status)) {
    noteMismatch("availability status");
  }
  for (const field of ["seatsOpen", "capacity"]) {
    if (Number.isFinite(canonicalAvailability[field]) && Number(availability[field]) !== canonicalAvailability[field]) {
      noteMismatch(`availability ${field}`);
    }
  }

  if (String(course.verificationStatus || "").trim().toLowerCase()
    !== String(canonicalOffering.verificationStatus || "").trim().toLowerCase()) {
    noteMismatch("verification status");
  }
  const provenance = course.provenance || {};
  const canonicalProvenance = canonicalOffering.provenance || {};
  for (const field of [
    "sourceType",
    "sourceDocumentDate",
    "screenshotRetrievedOn",
    "repositoryIngestedOn",
    "humanVerifiedOn",
    "verifiedOn",
    "normalizationCheck"
  ]) {
    if (canonicalProvenance[field] != null
      && String(provenance[field] ?? "").trim() !== String(canonicalProvenance[field]).trim()) {
      noteMismatch(`provenance ${field}`);
    }
  }
  if (canonicalProvenance.sourceFiles?.length
    && JSON.stringify(normalizedSourceFiles(provenance.sourceFiles))
      !== JSON.stringify(normalizedSourceFiles(canonicalProvenance.sourceFiles))) {
    noteMismatch("provenance source files");
  }
  return mismatches;
}

function planningHorizonErrors(plan, context) {
  const startYear = Number(context?.startYear);
  const graduationYear = Number(context?.expectedGraduationYear);
  if (!Number.isInteger(startYear) || !Number.isInteger(graduationYear) || graduationYear <= startYear) return [];
  const errors = [];
  const allowedSlots = context?.hasExplicitDate
    ? buildPlanningSlots(context)
    : [];
  const allowedByIdentity = new Map(allowedSlots.map(slot => [
    `${normalizedAcademicYear(slot.academicYear)}:${normalizedTermKey(slot.termKey)}`,
    slot
  ]));
  const allowedStandingByYearIndex = new Map();
  for (const slot of allowedSlots) {
    if (!allowedStandingByYearIndex.has(slot.yearIndex)) {
      allowedStandingByYearIndex.set(slot.yearIndex, slot);
    }
  }

  for (const term of plan?.terms || []) {
    const academicYear = normalizedAcademicYear(term.academicYear);
    const yearMatch = academicYear?.match(/^(\d{4})\/(\d{4})$/);
    const academicStart = yearMatch && Number(yearMatch[2]) === Number(yearMatch[1]) + 1
      ? Number(yearMatch[1])
      : null;
    const termKey = normalizedTermKey(term.termKey || term.scheduleTerm || term.term);
    const yearIndex = Number(term.yearIndex);
    const hasYearIndex = Number.isInteger(yearIndex);
    const withinYearRange = Number.isInteger(academicStart)
      && academicStart >= startYear
      && academicStart < graduationYear;
    const consistentYearIndex = termKey === "TBC" && !hasYearIndex
      ? true
      : hasYearIndex
        && yearIndex >= 0
        && yearIndex < graduationYear - startYear
        && academicStart === startYear + yearIndex;

    if (!withinYearRange || !consistentYearIndex || !termKey) {
      errors.push(`${term.term || "A planned term"} is outside the authoritative graduation planning horizon.`);
      continue;
    }
    const authoritativeYearSlot = allowedStandingByYearIndex.get(yearIndex);
    if (allowedSlots.length
      && (!authoritativeYearSlot
        || Number(term.absoluteStandingIndex) !== Number(authoritativeYearSlot.absoluteStandingIndex))) {
      errors.push(`${term.term || "A planned term"} does not match its authoritative projected standing.`);
    }
    if (authoritativeYearSlot
      && term.seniorStandingBasis
      && term.seniorStandingBasis !== authoritativeYearSlot.seniorStandingBasis) {
      errors.push(`${term.term || "A planned term"} has an invalid senior-standing basis.`);
    }
    if (termKey === "TBC") {
      if (!term.isPlaceholder
        || (term.slotId && term.slotId !== `term-to-confirm-${academicYear}`)) {
        errors.push(`${term.term || "A planned term"} is not a valid planning-horizon placeholder.`);
      }
      continue;
    }
    if (termKey === "Summer" && academicStart >= graduationYear - 1) {
      errors.push(`${term.term || "A planned term"} occurs after the final permitted planning slot.`);
      continue;
    }

    const identity = `${academicYear}:${termKey}`;
    const allowedSlot = allowedByIdentity.get(identity);
    if (allowedSlots.length && !allowedSlot) {
      errors.push(`${term.term || "A planned term"} is outside the resolved planning horizon.`);
      continue;
    }
    const calendarYear = academicStart + (termKey === "Fall" ? 0 : 1);
    const expectedSlotId = `${termKey.toLowerCase()}-${calendarYear}`;
    const expectedTerm = termKey === "Spring" ? `Spring/May ${calendarYear}` : `${termKey} ${calendarYear}`;
    if (term.slotId !== (allowedSlot?.id || expectedSlotId)
      || normalizedTermKey(term.term) !== termKey
      || !String(term.term || "").includes(String(calendarYear))
      || (termKey === "Spring" && normalizedTermKey(expectedTerm) !== normalizedTermKey(term.term))) {
      errors.push(`${term.term || "A planned term"} does not match its authoritative planning slot.`);
    }
  }
  return errors;
}

function plannerTrackedYearLoad(plan, yearIndex = 0) {
  return plannerTrackedYearLoads(plan)[yearIndex] || 0;
}

function buildDistribution(total, context, variant, slots = [], strategyBaseline = null) {
  if (!context) {
    return {
      strategy: variant.strategy,
      targetYearCounts: [total],
      targetYears: [{ yearIndex: 0, standing: "senior", targetCount: total }],
      targetTermCounts: Object.fromEntries(slots.map(slot => [slot.id, Math.ceil(total / Math.max(1, slots.length))]))
    };
  }

  const balancedFirstYearTarget = strategyBaseline?.distribution?.targetYearCounts?.[
    Number(variant.eligibility?.firstPlannedYearIndex || 0)
  ] ?? (strategyBaseline ? plannerTrackedYearLoad(strategyBaseline, 0) : null);
  const distribution = buildCapacityAwareDistribution({
    unresolvedCount: total,
    yearCount: context.remainingYears,
    slots,
    strategy: variant.strategy,
    balancedFirstYearTarget,
    preferences: variant.rankingPreferences
  });
  return {
    ...distribution,
    ...(strategyBaseline ? {
      baselineStrategyId: strategyBaseline.id,
      baselineFirstYearTrackedLoad: plannerTrackedYearLoad(strategyBaseline, 0)
    } : {}),
    targetYears: distribution.targetYears.map(item => ({
      ...item,
      standing: context.isTransferStudent
        ? STANDING_ORDER[Math.max(0, 4 - (context.remainingYears - item.yearIndex))]
        : STANDING_ORDER[Math.min(3, STANDING_INDEX[context.effectiveStanding] + item.yearIndex)]
    }))
  };
}

function prerequisiteOptionAvailable(availableCodes, option) {
  return availableCodes.has(option);
}

function prerequisiteGroupSatisfied(availableCodes, group) {
  if (group.some(option => prerequisiteOptionAvailable(availableCodes, option))) return true;
  return group.every(option => STATISTICS_OPTIONS.includes(option))
    && availableCodes.has(STATISTICS_REQUIREMENT);
}

function prerequisiteMissing(code, completedCodes, prerequisites, term = null) {
  const catalogYear = String(term?.academicYear || term?.catalogYear || "").replace("/", "-");
  const applicablePrerequisites = prerequisitesForCatalogYear(prerequisites, catalogYear);
  const rule = applicablePrerequisites?.[code];
  if (!rule) return [];
  const missing = (rule.all || []).filter(item => !prerequisiteOptionAvailable(completedCodes, item));
  for (const group of rule.any || []) {
    if (!prerequisiteGroupSatisfied(completedCodes, group)) missing.push(group.join(" / "));
  }
  return missing;
}

function isAfterCurrentPlanningTerm(term, context) {
  if (!context) return true;
  if (context.isSummer) return true;
  if ((term.yearIndex ?? 0) > 0) return true;
  if (term.isPlaceholder) return term.inProgressPrerequisitesAvailable === true;
  const termIndex = PLANNING_TERM_INDEX.get(term.termKey);
  return Number.isInteger(termIndex) && termIndex > context.startTermIndex;
}

function concurrentPrerequisiteAssessment(code, availableCodes, sameTermCodes, prerequisites, term = null) {
  const catalogYear = String(term?.academicYear || term?.catalogYear || "").replace("/", "-");
  const applicablePrerequisites = prerequisitesForCatalogYear(prerequisites, catalogYear);
  const rule = applicablePrerequisites?.[code];
  if (!rule) return { missing: [], approvals: [] };

  const missing = [];
  const approvals = [];

  for (const required of rule.all || []) {
    if (prerequisiteOptionAvailable(availableCodes, required)) continue;
    const policy = (rule.concurrentWithApproval || []).find(item => (item.options || []).includes(required));
    const options = policy?.options || [];
    const concurrentOptions = options.filter(item => sameTermCodes.has(item));
    const completedOptions = options.filter(item => availableCodes.has(item));
    const concurrentAllowed = policy
      && sameTermCodes.has(required)
      && (!policy.maxConcurrent || concurrentOptions.length <= policy.maxConcurrent)
      && (!policy.requiresCompletedFromOptions || completedOptions.length >= policy.requiresCompletedFromOptions);
    if (!concurrentAllowed) {
      missing.push(required);
      continue;
    }
    approvals.push({
      type: policy.approval || "department",
      reason: policy.reason || "concurrent_prerequisite",
      prerequisite: required,
      policySource: policy.policySource || "department-confirmed-local-policy"
    });
  }

  for (const group of rule.any || []) {
    if (prerequisiteGroupSatisfied(availableCodes, group)) continue;
    const policy = (rule.concurrentWithApproval || []).find(item => (
      group.some(option => (item.options || []).includes(option))
    ));
    const concurrentCode = policy
      ? group.find(item => sameTermCodes.has(item) && (policy.options || []).includes(item))
      : null;
    if (!concurrentCode) {
      missing.push(group.join(" / "));
      continue;
    }
    approvals.push({
      type: policy.approval || "instructor",
      reason: policy.reason || "concurrent_math",
      prerequisite: concurrentCode,
      policySource: policy.policySource || "department-approved"
    });
  }

  return { missing, approvals };
}

function isEconomicCourse(code) {
  return String(code).startsWith("ECO ");
}

function isSeniorWinterOnly(code, slot, student, context, bundle = runtimePolicyBundle()) {
  const termRule = bundle.indexes.byRuleId["CAPSTONE-WINTER-ONLY"];
  const standingRule = bundle.indexes.byRuleId["CAPSTONE-SENIOR-STANDING"];
  if (code !== termRule.condition.course) return true;
  if (!termRule.effect.allowedCanonicalTerms.includes(canonicalTerm(slot.termKey))) return false;
  if (context) return slot.absoluteStandingIndex >= standingRule.effect.normalStandingBeginsCollegeYear - 1;
  return String(student.academicStanding || "").toUpperCase() === standingRule.effect.requiredStanding;
}

function canCountCompletedCourse(course) {
  const rule = runtimePolicyBundle().indexes.byRuleId["CAPSTONE-HANOVER-RESIDENCY"];
  if (course.code !== rule.condition.course || rule.effect.transferEquivalencyPermitted) return true;
  return !["transfer", "uncertain"].includes(course.status);
}

function canonicalPlanningRuleSummaries(bundle = runtimePolicyBundle()) {
  const constraints = loadEconomicsPolicyCompatibility().planningConstraints;
  const elective = bundle.indexes.byRuleId["REQ-ECO-ELECTIVES"];
  const statistics = bundle.indexes.byRuleId["PREREQ-ECO-461"];
  return [
    ...constraints.hardRules,
    ...constraints.advisingPreferences,
    ...Object.values(constraints.offeringPatterns),
    `${elective.effect.slotCount} distinct Economics elective slots are required; at most ${electiveMaximum100(bundle)} may use a 100-level course.`,
    `${statistics.effect.oneOfGroups[0].join(" / ")} must be completed before ${statistics.condition.course}.`
  ];
}

function termCapacity(slot, _planningMode = "standard") {
  const reserved = Math.max(0, Number(slot.reservedCourseUnits || 0));
  const load = termLoadCapacity(runtimePolicyBundle(), slot);
  const total = Math.max(0, load.activeCourseUnits - reserved);
  if (slot.isPlaceholder) return {
    total,
    economics: Infinity
  };
  if (slot.termKey === "Spring" || slot.termKey === "May" || slot.termKey === "Summer") {
    return { total, economics: 1 };
  }
  return {
    total,
    economics: Infinity
  };
}

function canUseSlot(plan, slot, code, planningMode = "standard") {
  if (slot.newCoursesAllowed === false) return false;
  const capacity = termCapacity(slot, planningMode);
  if (plan.courses.length >= capacity.total) return false;
  if (isEconomicCourse(code) && plan.courses.filter(course => isEconomicCourse(course.course)).length >= capacity.economics) return false;
  return true;
}

function availableBeforeSlot(termPlans, slotIndex, completedCodes, inProgressCodes = new Set(), context = null) {
  const available = new Set(completedCodes);
  if (isAfterCurrentPlanningTerm(termPlans[slotIndex], context)) {
    for (const code of inProgressCodes) available.add(code);
  }
  for (const plan of termPlans.slice(0, slotIndex)) {
    for (const course of plan.courses) {
      if (course.course && course.course !== "ECO elective") available.add(course.course);
    }
  }
  return available;
}

function preferredSlotOrder(slots, context, distribution, yearCounts, termCounts) {
  if (!context) return [...slots].sort((a, b) => a.order - b.order);

  return [...slots].sort((a, b) => {
    const aTarget = distribution.targetYearCounts[a.yearIndex] ?? 0;
    const bTarget = distribution.targetYearCounts[b.yearIndex] ?? 0;
    const aOpen = (yearCounts.get(a.yearIndex) || 0) < aTarget ? 0 : 1;
    const bOpen = (yearCounts.get(b.yearIndex) || 0) < bTarget ? 0 : 1;
    const aTermTarget = distribution.termTargetCeilings?.[a.id] ?? distribution.targetTermCounts[a.id] ?? aTarget;
    const bTermTarget = distribution.termTargetCeilings?.[b.id] ?? distribution.targetTermCounts[b.id] ?? bTarget;
    const aTermOpen = (termCounts.get(a.id) || 0) < aTermTarget ? 0 : 1;
    const bTermOpen = (termCounts.get(b.id) || 0) < bTermTarget ? 0 : 1;
    return aOpen - bOpen || aTermOpen - bTermOpen || a.yearIndex - b.yearIndex || a.order - b.order;
  });
}

function addAdvisorCheck(advisorChecks, check) {
  if (!advisorChecks.some(item => item.course === check.course && item.term === check.term && item.reason === check.reason)) {
    advisorChecks.push(check);
  }
}

function fixedInProgressCourses(student, mapping, courseCatalog = []) {
  const assignmentByCode = new Map((mapping?.assignments || [])
    .filter(item => item.status === "in_progress")
    .map(item => [item.code, item]));
  const titleByCode = new Map(courseCatalog.map(course => [course.code, course.title]));
  return normalizeStudentCourses(student.courses)
    .filter(course => course.status === "in_progress")
    .map(course => {
      const assignment = assignmentByCode.get(course.code);
      return {
        course: course.code,
        title: course.title || titleByCode.get(course.code) || course.code,
        units: Number(course.units || 1),
        source: "student-in-progress",
        fixedInProgress: true,
        plannerTracked: Boolean(assignment),
        trackedRequirementId: assignment?.slotId || null,
        studentStatus: "in_progress"
      };
    });
}

function planSlotsFor(student, planningContext, mapping = null, courseCatalog = [], policyBundle = runtimePolicyBundle()) {
  if (planningContext?.hasExplicitDate) {
    const fixedCourses = planningContext.currentTermPlanningWindow
      ? fixedInProgressCourses(student, mapping, courseCatalog)
      : [];
    return buildPlanningSlots(planningContext).map((slot, order) => {
      const termLoadEvidence = termLoadEvidenceForSlot(student, slot);
      const reservedCourseUnits = Number(student.reservedCourseUnits?.[slot.id]
        ?? student.reservedCourseUnits?.[slot.label]
        ?? 0);
      const slotFixedCourses = slot.isCurrentTerm ? fixedCourses.map(course => {
        const exactTerm = policyBundle.indexes.offeringByTerm[canonicalTermId(slot)];
        const sections = exactTerm?.sections.filter(section => section.course === course.course || section.crossListedAs.includes(course.course)) || [];
        // A single published section establishes the meeting without guessing
        // which section a student selected when several are offered.
        if (sections.length !== 1 || scheduleCoverageForCourse(exactTerm,course.course).coverage !== "COMPLETE") return course;
        const section = sections[0];
        const minutes = time => time ? time.split(":").reduce((hours, value) => hours * 60 + Number(value), 0) : null;
        return {...course,section:section.sectionId.split("-").at(-1),meeting:{...section.meeting,startMinutes:minutes(section.meeting?.startTime),endMinutes:minutes(section.meeting?.endTime)}};
      }) : [];
      const activeCourseUnits = termLoadCapacity(policyBundle, { ...slot, termLoadEvidence }).activeCourseUnits;
      const remainingPlannerCapacity = slot.newCoursesAllowed === false
        ? 0
        : Math.max(0, activeCourseUnits - reservedCourseUnits - plannedCourseUnits(slotFixedCourses));
      return {
        ...slot,
        order,
        termLoadEvidence,
        reservedCourseUnits,
        activeCourseUnits,
        fixedCourses: slotFixedCourses,
        fixedCourseCount: slotFixedCourses.length,
        fixedTrackedCourseCount: slotFixedCourses.filter(course => course.plannerTracked).length,
        fixedEconomicsCourseCount: slotFixedCourses.filter(course => isEconomicCourse(course.course)).length,
        remainingPlannerCapacity
      };
    });
  }
  return legacySlots();
}

function visibleTerms(termPlans) {
  return termPlans.filter(plan => !plan.isSummer || plan.courses.length > 0);
}

function remainingRequirements(mapping) {
  const unresolved = mapping?.projectedAfterInProgress?.optimistic?.unresolved
    || mapping?.optimistic?.unresolved
    || [];
  return [...unresolved].sort((left, right) => (
    (REQUIREMENT_PLANNING_PRIORITY.get(left.requirementId) ?? 50)
      - (REQUIREMENT_PLANNING_PRIORITY.get(right.requirementId) ?? 50)
      || left.requirementId.localeCompare(right.requirementId)
  ));
}

function orderedRequirementOptions(requirement) {
  const preferred = requirement.preferredOptions || [];
  return [...new Set([...preferred, ...(requirement.options || [])])];
}

function isValidElectiveCourse(requirement, code, mapping) {
  if (requirement?.kind !== "elective" || !String(code).startsWith(`${requirement.subject || "ECO"} `)) return false;
  if ((requirement.excludedCourses || []).includes(code)) return false;
  const condition = requirement.conditionalCourses?.[code];
  if (!condition) return true;
  return (mapping?.assignments || []).some(assignment => (
    assignment.slotId === condition.slotId && assignment.code === condition.assignedCode
  ));
}

function uniquePlanningGaps(items = []) {
  const byKey = new Map();
  for (const item of items) {
    const normalized = typeof item === "string"
      ? { code: "PLAN_VALIDATION", message: item }
      : item;
    const key = `${normalized.requirementId || normalized.code || ""}:${normalized.course || ""}:${normalized.reason || normalized.message || ""}`;
    byKey.set(key, normalized);
  }
  return [...byKey.values()];
}

function planSignature(plan) {
  return JSON.stringify({
    graduationTerm: plan?.planningContext?.expectedGraduationTerm || null,
    earlyGraduation: Boolean(plan?.planningContext?.earlyGraduation),
    status: plan?.feasibilityStatus || null,
    verification: plan?.feasibility?.verification || null,
    enrollmentConditions: [...(plan?.feasibility?.enrollmentConditions || [])]
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    terms: (plan?.terms || []).map(term => ({
      slot: term.slotId || term.term,
      courses: (term.courses || []).map(course => ({
        requirementId: course.requirementId || null,
        course: course.course,
        section: course.section || null,
        source: course.source || null,
        offeringStatus: course.offeringStatus || null,
        verificationStatus: course.verificationStatus || null,
        availability: course.availability || null,
        meeting: course.meeting || null,
        selectedOptionId: course.selectedOptionId || null,
        approvals: (Array.isArray(course.approvalRequired) ? course.approvalRequired : [])
          .map(item => `${item.reason}:${item.prerequisite}:${item.type}:${item.sourceRef || ""}`)
          .sort()
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }))
  });
}

function annualCourseCounts(plan, targetYearCounts) {
  return targetYearCounts.map((_, yearIndex) => (
    (plan?.terms || [])
      .filter(term => term.yearIndex === yearIndex)
      .reduce((sum, term) => sum + plannerTrackedTermLoad(term), 0)
  ));
}

function distributionDesignLabel(strategy) {
  return [...PLAN_VARIANTS, EARLY_GRADUATION_VARIANT]
    .find(variant => variant.strategy === strategy)?.label || "preferred";
}

export function validatePreferredDistribution(plan) {
  const targets = plan?.distribution?.targetYearCounts;
  if (!Array.isArray(targets) || !targets.length) {
    return {
      applicable: false,
      valid: true,
      exact: true,
      annualDistance: 0,
      targetYearCounts: [],
      actualYearCounts: [],
      errors: [],
      warnings: []
    };
  }

  const actual = annualCourseCounts(plan, targets);
  const annualDistance = targets.reduce((sum, target, yearIndex) => (
    sum + Math.abs(target - actual[yearIndex])
  ), 0);
  const actualTermLoads = Object.fromEntries((plan?.terms || [])
    .filter(term => !term.isSummer)
    .map(term => [term.slotId, plannerTrackedTermLoad(term)]));
  const termShapeDistance = termShapePenalty(plan, plan.distribution);
  const allowedDistance = Number(plan?.preferredDistributionException?.allowedAnnualDistance);
  const exceptionCounts = plan?.preferredDistributionException?.actualYearCounts;
  const exceptionTargets = plan?.preferredDistributionException?.targetYearCounts;
  const matchesException = Array.isArray(exceptionCounts)
    && exceptionCounts.length === actual.length
    && exceptionCounts.every((count, yearIndex) => count === actual[yearIndex]);
  const exceptionTargetMatches = Array.isArray(exceptionTargets)
    && exceptionTargets.length === targets.length
    && exceptionTargets.every((count, yearIndex) => count === targets[yearIndex]);
  const exceptionDistance = Array.isArray(exceptionCounts)
    ? targets.reduce((sum, target, yearIndex) => sum + Math.abs(target - Number(exceptionCounts[yearIndex] || 0)), 0)
    : Number.NaN;
  const exactSearchProof = (plan?.search?.attempts || []).find(attempt => attempt.preferredDistributionRequired === true);
  const exceptionApplies = Number.isFinite(allowedDistance)
    && allowedDistance > 0
    && exceptionTargetMatches
    && exceptionDistance === allowedDistance
    && exactSearchProof?.complete === true
    && Number(exactSearchProof.validSolutionCount || 0) === 0;
  const valid = annualDistance === 0 || (exceptionApplies && (
    annualDistance < allowedDistance
    || (annualDistance === allowedDistance && matchesException)
  ));
  const design = distributionDesignLabel(plan?.distribution?.strategy);
  const mismatchMessage = `${plan?.label || "This plan"} no longer follows its ${design} yearly distribution. Target: ${targets.join(" / ")}; current: ${actual.join(" / ")}.`;

  return {
    applicable: true,
    valid,
    exact: annualDistance === 0 && termShapeDistance === 0,
    design,
    annualDistance,
    allowedAnnualDistance: exceptionApplies ? allowedDistance : 0,
    targetYearCounts: [...targets],
    actualYearCounts: actual,
    fixedTrackedOccupancy: plan.distribution.fixedTrackedOccupancy || { total: 0, byYear: [], byTerm: {} },
    unresolvedTarget: Number(plan.distribution.unresolvedTarget || 0),
    actualTermLoads,
    preferredLegalTermShapes: plan.distribution.preferredTermShapeTiersByYear || {},
    termShapeDistance,
    exactPreferredPacingAvailable: plan.distribution.capacitySufficient !== false,
    exactPreferredPacingFound: annualDistance === 0 && termShapeDistance === 0,
    capacityReasonForDeviation: plan.distribution.capacitySufficient === false
      ? "INSUFFICIENT_AUTHORITATIVE_REMAINING_CAPACITY"
      : null,
    errors: valid ? [] : [mismatchMessage],
    warnings: valid && annualDistance > 0
      ? [plan.preferredDistributionException.message]
      : []
  };
}

export function validateGeneratedPlan(plan, {
  student = {},
  mapping,
  schedule,
  prerequisites = {},
  context = null,
  policyBundle = runtimePolicyBundle(),
  enforcePlanIntegrity = false
} = {}) {
  const errors = [];
  const integrityErrors = [];
  const warnings = [];
  const normalizedSchedule = normalizeEconomicsSchedule(schedule || runtimeEconomicsSchedule());
  const requirementsById = new Map((mapping?.requirements || []).map(requirement => [requirement.id, requirement]));
  const courses = normalizeStudentCourses(student.courses);
  const completedCodes = new Set(courses
    .filter(course => ["completed", "transfer"].includes(course.status) && canCountCompletedCourse(course))
    .map(course => course.code));
  const inProgressCodes = new Set(courses
    .filter(course => course.status === "in_progress" && canCountCompletedCourse(course))
    .map(course => course.code));
  const selectedCodes = new Set([...completedCodes, ...inProgressCodes]);
  const seenCourses = new Set();
  const seenRequirements = new Set();
  const seenFixedInProgress = new Set();
  const availableCodes = new Set(completedCodes);
  const hasAssigned100LevelElective = assigned100LevelElectives(mapping).length >= electiveMaximum100(policyBundle);
  let planned100LevelElectiveCount = 0;
  const requirementAllocation = buildRequirementAllocation({
    requirements: mapping?.requirements || [],
    existingAssignments: mapping?.assignments || [],
    plan,
    policyBundle,
    catalogApplicability: plan?.catalogApplicability || context?.catalogApplicability || null
  });
  const authoritativeContext = context || (student?.planCreationDate ? resolvePlanningContext(student) : null);
  const authoritativeSlotsById = new Map(
    planSlotsFor(student, authoritativeContext, mapping, [], policyBundle).map(slot => [slot.id, slot])
  );
  errors.push(...planningHorizonErrors(plan, authoritativeContext));

  for (const term of plan?.terms || []) {
    if (isAfterCurrentPlanningTerm(term, context)) {
      for (const code of inProgressCodes) availableCodes.add(code);
    }
    const authoritativeSlot = authoritativeSlotsById.get(term.slotId);
    const capacity = termCapacity({
      ...term,
      termKey: authoritativeSlot?.termKey || term.termKey,
      reservedCourseUnits: authoritativeSlot?.reservedCourseUnits ?? 0,
      termLoadEvidence: authoritativeSlot?.termLoadEvidence || null
    }, plan?.planningMode);
    const economicsCount = (term.courses || []).filter(course => isEconomicCourse(course.course)).length;
    if (plannedCourseUnits(term.courses) > capacity.total) errors.push(`${term.term} exceeds the total course limit.`);
    if (economicsCount > capacity.economics) errors.push(`${term.term} exceeds the Economics course limit.`);
    if (economicsCount > 2) {
      warnings.push(`This plan uses more than two Economics courses in ${term.term}; this is above the advising preference but remains within the recorded total-load capacity.`);
    }
    if (authoritativeSlot?.newCoursesAllowed === false
      && (term.courses || []).some(course => course.fixedInProgress !== true)) {
      const error = `${term.term} is marked as already set and cannot receive new planner-assigned courses.`;
      errors.push(error);
      integrityErrors.push(error);
    }

    const termCodes = new Set();
    const termMeetingOfferings = [];
    const isVerifiedScheduleYear = normalizedAcademicYear(term.academicYear)
      === normalizedAcademicYear(normalizedSchedule?.academicYear);
    for (const course of term.courses || []) {
      if (course.fixedInProgress === true) {
        const code = course.course;
        if (!authoritativeSlot?.isCurrentTerm || !inProgressCodes.has(code)) {
          const error = `${code || "A fixed current course"} is not valid Taking now occupancy for ${term.term}.`;
          errors.push(error);
          integrityErrors.push(error);
        }
        if (seenFixedInProgress.has(code)) {
          const error = `${code} is duplicated in fixed Taking now occupancy.`;
          errors.push(error);
          integrityErrors.push(error);
        }
        seenFixedInProgress.add(code);
        termCodes.add(code);
        continue;
      }
      const extraError = extraCourseError(course, policyBundle);
      if (extraError) errors.push(extraError);
      const supportingRequirementId = SUPPORTING_REQUIREMENT_PLACEHOLDERS.get(course.course);
      if (supportingRequirementId) {
        const requirement = requirementsById.get(course.requirementId);
        if (requirement?.id !== supportingRequirementId || course.source !== "requirement-placeholder") {
          errors.push(`${course.course} may satisfy only the ${supportingRequirementId} requirement slot.`);
        }
        const requiredOptions = requirement?.options || [];
        if (!Array.isArray(course.options) || !requiredOptions.every(option => course.options.includes(option))) {
          errors.push(`${course.course} must list every valid ${supportingRequirementId} option.`);
        }
        if (course.offeringStatus !== "schedule_confirmation_required") {
          errors.push(`${course.course} must require schedule confirmation.`);
        }
        if (seenRequirements.has(course.requirementId)) errors.push(`Requirement ${course.requirementId} is assigned more than once.`);
        seenRequirements.add(course.requirementId);
        termCodes.add(course.course);
        warnings.push(course.course === STATISTICS_REQUIREMENT
          ? `Schedule confirmation required for ${term.term}: confirm whether ${STATISTICS_OPTIONS.join(", ")} is actually offered without a time conflict.`
          : `Schedule confirmation required for ${course.course} in ${term.term}: confirm a valid option without a time conflict.`);
        continue;
      }
      if (course.course === "ECO elective") {
        const electiveRequirement = course.extra === true ? {kind:"elective"} : requirementsById.get(course.requirementId);
        if (!electiveRequirement || electiveRequirement.kind !== "elective") {
          errors.push(`ECO elective is not valid for requirement ${course.requirementId || "unknown"}.`);
        }
        const validGenericPlacement = (course.source === "future-placeholder" && term.isPlaceholder)
          || (course.source === "projected-offering" && !term.isPlaceholder);
        if (!validGenericPlacement) {
          errors.push("An unverified ECO elective must remain a clearly projected or Term to be confirmed placement.");
        }
        if (isVerifiedScheduleYear) {
          errors.push("A generic ECO elective placeholder cannot be used in an academic year with a verified schedule.");
        }
        if (hasAssigned100LevelElective && course.minimumLevel !== electivePlaceholderMinimumLevel(policyBundle)) {
          errors.push("After one 100-level ECO elective is used, every remaining ECO elective must be restricted to the 200 level or above.");
        }
        if (seenRequirements.has(course.requirementId)) errors.push(`Requirement ${course.requirementId} is assigned more than once.`);
        seenRequirements.add(course.requirementId);
        continue;
      }
      const code = course.course;
      const requirement = course.extra === true ? {kind:"extra"} : requirementsById.get(course.requirementId);
      if (!requirement) errors.push(`${code} is not a valid course for requirement ${course.requirementId || "unknown"}.`);
      if (requirement?.kind === "elective" && is100LevelEconomicsCourse(code)) {
        planned100LevelElectiveCount += 1;
        if (assigned100LevelElectives(mapping).length + planned100LevelElectiveCount > electiveMaximum100(policyBundle)) {
          errors.push(`The plan exceeds the ${electiveMaximum100(policyBundle) === 1 ? "one" : electiveMaximum100(policyBundle)} permitted 100-level Economics elective(s).`);
        }
      }
      if (seenCourses.has(code) || selectedCodes.has(code)) errors.push(`${code} is duplicated or already listed as completed/current.`);
      if (seenRequirements.has(course.requirementId)) errors.push(`Requirement ${course.requirementId} is assigned more than once.`);
      seenCourses.add(code);
      seenRequirements.add(course.requirementId);
      termCodes.add(code);

      const isFuturePlaceholder = course.source === "future-placeholder" && term.isPlaceholder;
      const isProjectedOffering = ["projected-offering", "catalog-statement", "historical-pattern"].includes(course.source);
      const isRecurringCapstone = course.source === "recurring-rule-unconfirmed" && code === "ECO 461";
      const isRequirementPlaceholder = course.source === "requirement-placeholder";
      const verifiedOfferings = scheduleOfferings(normalizedSchedule, term, code);
      const matchingOffering = verifiedOfferings.find(offering => (
        !course.section || offering.section === course.section
      ));
      if (course.source === "verified-offering" && !course.section) {
        errors.push(`${code} must retain its verified section identifier.`);
      }
      if (!isFuturePlaceholder && !isProjectedOffering && !isRecurringCapstone && !isRequirementPlaceholder && !matchingOffering) {
        errors.push(`${code} is not verified in the ${term.academicYear || "scheduled"} ${term.termKey} offering.`);
      }
      if (isRequirementPlaceholder) {
        if (isVerifiedScheduleYear) {
          errors.push(`${code} cannot use a requirement placeholder in an academic year with a verified schedule.`);
        }
        warnings.push(`Schedule confirmation required for ${code} in ${term.term}: the supporting-course schedule has not been verified.`);
      }
      if (isProjectedOffering) {
        if (normalizedAcademicYear(term.academicYear) === normalizedAcademicYear(normalizedSchedule?.academicYear)) {
          errors.push(`${code} cannot use a projected offering in an academic year with a verified schedule.`);
        }
      }
      if (matchingOffering) {
        const scheduleErrors = scheduleIntegrityErrors(course, matchingOffering, term, normalizedSchedule);
        errors.push(...scheduleErrors);
        integrityErrors.push(...scheduleErrors);
        termMeetingOfferings.push(matchingOffering);
        if (!matchingOffering.meeting?.days?.length
          || !Number.isFinite(matchingOffering.meeting?.startMinutes)
          || !Number.isFinite(matchingOffering.meeting?.endMinutes)) {
          warnings.push(`${code}-${matchingOffering.section} does not have complete meeting days and times; confirm conflicts before registration.`);
        }
        if (matchingOffering.availability?.status === "closed") {
          errors.push(`${code}-${matchingOffering.section} is closed in ${term.term}.`);
        } else if (matchingOffering.availability?.status === "waitlisted") {
          warnings.push(`${code}-${matchingOffering.section} is waitlisted; the plan depends on a seat becoming available.`);
        } else if (matchingOffering.availability?.status === "unknown") {
          warnings.push(`${code}-${matchingOffering.section} has unknown current availability.`);
        }
        if (availabilityIsStale(matchingOffering.availability, student.planCreationDate)) {
          warnings.push(`Seat availability for ${code}-${matchingOffering.section} was last checked on ${matchingOffering.availability?.asOf || "an unknown date"}; confirm it before registration.`);
        }
      }
      if (!["verified-offering", "summer-last-resort", "future-placeholder", "projected-offering", "catalog-statement", "historical-pattern", "recurring-rule-unconfirmed", "requirement-placeholder"].includes(course.source)) {
        errors.push(`${code} does not have a verified-offering source.`);
      }
      if (course.source === "future-placeholder" && !term.isPlaceholder) {
        errors.push(`${code} claims an unverified future offering in a specific term.`);
      }
      if (term.isSummer && code !== "ECO 113") errors.push(`${code} is not allowed in a Summer slot.`);
      if (!isSeniorWinterOnly(code, term, student, context, policyBundle)) errors.push(`${code} is not in a valid senior Winter slot.`);
      if (code === "ECO 461" && course.residency !== "hanover") {
        errors.push("ECO 461 must be identified as a Hanover-residency capstone placement.");
      }

    }
    for (let left = 0; left < termMeetingOfferings.length; left += 1) {
      for (let right = left + 1; right < termMeetingOfferings.length; right += 1) {
        if (meetingsConflict(termMeetingOfferings[left], termMeetingOfferings[right])) {
          errors.push(`${termMeetingOfferings[left].course} conflicts with ${termMeetingOfferings[right].course} in ${term.term}.`);
        }
      }
    }
    for (const code of termCodes) availableCodes.add(code);
  }

  if (authoritativeContext?.currentTermPlanningWindow) {
    for (const code of inProgressCodes) {
      if (!seenFixedInProgress.has(code)) {
        const error = `${code} must remain fixed in ${authoritativeContext.currentTermPlanningWindow.displayTerm}.`;
        errors.push(error);
        integrityErrors.push(error);
      }
    }
  }

  const prerequisiteEvaluation = evaluatePlanPrerequisites({
    plan,
    student,
    prerequisites,
    context,
    requireRecordedApprovals: true
  });
  errors.push(...prerequisiteEvaluation.errors);
  warnings.push(...prerequisiteEvaluation.warnings);
  errors.push(...requirementAllocation.errors);
  const distributionValidation = validatePreferredDistribution(plan);
  warnings.push(...distributionValidation.errors, ...distributionValidation.warnings);

  const remainingRequirementIds = new Set(remainingRequirements(mapping).map(item => item.requirementId));
  for (const requirementId of remainingRequirementIds) {
    if (!seenRequirements.has(requirementId)) {
      errors.push(`Requirement ${requirementId} remains unscheduled.`);
    }
  }

  const facts = normalizeStudentFacts(student, policyBundle);
  const policyEvaluation = evaluatePolicyPlan(plan, facts, {
    planningContext: authoritativeContext,
    mapping,
    requirements: mapping?.requirements || [],
    authoritativeSlots: [...authoritativeSlotsById.values()],
    traceId: `plan-${plan?.id || "candidate"}-${policyBundle.contentHash.slice(0, 12)}`
  }, policyBundle);
  const integrityBlocked = enforcePlanIntegrity && integrityErrors.length > 0;
  const notices = [...buildPlanNotices(plan, authoritativeContext, policyEvaluation.catalogApplicability),
    ...(mapping?.advisorNotifications || [])];
  const authoritativeErrors = policyEvaluation.academicallyValid && !integrityBlocked
    ? []
    : integrityBlocked
      ? [...new Set(integrityErrors)]
    : errors.length
      ? [...new Set(errors)]
      : [...new Set(policyEvaluation.decisions
          .filter(decision => ["BLOCK", "UNKNOWN"].includes(decision.status))
          .map(decision => decision.ruleIds.some(id => ["PLANNING-UNPUBLISHED-ELECTIVE-LIMIT", "PLANNING-FUTURE-COURSE-CONFIRMATION"].includes(id))
            ? policyBundle.messages[decision.messageKeys.student] || decision.reasonCode : decision.reasonCode))];
  const reviewWarnings = policyEvaluation.reviewFindings.map(decision => (
    studentFacingPlanReviewMessage(decision, { student, policyBundle })
      || `${decision.subject.course || "A recorded class"} needs an advisor review.`
  ));
  const { latencyMs: _decisionLatencyMs, ...stablePolicyEvaluation } = policyEvaluation;

  const validation = {
    valid: policyEvaluation.academicallyValid && !integrityBlocked,
    approved: policyEvaluation.approvedForAuthority && !integrityBlocked,
    completionStatus: policyEvaluation.completionStatus,
    evidenceStatus: policyEvaluation.evidenceStatus,
    publicationStatus: planPublicationStatus(plan),
    readinessStatus: policyEvaluation.readinessStatus,
    planDisposition: policyEvaluation.planDisposition,
    advisorActionRequired: policyEvaluation.advisorActionRequired,
    advisorActions: policyEvaluation.advisorActions,
    conditions: policyEvaluation.conditions,
    tuitionAdvisories: policyEvaluation.tuitionAdvisories,
    temporalSemantics: policyEvaluation.temporalSemantics,
    catalogApplicability: policyEvaluation.catalogApplicability,
    evidenceFacts: policyEvaluation.evidenceFacts,
    notices,
    studentNotices: notices.filter(notice => notice.audience?.includes("STUDENT")),
    advisorNotifications: notices.filter(notice => notice.audience?.includes("ACADEMIC_ADVISOR")),
    errors: authoritativeErrors,
    warnings: [...new Set([...warnings, ...reviewWarnings, ...policyEvaluation.tuitionAdvisories.map(item => item.message)])],
    requiredApprovals: prerequisiteEvaluation.requiredApprovals,
    reviewFindings: policyEvaluation.reviewFindings,
    checkedCourseCount: seenCourses.size,
    checkedRequirementCount: seenRequirements.size,
    distribution: distributionValidation,
    requirementAllocation: requirementAllocationSummary(requirementAllocation),
    policyDecision: stablePolicyEvaluation,
    policyBundleVersion: policyBundle.bundleVersion,
    policyBundleHash: policyBundle.contentHash,
    degreeRequirementInformation: buildDegreeDesignationInformation({
      student,
      plan,
      planningContext: authoritativeContext
    })
  };
  Object.defineProperty(validation, "policyDecisionLatencyMs", {
    value: policyEvaluation.latencyMs,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return validation;
}

function applyDecisionContracts(plan, policyBundle = runtimePolicyBundle()) {
  annotateEconomicsMoveDestinations(plan, policyBundle);
  const validation = plan?.validation;
  if (!validation) return plan;
  annotatePreliminaryScheduleEvidence(plan, policyBundle);
  for (const term of plan.terms || []) {
    for (const course of term.courses || []) {
      const provenance = courseScheduleProvenance(course);
      course.scheduleProvenance = provenance;
      course.publicationStatus = provenance;
    }
    term.publicationStatus = term.publicationStatus === SCHEDULE_PROVENANCE.PLANNING_PROJECTION
      || (term.courses || []).some(course => course.scheduleProvenance === SCHEDULE_PROVENANCE.PLANNING_PROJECTION)
      ? SCHEDULE_PROVENANCE.PLANNING_PROJECTION
      : SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE;
  }
  plan.readinessStatus = validation.readinessStatus;
  plan.planDisposition = validation.planDisposition;
  plan.advisorActionRequired = validation.advisorActionRequired;
  plan.advisorActions = validation.advisorActions;
  plan.conditions = validation.conditions;
  plan.temporalSemantics = validation.temporalSemantics;
  plan.catalogApplicability = validation.catalogApplicability;
  plan.publicationStatus = validation.publicationStatus;
  plan.notices = validation.notices;
  plan.studentNotices = validation.studentNotices;
  plan.advisorNotifications = validation.advisorNotifications;
  plan.degreeRequirementInformation = validation.degreeRequirementInformation;
  return plan;
}

function searchEndedWithoutSolution(plan = {}) {
  const search = plan.search || plan.feasibility?.search;
  return plan?.solverFailure === "SEARCH_INCOMPLETE"
    || search?.failure === "SEARCH_INCOMPLETE"
    || (search?.complete === false
      && search?.solutionFound === false
      && ["NODE_LIMIT", "TIMEOUT"].includes(search?.terminationReason));
}

export function classifyFeasibility(plan, student = {}) {
  if (searchEndedWithoutSolution(plan)) return FEASIBILITY_STATUS.SEARCH_INCOMPLETE;
  if (!plan?.validation?.valid) return FEASIBILITY_STATUS.NOT_FEASIBLE;
  const courses = (plan.terms || []).flatMap(term => term.courses || []);
  const preliminary = courses.some(course => ["requirement-placeholder", "catalog-statement", "historical-pattern"].includes(course.source));
  if (preliminary) return FEASIBILITY_STATUS.PRELIMINARY;
  const conditional = (plan.validation.conditions || []).some(condition => condition.reasonCode === "TERM_OVERLOAD_APPROVED") || courses.some(course => (
    (Array.isArray(course.approvalRequired) && course.approvalRequired.length > 0)
    || (courseScheduleProvenance(course) === SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE && (
      ["waitlisted", "unknown"].includes(course.availability?.status)
      || !course.meeting?.days?.length
      || !Number.isFinite(course.meeting?.startMinutes)
      || !Number.isFinite(course.meeting?.endMinutes)
      || availabilityIsStale(course.availability, student.planCreationDate)
    ))
  ));
  return conditional ? FEASIBILITY_STATUS.CONDITIONAL : FEASIBILITY_STATUS.VERIFIED;
}

export function buildFeasibilityDetails(plan, student = {}, search = null) {
  const courses = (plan?.terms || []).flatMap(term => (term.courses || []).map(course => ({ ...course, term: term.term })));
  const requiredApprovals = [...new Map(courses.flatMap(course => (
    Array.isArray(course.approvalRequired) ? course.approvalRequired : []
  )).map(item => [`${item.course}:${item.prerequisite}:${item.term}:${item.type}`, item])).values()];
  const enrollmentConditions = [];
  for (const course of courses) {
    const published = courseScheduleProvenance(course) === SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE;
    const status = course.availability?.status;
    if (published && ["waitlisted", "unknown"].includes(status)) {
      enrollmentConditions.push({
        type: status === "waitlisted" ? "waitlist" : "availability_unknown",
        course: course.course,
        section: course.section || null,
        term: course.term
      });
    }
    if (["verified-offering", "summer-last-resort"].includes(course.source)
      && availabilityIsStale(course.availability, student.planCreationDate)) {
      enrollmentConditions.push({
        type: "stale_availability",
        course: course.course,
        section: course.section || null,
        term: course.term,
        asOf: course.availability?.asOf || null
      });
    }
  }
  const preliminarySources = new Set(["requirement-placeholder"]);
  const verifiedCount = courses.filter(course => ["verified-offering", "summer-last-resort"].includes(course.source)).length;
  const preliminaryCount = courses.filter(course => preliminarySources.has(course.source)).length;
  const meetingComplete = courses.filter(course => (
    course.meeting?.days?.length
    && Number.isFinite(course.meeting?.startMinutes)
    && Number.isFinite(course.meeting?.endMinutes)
  )).length;
  const availabilityStates = new Set(courses.map(course => {
    if (!["verified-offering", "summer-last-resort"].includes(course.source)) return "unknown";
    if (!course.availability?.status) return "unknown";
    if (availabilityIsStale(course.availability, student.planCreationDate)) return "stale";
    return course.availability.status;
  }));
  const lastVerifiedAt = courses.map(course => course.availability?.asOf).filter(Boolean).sort().at(-1)
    || plan?.verification?.scheduleVerifiedOn
    || null;
  const overallStatus = classifyFeasibility(plan, student);
  const searchIncomplete = overallStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE;
  return {
    overallStatus,
    verification: {
      offerings: planPublicationStatus(plan) === SCHEDULE_PROVENANCE.PLANNING_PROJECTION
        ? "planning_projection"
        : preliminaryCount === 0 ? "published" : verifiedCount === 0 ? "unpublished" : "mixed",
      meetings: courses.length === 0 ? "unknown" : meetingComplete === courses.length ? "verified" : meetingComplete ? "incomplete" : "unknown",
      availability: availabilityStates.size > 1 ? "mixed" : availabilityStates.has("stale") ? "stale" : availabilityStates.values().next().value || "unknown",
      lastVerifiedAt
    },
    requiredApprovals,
    enrollmentConditions: [...new Map(enrollmentConditions.map(item => [
      `${item.type}:${item.course}:${item.section}:${item.term}`,
      item
    ])).values()],
    warnings: [...new Set([
      ...(plan?.validation?.warnings || []),
      ...(plan?.warnings || []),
      ...(searchIncomplete ? [SEARCH_INCOMPLETE_MESSAGE] : [])
    ])],
    blockingReasons: searchIncomplete ? [] : [...new Set(plan?.validation?.errors || [])],
    search: search || plan?.feasibility?.search || {
      complete: true,
      nodesVisited: 0,
      limit: TERM_SOLVER_NODE_LIMIT
    }
  };
}

function mergeSearchCounters(left = {}, right = {}) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  return Object.fromEntries([...keys].map(key => [key, Number(left[key] || 0) + Number(right[key] || 0)]));
}

function combineSearchDiagnostics(first, second, limit, firstAttempt = {}, secondAttempt = {}) {
  const firstSearch = first.search || {};
  const secondSearch = second.search || {};
  const combined = {
    ...secondSearch,
    complete: Boolean(firstSearch.complete && secondSearch.complete),
    nodesVisited: Number(firstSearch.nodesVisited || 0) + Number(secondSearch.nodesVisited || 0),
    limit,
    completionAttempts: Number(firstSearch.completionAttempts || 0) + Number(secondSearch.completionAttempts || 0),
    prerequisiteFailures: Number(firstSearch.prerequisiteFailures || 0) + Number(secondSearch.prerequisiteFailures || 0),
    deadEnds: Number(firstSearch.deadEnds || 0) + Number(secondSearch.deadEnds || 0),
    deadEndsByRequirement: mergeSearchCounters(firstSearch.deadEndsByRequirement, secondSearch.deadEndsByRequirement),
    prerequisiteFailureReasons: mergeSearchCounters(firstSearch.prerequisiteFailureReasons, secondSearch.prerequisiteFailureReasons),
    firstSolutionNode: firstSearch.firstSolutionNode ?? (
      secondSearch.firstSolutionNode === null || secondSearch.firstSolutionNode === undefined
        ? null
        : Number(firstSearch.nodesVisited || 0) + secondSearch.firstSolutionNode
    ),
    validSolutionCount: Number(firstSearch.validSolutionCount || 0) + Number(secondSearch.validSolutionCount || 0),
    completeSchedulesExamined: Number(firstSearch.completeSchedulesExamined || firstSearch.completionAttempts || 0)
      + Number(secondSearch.completeSchedulesExamined || secondSearch.completionAttempts || 0),
    prerequisiteValidSchedules: Number(firstSearch.prerequisiteValidSchedules || firstSearch.validSolutionCount || 0)
      + Number(secondSearch.prerequisiteValidSchedules || secondSearch.validSolutionCount || 0),
    exactDuplicatesRemoved: Number(firstSearch.exactDuplicatesRemoved || 0)
      + Number(secondSearch.exactDuplicatesRemoved || 0),
    retainedSchedules: Number(secondSearch.retainedSchedules || 0),
    solutionLimit: Number(secondSearch.solutionLimit || firstSearch.solutionLimit || TERM_SOLVER_SOLUTION_BUDGET),
    totalRawSolutionsAcrossAttemptChain: Number(firstSearch.validSolutionCount || 0) + Number(secondSearch.validSolutionCount || 0),
    terminationReason: secondSearch.terminationReason || firstSearch.terminationReason || null,
    attempts: [
      ...(Array.isArray(firstSearch.attempts)
        ? firstSearch.attempts
        : [{ ...firstAttempt, ...firstSearch }]),
      { ...secondAttempt, ...secondSearch }
    ]
  };
  Object.defineProperty(combined, "durationMs", {
    value: Number(firstSearch.durationMs || 0) + Number(secondSearch.durationMs || 0),
    enumerable: false,
    configurable: true
  });
  return combined;
}

function diagnosticsNow() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function roundDiagnosticDuration(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function solverDiagnostic(result, context = {}, durationMs = 0) {
  const domains = result?.domains instanceof Map ? result.domains : new Map();
  const domainSizes = Object.fromEntries([...domains.entries()].map(([requirementId, choices]) => [
    requirementId,
    Array.isArray(choices) ? choices.length : 0
  ]));
  const search = result?.search || {};
  return {
    ...context,
    attempted: true,
    durationMs: roundDiagnosticDuration(durationMs),
    complete: Boolean(search.complete),
    exhaustive: Boolean(search.complete),
    terminationReason: search.terminationReason || (search.complete ? "EXHAUSTED" : null),
    failure: result?.failure || null,
    solutionFound: Boolean(result?.solution),
    nodesVisited: Number(search.nodesVisited || 0),
    nodeLimit: Number(search.limit || 0),
    solutionLimit: Number(search.solutionLimit || TERM_SOLVER_SOLUTION_BUDGET),
    rawSolutionsEncountered: Number(search.validSolutionCount || result?.solutions?.length || 0),
    solutionBudgetHit: search.terminationReason === "SOLUTION_BUDGET",
    domainSizes,
    emptyDomains: Object.entries(domainSizes).filter(([, size]) => size === 0).map(([requirementId]) => requirementId),
    completionAttempts: Number(search.completionAttempts || 0),
    completeSchedulesExamined: Number(search.completeSchedulesExamined || search.completionAttempts || 0),
    prerequisiteFailures: Number(search.prerequisiteFailures || 0),
    prerequisiteFailureReasons: search.prerequisiteFailureReasons || {},
    deadEnds: Number(search.deadEnds || 0),
    deadEndsByRequirement: search.deadEndsByRequirement || {},
    prerequisiteValidSchedules: Number(search.prerequisiteValidSchedules || search.validSolutionCount || 0),
    retainedSchedules: Number(search.retainedSchedules || result?.solutions?.length || 0),
    exactDuplicatesRemoved: Number(search.exactDuplicatesRemoved || 0),
    firstSolutionNode: search.firstSolutionNode ?? null,
    orderingTrace: Array.isArray(search.orderingTrace) ? search.orderingTrace : [],
    searchStrategy: search.searchStrategy || "normal",
    rescue: search.searchStrategy === "rescue" || context.innerSearchStage?.includes("rescue") || false,
    incumbentPreserved: Boolean(search.incumbentPreserved)
  };
}

const CANDIDATE_POOL_LIMIT = 12;
const PREFERRED_SEARCH_BUDGET_SHARE = 0.1;
const NORMAL_RELAXED_RESCUE_BUDGET_SHARE = 0.4;
const FINAL_VALIDATOR_RESCUE_BUDGET_SHARE = 0.1;

function yearIndexForCourse(plan, code) {
  const term = (plan?.terms || []).find(item => (
    (item.courses || []).some(course => course.course === code)
  ));
  return term ? Number(term.yearIndex) : Number.POSITIVE_INFINITY;
}

function firstYearCourseCount(plan, matcher) {
  return (plan?.terms || [])
    .filter(term => term.yearIndex === 0)
    .flatMap(term => term.courses || [])
    .filter(matcher)
    .length;
}

function annualLoads(plan) {
  return plannerTrackedYearLoads(plan);
}

function fallWinterImbalance(plan) {
  const loads = (plan?.terms || [])
    .filter(term => ["Fall", "Winter"].includes(term.termKey))
    .map(term => term.courses.length);
  return loads.length ? Math.max(...loads) - Math.min(...loads) : 0;
}

function statisticsCourse(plan) {
  return (plan?.terms || [])
    .flatMap(term => (term.courses || []).map(course => ({ term, course })))
    .find(item => STATISTICS_OPTIONS.includes(item.course.course)) || null;
}

function statisticsSafetyPenalty(plan) {
  const selected = statisticsCourse(plan);
  if (!selected) return 10;
  const course = selected.course;
  const availability = course.availability?.status;
  const availabilityRank = availability === "open" ? 0 : availability === "waitlisted" ? 1 : availability === "unknown" ? 2 : 3;
  const verifiedFirstYearRank = selected.term.yearIndex === 0 && course.source === "verified-offering" ? 0 : 1;
  const meetingRank = course.meeting?.days?.length
    && Number.isFinite(course.meeting?.startMinutes)
    && Number.isFinite(course.meeting?.endMinutes)
    ? 0
    : 1;
  return verifiedFirstYearRank * 100 + availabilityRank * 10 + meetingRank * 3 + selected.term.yearIndex;
}

  function completedCourseSet(student = {}) {
    return new Set(normalizeStudentCourses(student.courses)
      .filter(course => ["completed", "transfer", "in_progress"].includes(course.status))
    .map(course => course.code));
}

function exploreFirstRequirementPriority(student = {}, planVariant, context) {
  if (planVariant?.strategy !== "explore-first") return null;
  const standing = context?.effectiveStanding || String(student.academicStanding || "").toLowerCase();
  const completed = completedCourseSet(student);
  const priority = new Map([
    ["eco-113", 1], ["eco-114", 1], ["cognate", 1], ["statistics", 2],
    ["eco-213", 3], ["eco-214", 3], ["finance", 3],
    ["eco-elective-1", 4], ["eco-elective-2", 4], ["eco-elective-3", 4], ["eco-elective-4", 4],
    ["eco-461", 5]
  ]);
  const rank = ids => ids.forEach(([id, value]) => priority.set(id, value));
  if (standing === "freshman") {
    rank([["eco-113", 1], ["eco-114", 1], ["cognate", 2], ["statistics", 2], ["eco-213", 3], ["eco-214", 3], ["finance", 7], ["eco-461", 9]]);
    return priority;
  }
  if (standing !== "sophomore") return null;

  const has113 = completed.has("ECO 113");
  const has114 = completed.has("ECO 114");
  const hasMath = MATH_OPTIONS.some(code => completed.has(code));
  if (has113 && !has114 && hasMath) {
    rank([["eco-114", 1], ["eco-213", 2], ["statistics", 3], ["eco-214", 4], ["finance", 5], ["eco-461", 7]]);
    return priority;
  }
  if (has114 && !has113 && hasMath) {
    rank([["eco-113", 1], ["eco-214", 2], ["statistics", 3], ["eco-213", 4], ["finance", 5], ["eco-461", 7]]);
    return priority;
  }
  const missingIntroductions = [
    ...(!has113 ? ["eco-113"] : []),
    ...(!has114 ? ["eco-114"] : [])
  ];
  const linkedIntermediate = has113 && !has114 ? "eco-213" : has114 && !has113 ? "eco-214" : null;
  rank([
    ["cognate", 1],
    ...missingIntroductions.map((id, index) => [id, index + 2]),
    ...(linkedIntermediate ? [[linkedIntermediate, 4]] : []),
    ["statistics", 5], ["finance", 6], ["eco-461", 8]
  ]);
  return priority;
}

function electiveRelevancePenalty(plan, preferredPrerequisites, prerequisites = {}) {
  const electives = (plan?.terms || [])
    .flatMap(term => (term.courses || []).map(course => ({ term, course })))
    .filter(item => String(item.course.requirementId || "").startsWith("eco-elective"));
  if (!electives.length) return 0;
  return electives.some(item => (
    (prerequisites?.[item.course.course]?.all || []).some(code => preferredPrerequisites.has(code))
  )) ? 0 : 1;
}

function strategyScore(plan, { planVariant, student, prerequisites = {} } = {}) {
  const loads = annualLoads(plan);
  const target = plan?.distribution?.targetYearCounts || [];
  const annualDistance = target.reduce((sum, count, index) => sum + Math.abs(count - (loads[index] || 0)), 0);
  const withinYearPenalty = termShapePenalty(plan, plan?.distribution);
  const maximumAnnualLoad = Math.max(0, ...loads);
  const regularLoads = (plan?.terms || [])
    .filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey))
    .map(term => term.courses.length);
  const maxTermLoad = Math.max(0, ...regularLoads);

  if (planVariant?.strategy === "explore-first") {
    const preferences = planVariant.rankingPreferences || {};
    const firstYearTargetDistance = preferences.firstYearTargetFormula
      ? Math.abs((loads[0] || 0) - (target[0] || 0))
      : 0;
    const nondecreasingViolations = preferences.preferNondecreasingAnnualLoad
      ? loads.slice(1).reduce((sum, load, index) => sum + Math.max(0, loads[index] - load), 0)
      : 0;
    const typicalFinalYearLoads = preferences.typicalFinalYearTrackedLoad || [];
    const finalYearLoad = loads.at(-1) || 0;
    const finalYearGuidancePenalty = typicalFinalYearLoads.includes(finalYearLoad)
      ? 0
      : finalYearLoad === preferences.acceptableFinalYearTrackedLoad ? 1 : 2;
    const pacingScore = [firstYearTargetDistance, annualDistance, withinYearPenalty, nondecreasingViolations, finalYearGuidancePenalty];
    const completed = completedCourseSet(student);
    const standing = plan?.planningContext?.effectiveStanding || String(student?.academicStanding || "").toLowerCase();
    const firstYear = item => firstYearCourseCount(plan, item);
    if (standing === "freshman") {
      const introductions = ["ECO 113", "ECO 114"].filter(code => !completed.has(code));
      const introByYearOne = introductions.some(code => yearIndexForCourse(plan, code) === 0) ? 0 : 1;
      const introductionsInYearOne = introductions.filter(code => yearIndexForCourse(plan, code) === 0).length;
      const portableCount = firstYear(course => (
        [...MATH_OPTIONS, ...STATISTICS_OPTIONS].includes(course.course)
      ));
      const earlyAdvanced = firstYear(course => (
        /^ECO (2\d{2}|3\d{2}|4\d{2})$/.test(course.course)
        && !["ECO 257"].includes(course.course)
      ));
      return [...pacingScore, introByYearOne, introductionsInYearOne > 1 ? introductionsInYearOne - 1 : 0, portableCount ? 0 : 1, earlyAdvanced];
    }

    if (standing === "sophomore") {
      const has113 = completed.has("ECO 113");
      const has114 = completed.has("ECO 114");
      const hasMath = MATH_OPTIONS.some(code => completed.has(code));
      const priorityCourses = has113 && !has114
        ? ["ECO 114", ...(hasMath ? ["ECO 213"] : [])]
        : has114 && !has113
          ? ["ECO 113", ...(hasMath ? ["ECO 214"] : [])]
          : [];
      const sequenceLate = priorityCourses.reduce((sum, code) => (
        sum + (completed.has(code) || yearIndexForCourse(plan, code) === 0 ? 0 : 1)
      ), 0);
      const statsLate = STATISTICS_OPTIONS.some(code => completed.has(code))
        || STATISTICS_OPTIONS.some(code => yearIndexForCourse(plan, code) === 0)
        ? 0
        : 1;
      const mathLate = hasMath || MATH_OPTIONS.some(code => yearIndexForCourse(plan, code) === 0) ? 0 : 1;
      const preferredPrerequisites = new Set(has113 ? ["ECO 113", "ECO 213"] : ["ECO 114", "ECO 214"]);
      return [
        ...pacingScore,
        mathLate,
        sequenceLate,
        statsLate,
        statisticsSafetyPenalty(plan),
        electiveRelevancePenalty(plan, preferredPrerequisites, prerequisites)
      ];
    }
  }

  if (planVariant?.strategy === "one-year-early") {
    const maxEco = Math.max(0, ...(plan?.terms || []).map(term => (
      (term.courses || []).filter(course => isEconomicCourse(course.course)).length
    )));
    return [maxTermLoad, maxEco, annualDistance, withinYearPenalty];
  }

  return [annualDistance, withinYearPenalty, fallWinterImbalance(plan), maximumAnnualLoad];
}

function assessStrategyEligibility(candidate, planVariant, strategyBaseline) {
  if (planVariant?.strategy !== "explore-first") return { eligible: true, reason: null };
  if (!strategyBaseline?.validation?.valid) {
    return { eligible: false, reason: "EXPLORE_BASELINE_UNAVAILABLE" };
  }
  const expectedGraduationTerm = candidate?.planningContext?.expectedGraduationTerm || null;
  const baselineGraduationTerm = strategyBaseline?.planningContext?.expectedGraduationTerm || null;
  if (expectedGraduationTerm !== baselineGraduationTerm) {
    return { eligible: false, reason: "EXPLORE_GRADUATION_TERM_MISMATCH" };
  }
  const firstYearIndex = Number(planVariant.eligibility?.firstPlannedYearIndex || 0);
  const baselineFirstYearLoad = plannerTrackedYearLoad(strategyBaseline, firstYearIndex);
  const candidateFirstYearLoad = plannerTrackedYearLoad(candidate, firstYearIndex);
  if (planVariant.eligibility?.requiresStrictlyLighterFirstPlannedYear
    && candidateFirstYearLoad >= baselineFirstYearLoad) {
    return {
      eligible: false,
      reason: "EXPLORE_NOT_LIGHTER_THAN_BALANCED",
      baselineFirstYearLoad,
      candidateFirstYearLoad
    };
  }
  if (planVariant.eligibility?.requiresMaterialDifference
    && semanticPlanSignature(candidate) === semanticPlanSignature(strategyBaseline)) {
    return { eligible: false, reason: "EXPLORE_NOT_MATERIALLY_DISTINCT" };
  }
  return { eligible: true, reason: null, baselineFirstYearLoad, candidateFirstYearLoad };
}

function compareScoreArrays(left = [], right = []) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = Number(left[index] || 0) - Number(right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function capstoneYearIndex(plan) {
  const term = (plan?.terms || []).find(item => (
    (item.courses || []).some(course => course.course === "ECO 461")
  ));
  return Number.isInteger(Number(term?.yearIndex)) ? Number(term.yearIndex) : Number.MAX_SAFE_INTEGER;
}

function compareStrategyCandidates(left, right, options) {
  const capstoneDifference = capstoneYearIndex(left) - capstoneYearIndex(right);
  if (capstoneDifference) return capstoneDifference;
  const safetyDifference = compareAcademicSafetyPlans(left, right);
  if (safetyDifference) return safetyDifference;
  const scoreDifference = compareScoreArrays(
    strategyScore(left, options),
    strategyScore(right, options)
  );
  if (scoreDifference) return scoreDifference;
  const preliminaryMatches = plan => (plan?.terms || []).reduce((count, term) => (
    count + (term.courses || []).filter(course => course.preliminaryScheduleEvidence).length
  ), 0);
  return preliminaryMatches(right) - preliminaryMatches(left) || compareEconomicsPlans(left, right);
}

function offsetSolutionDiscovery(result, nodeOffset = 0, timeOffsetMs = 0) {
  const solutions = (result.solutions || []).map(solution => ({
    ...solution,
    foundAtNode: Number(nodeOffset || 0) + Number(solution.foundAtNode || 0),
    foundAtMs: Number(timeOffsetMs || 0) + Number(solution.foundAtMs || 0)
  }));
  return {
    ...result,
    solutions
  };
}

function candidatePoolSummary(search, finalValidPlans, eligibleFinalValidPlans, retainedPlans, rejectedPlans, exactDuplicatesRemoved, semanticDuplicatesRemoved, strategyIneligibleReasons = {}) {
  const firstFinalValid = [...eligibleFinalValidPlans]
    .filter(plan => Number.isFinite(Number(plan.searchDiscovery?.foundAtNode)))
    .sort((left, right) => left.searchDiscovery.foundAtNode - right.searchDiscovery.foundAtNode)[0] || null;
  const summary = {
    completeSchedulesExamined: Number(search?.completeSchedulesExamined || search?.completionAttempts || 0),
    prerequisiteValidSchedules: Number(search?.prerequisiteValidSchedules || search?.validSolutionCount || 0),
    finalValidSchedules: finalValidPlans.length,
    eligibleFinalValidSchedules: eligibleFinalValidPlans.length,
    strategyIneligibleSchedules: Math.max(0, finalValidPlans.length - eligibleFinalValidPlans.length),
    strategyIneligibleReasons,
    validatorRejectedSchedules: rejectedPlans.length,
    validatorRejectionReasons: Object.fromEntries(rejectedPlans.reduce((reasons, plan) => {
      const reason = plan.validation?.errors?.[0] || "The complete plan validator rejected this schedule.";
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
      return reasons;
    }, new Map())),
    exactDuplicatesRemoved: Number(search?.exactDuplicatesRemoved || 0) + exactDuplicatesRemoved,
    semanticDuplicatesRemoved,
    retainedDistinctSchedules: retainedPlans.length,
    retainedReserveCount: retainedPlans.length,
    perInvocationSolutionLimit: Number(search?.solutionLimit || TERM_SOLVER_SOLUTION_BUDGET),
    rawSolutionsEncountered: Number(search?.validSolutionCount || 0),
    totalRawSolutionsAcrossAttemptChain: Number(search?.totalRawSolutionsAcrossAttemptChain || search?.validSolutionCount || 0),
    firstFinalValidatorPlanNode: firstFinalValid?.searchDiscovery?.foundAtNode ?? null,
    firstIncumbentSignature: firstFinalValid ? semanticPlanSignature(firstFinalValid) : null,
    incumbentPreservedAtLimit: Boolean(firstFinalValid && search?.complete === false),
    nodesVisited: Number(search?.nodesVisited || 0),
    limit: Number(search?.limit || TERM_SOLVER_NODE_LIMIT),
    complete: Boolean(search?.complete),
    terminationReason: search?.terminationReason || (search?.complete ? "EXHAUSTED" : null)
  };
  Object.defineProperty(summary, "timeToFirstFinalValidatorPlanMs", {
    value: firstFinalValid?.searchDiscovery?.foundAtMs ?? null,
    enumerable: false,
    configurable: true
  });
  return summary;
}

function materializeSolverCandidate(basePlan, solutionEntry, {
  student,
  mapping,
  schedule,
  prerequisites,
  context,
  policyBundle = runtimePolicyBundle()
}) {
  const terms = solutionEntry.plan.terms;
  const targetYearCounts = basePlan.distribution?.targetYearCounts || [];
  const targetTermCounts = basePlan.distribution?.targetTermCounts || {};
  const actualYearCounts = targetYearCounts.map((targetCount, yearIndex) => ({
    yearIndex,
    targetCount,
    actualCount: terms
      .filter(term => term.yearIndex === yearIndex)
      .reduce((sum, term) => sum + term.courses.length, 0)
  }));
  const actualTermCounts = Object.fromEntries(Object.keys(targetTermCounts).map(slotId => [
    slotId,
    {
      targetCount: targetTermCounts[slotId],
      actualCount: terms.find(term => term.slotId === slotId)?.courses.length || 0
    }
  ]));
  const advisorChecks = [
    ...terms.flatMap(term => term.courses.flatMap(course => (
      course.approvalRequired || []
    ).map(approval => ({ course: course.course, term: term.term, reason: approval.message })))),
    ...(basePlan.annualDistributionException ? [{
      course: "Annual distribution",
      term: null,
      reason: basePlan.annualDistributionException.message
    }] : []),
    ...(basePlan.preferredDistributionException ? [{
      course: "Plan distribution",
      term: null,
      reason: basePlan.preferredDistributionException.message
    }] : []),
    ...(basePlan.search?.failure === "SEARCH_INCOMPLETE" ? [{
      course: "Plan search",
      term: null,
      reason: SEARCH_INCOMPLETE_MESSAGE
    }] : [])
  ];
  const summerFallbacks = terms.flatMap(term => term.courses
    .filter(course => course.source === "summer-last-resort")
    .map(course => ({
      course: course.course,
      term: term.term,
      reason: "Regular-term placement was not sufficient under the current prerequisites, schedule, and planning horizon."
    })));
  const plan = {
    ...basePlan,
    terms,
    unscheduled: [],
    advisorChecks,
    summerFallbacks,
    solverMetrics: solutionEntry.metrics,
    distribution: {
      ...basePlan.distribution,
      actualYearCounts,
      actualTermCounts
    }
  };
  plan.searchDiscovery = { foundAtNode: solutionEntry.foundAtNode ?? null };
  Object.defineProperty(plan.searchDiscovery, "foundAtMs", {
    value: solutionEntry.foundAtMs ?? null,
    enumerable: false,
    configurable: true
  });
  plan.validation = validateGeneratedPlan(plan, { student, mapping, schedule, prerequisites, context, policyBundle });
  applyDecisionContracts(plan, policyBundle);
  plan.requirementAllocation = plan.validation.requirementAllocation;
  if (plan.search?.terminationReason === "NODE_LIMIT" && plan.search?.solutionFound) {
    plan.validation.warnings.push("The solver found this valid plan but did not exhaust every possible alternative before reaching its safety limit.");
  }
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.prerequisiteNotices = buildPrerequisiteStatusNotices({plan, student, prerequisites});
  plan.warnings = [...new Set([
    ...plan.validation.warnings,
    ...(plan.preferredDistributionException ? [plan.preferredDistributionException.message] : []),
    ...(plan.annualDistributionException ? [plan.annualDistributionException.message] : [])
  ])];
  plan.studentMessages = [...new Set([
    ...plan.warnings,
    ...advisorChecks.map(item => item.reason).filter(Boolean),
    ...(plan.studentNotices || []).map(notice => notice.message),
    ...plan.prerequisiteNotices.map(notice => notice.message),
    ...plan.terms.flatMap(term => term.courses.map(course => course.studentHistoricalOfferingMessage).filter(Boolean)),
    ...(plan.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? [SEARCH_INCOMPLETE_MESSAGE] : [])
  ].filter(Boolean))];
  plan.feasibility = buildFeasibilityDetails(plan, student, plan.search);
  plan.verification = {
    status: plan.feasibilityStatus,
    scheduleVerifiedOn: normalizeEconomicsSchedule(schedule)?.provider?.verifiedOn || null,
    hasApprovals: plan.feasibility.requiredApprovals.length > 0,
    ...plan.feasibility.verification
  };
  plan.differentiationMetrics = planDifferentiationMetrics(plan, student);
  return plan;
}

export function validatePlanSet(plans = []) {
  const signatures = plans.map(semanticPlanSignature);
  const uniqueSignatures = new Set(signatures);
  const pairwise = [];
  for (let left = 0; left < plans.length; left += 1) {
    for (let right = left + 1; right < plans.length; right += 1) {
      pairwise.push({
        left: plans[left].label,
        right: plans[right].label,
        different: signatures[left] !== signatures[right]
      });
    }
  }
  const errors = pairwise.filter(pair => !pair.different).map(pair => `${pair.left} and ${pair.right} have the same material schedule.`);
  return {
    valid: plans.length > 0 && plans.length <= PLAN_VARIANTS.length + 1 && uniqueSignatures.size === plans.length && plans.every(plan => plan.validation?.valid !== false),
    planCount: plans.length,
    uniquePlanCount: uniqueSignatures.size,
    pairwise,
    errors
  };
}

function planCourseId(course) {
  return course.requirementId || `${course.course}-${course.source || "course"}`;
}

function choiceTermLabel(term) {
  return `${term.academicYear || ""} ${term.displayTerm || term.term}`.replaceAll("Spring/May", "May").trim();
}

function summarizeChoiceGroups(options, status) {
  const grouped = new Map();
  for (const option of options.filter(item => item.status === status)) {
    const key = option.message || "This choice needs further confirmation.";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(option.label);
  }
  return [...grouped.entries()].map(([reason, terms]) => `${terms.join(", ")}: ${reason}`);
}

function destinationCondition(course, validation, destination, policyBundle) {
  const details = [];
  const source = course?.source;
  if (source === "historical-pattern") {
    details.push(course.studentHistoricalOfferingMessage
      || `This ${course.course} placement follows an approved historical tendency, which does not guarantee an annual offering.`);
  } else if (["verified-offering", "summer-last-resort"].includes(source)) {
    // Exact schedule evidence already identifies this placement.
  } else if (source === "requirement-placeholder") {
    details.push("This elective placeholder does not identify a course or a confirmed term yet.");
  } else if (source === "term-to-confirm") {
    details.push("This term still needs confirmation against the published schedule.");
  } else {
    const coursePatterns = Object.values(policyBundle?.indexes?.offeringPatternsById || {}).filter(pattern => (
      [pattern.course].flat().includes(course?.course)
    ));
    const termKey = canonicalTerm(destination?.termKey || destination?.canonicalTerm || destination?.term);
    const pattern = coursePatterns.find(item => item.approvedRecurringTerms?.length
      || item.projectionPolicy?.normalTerms?.length);
    const approvedTerms = [...new Set((pattern?.approvedRecurringTerms || []).map(canonicalTerm))];
    const usualTerms = [...new Set((approvedTerms.length
      ? approvedTerms
      : pattern?.projectionPolicy?.normalTerms || []).map(canonicalTerm))];
    const termNames = keys => keys.map(key => ({ FALL: "Fall", WINTER: "Winter", MAY: "May", SUMMER: "Summer" }[key] || key)).join(" and ");
    const strictRecurringTerms = pattern?.projectionPolicy?.unpublishedTermEligibility === "APPROVED_RECURRING_TERMS_ONLY";
    if (pattern && approvedTerms.includes(termKey)) {
      details.push(`${course.course} is projected in its approved recurring ${termNames(usualTerms)} term${usualTerms.length === 1 ? "" : "s"}; the future schedule is unpublished, and this does not guarantee an annual offering.`);
    } else if (pattern && usualTerms.length && usualTerms.includes(termKey)) {
      details.push(`The recorded normal projection terms for ${course.course} are ${termNames(usualTerms)}; the future schedule is unpublished and annual availability is not guaranteed.`);
    } else if (pattern && usualTerms.length && !strictRecurringTerms) {
      details.push(`The recorded usual projection terms for ${course.course} are ${termNames(usualTerms)}. ${termNames([termKey])} remains eligible as a planning projection because this pattern has no binding exclusion for that term; confirm after the schedule is published.`);
    } else if (["projected-offering", "catalog-statement", "recurring-rule-unconfirmed"].includes(source)) {
      details.push("Projected placement; the exact schedule has not been published and may change.");
    }
  }
  for (const approval of course?.approvalRequired || []) {
    if (approval.message) details.push(approval.message);
    else details.push(`${approval.authority || "Advisor"} approval is required${approval.prerequisite ? ` for concurrent ${approval.prerequisite}` : ""}.`);
  }
  for (const condition of validation?.conditions || []) {
    if (condition.reasonCode?.startsWith("TERM_OVERLOAD") && condition.affectedObject?.termId !== canonicalTermId(destination)) continue;
    const message = condition.message || condition.question;
    if (message) details.push(message);
  }
  if (validation?.approved === false && !details.length) {
    details.push("This choice remains subject to the plan conditions shown in the advising information.");
  }
  return [...new Set(details)];
}

function testPlanEdit({ plan, plans, edit, destination, student, mapping, schedule, prerequisites, courseCatalog, policyBundle, context }) {
  const currentCourse = edit.type === "add-extra" ? { course: edit.course, extra: true } : plan.terms.flatMap(term => term.courses || []).find(course => planCourseId(course) === edit.courseId);
  if (!currentCourse) return { status: "BLOCKED", message: "The course is no longer in this plan. Regenerate the plan." };
  if (currentCourse.fixedInProgress) return { status: "BLOCKED", message: "A course already in progress cannot be moved or replaced." };
  const nextCourseCode = edit.type === "option"
    ? currentCourse.alternativeOptions?.find(option => option.id === edit.optionId)?.course
    : edit.type === "replace-move" ? edit.replacementCourse : currentCourse.course;
  const authoritativeSlots = new Map(planSlotsFor(student, context, mapping, [], policyBundle).map(slot => [slot.id, slot]));
  const authoritativeSlot = authoritativeSlots.get(destination.slotId);
  const modeledCourses = (destination.courses || []).filter(course => planCourseId(course) !== edit.courseId);
  modeledCourses.push({ ...currentCourse, course: nextCourseCode });
  const modeledTerm = { ...destination, courses: modeledCourses, reservedCourseUnits: authoritativeSlot?.reservedCourseUnits || 0, termLoadEvidence: authoritativeSlot?.termLoadEvidence || null };
  const loadDecision = evaluateTermLoad(modeledTerm, {}, policyBundle, {traceId: "move-load"});
  const loadMessage = termLoadMessage(loadDecision, policyBundle);
  const tuition = termLoadTuitionAdvisories((plan.terms || []).map(term => term.slotId === destination.slotId ? modeledTerm : { ...term, reservedCourseUnits: authoritativeSlots.get(term.slotId)?.reservedCourseUnits || 0, termLoadEvidence: authoritativeSlots.get(term.slotId)?.termLoadEvidence || null, courses: (term.courses || []).filter(course => planCourseId(course) !== edit.courseId) }), policyBundle);
  const loadDetails = { loadDecision, tuitionAdvisories: tuition };
  const blocked = (message, ruleId = null, sourceRefs = []) => ({status: "BLOCKED", ...loadDetails,
    message: [...new Set([message, loadMessage, ...tuition.map(item => item.message)].filter(Boolean))].join(" "),
    ruleId, sourceRefs: [...new Set([...sourceRefs, ...loadDecision.sourceRefs])]
  });
  const termEligibility = courseTermEligibility({ course: nextCourseCode }, destination, policyBundle);
  if (!termEligibility.allowed) return blocked(termEligibility.message || `${nextCourseCode} is not eligible in this term.`, termEligibility.ruleId, termEligibility.sourceRefs || []);

  try {
    const edited = applyEconomicsPlanEdit({
      plan,
      edit,
      student,
      mapping,
      schedule,
      prerequisites,
      courseCatalog,
      policyBundle,
      refreshAlternatives: false
    });
    const validation = validateGeneratedPlan(edited, {
      student,
      mapping,
      schedule,
      prerequisites,
      context,
      policyBundle,
      enforcePlanIntegrity: true
    });
    if (!validation.valid) {
      const outcome = blocked(validation.errors.join(" ") || "This change does not pass complete plan validation.");
      const failures = validation.policyDecision.decisions.filter(decision => ["BLOCK", "UNKNOWN"].includes(decision.status));
      if (failures.length && failures.every(decision => decision.reasonCode === "TERM_OVERLOAD_EVIDENCE_REQUIRED")) outcome.status = "REVIEW_REQUIRED";
      return outcome;
    }
    edited.validation = validation;
    const resultingPlans = (plans.length ? plans : [plan]).map(item => item.id === edited.id ? edited : item);
    const planSetValidation = validatePlanSet(resultingPlans);
    if (!planSetValidation.valid) return {
      status: "BLOCKED",
      message: planSetValidation.errors[0] || "This change would make the displayed plan comparison invalid.",
      ruleId: null,
      sourceRefs: []
    };
    const placedCourse = edited.terms.flatMap(term => term.courses || []).find(course => edit.type === "add-extra" ? course.extra && course.course === edit.course : planCourseId(course) === edit.courseId);
    const conditions = destinationCondition(placedCourse, validation, destination, policyBundle);
    // Moving a prerequisite can create an approval on its dependent course.
    const requiredApprovals = (validation.requiredApprovals || []).filter(approval =>
      approval.course === placedCourse?.course || approval.prerequisite === placedCourse?.course);
    conditions.push(...requiredApprovals.map(approval => approval.message).filter(Boolean));
    if (loadDecision.status === "CONDITIONAL") conditions.push(loadMessage);
    conditions.push(...tuition.map(item => item.message));
    return {
      ...loadDetails,
      status: conditions.length ? "CONDITIONAL" : "ALLOWED",
      requiredApprovals,
      message: [...new Set([loadMessage, ...conditions].filter(Boolean))].join(" ") || (placedCourse?.source === "verified-offering"
        ? "Verified schedule section; complete plan checks pass."
        : "Complete plan checks pass."),
      ruleId: termEligibility.ruleId || null,
      sourceRefs: termEligibility.sourceRefs || []
    };
  } catch (error) {
    return blocked(error.message || "This change does not pass complete plan validation.");
  }
}

/**
 * Rebuild planning controls by simulating each available edit through the same
 * edit function, complete validator, and plan-set check used by the API.
 */
export function annotateEconomicsPlanChoices({
  plans = [],
  student = {},
  mapping,
  schedule,
  prerequisites = {},
  courseCatalog = [],
  context = null,
  annotatePlanIds = null,
  policyBundle = runtimePolicyBundle()
} = {}) {
  return plans.map(plan => {
    // Keep every peer in edit/plan-set validation, but rebuild controls only for
    // the requested response. Generation continues to annotate the whole set.
    if (annotatePlanIds && !annotatePlanIds.includes(plan.id)) return plan;
    const planContext = selectedPlanContext(context, plan);
    const updatedPlan = structuredClone(plan);
    if (updatedPlan.validation) for (const key of ["conditions", "advisorActions", "readinessStatus", "planDisposition", "advisorActionRequired", "degreeRequirementInformation"]) {
      updatedPlan[key] = updatedPlan.validation[key];
    }
    const currentApprovals = updatedPlan.validation?.requiredApprovals || [];
    // Revalidation owns approvals; saved presentation fields are never authority.
    updatedPlan.advisorChecks = (updatedPlan.advisorChecks || []).filter(item => !/concurrent|approval/i.test(item.reason || ""));
    updatedPlan.studentMessages = (updatedPlan.studentMessages || []).filter(message => !/concurrent/i.test(message)
      || currentApprovals.some(item => item.message === message));
    for (const term of updatedPlan.terms || []) for (const course of term.courses || []) {
      const courseApprovals = currentApprovals.filter(item => item.course === course.course && item.term === term.term);
      if (courseApprovals.length) course.approvalRequired = courseApprovals;
      else delete course.approvalRequired;
      course.planningMarkers = [];
      if (course.course === "ECO 461") course.capstoneTimingDisplay = policyBundle.planningAdvice.display.capstone;
      if (currentApprovals.some(item => item.term === term.term && [item.course, item.prerequisite].includes(course.course))) course.planningMarkers.push("Approval required");
      if (course.course === "ECO 461" && planContext?.acceleratedPlanAssumesSeniorStanding) course.planningMarkers.push("Confirm senior standing");
      for (const action of updatedPlan.advisorActions || []) {
        if (action.affectedObject?.course !== course.course) continue;
        const marker = action.reasonCode?.startsWith("ENROLLMENT_") ? "Enrollment review required" : "Eligibility review required";
        if (!course.planningMarkers.includes(marker)) course.planningMarkers.push(marker);
      }
      const exact = scheduleOfferings(schedule, term, course.course).find(section => section.section === course.section);
      course.seatStatusDisplay = seatStatusPresentation(exact?.availability, {
        verified: Boolean(exact && course.section), referenceDate: student.planCreationDate || planContext?.planCreationDate
      });
      const fromTermId = term.slotId || term.term;
      const courseId = planCourseId(course);
      const currentOptionId = course.selectedOptionId || null;
      const moveOptions = (updatedPlan.terms || []).map(destination => {
        const destinationId = destination.slotId || destination.term;
        const label = choiceTermLabel(destination);
        if (destinationId === fromTermId) return {
          id: destinationId, label, status: "CURRENT", message: "Currently selected term.", ruleId: null, sourceRefs: []
        };
        const outcome = testPlanEdit({
          plan: updatedPlan,
          plans,
          edit: { type: "move", fromTermId, toTermId: destinationId, courseId },
          destination,
          student, mapping, schedule, prerequisites, courseCatalog, policyBundle, context: planContext
        });
        return { id: destinationId, label, ...outcome };
      });
      course.offeringInformation = courseOfferingInformation(course, policyBundle);
      course.replacementDestinationOptions = (updatedPlan.terms || []).flatMap(destination =>
        economicsReplacementCandidates({ course, destination, mapping, schedule, courseCatalog, policyBundle, plan: updatedPlan })
          .filter(option => option.course !== course.course)
          .map(option => {
            const toTermId = destination.slotId || destination.term;
            const outcome = testPlanEdit({ plan: updatedPlan, plans,
              edit: { type: "replace-move", fromTermId, toTermId, courseId, replacementCourse: option.course },
              destination, student, mapping, schedule, prerequisites, courseCatalog, policyBundle, context: planContext });
            return { id: `${toTermId}:${option.course}`, toTermId, course: option.course,
              label: choiceTermLabel(destination), title: option.title, minimumLevel: option.minimumLevel || null,
              ...outcome };
          }));
      course.moveDestinationOptions = moveOptions;
      course.moveDestinationIds = moveOptions
        .filter(option => ["CURRENT", "ALLOWED", "CONDITIONAL"].includes(option.status))
        .map(option => option.id);
      const usableMoves = moveOptions.filter(option => ["ALLOWED", "CONDITIONAL"].includes(option.status));
      const blockedMoves = moveOptions.filter(option => option.status === "BLOCKED");
      course.moveNoAlternativeNotice = usableMoves.length ? null : {
        studentMessage: `No other term currently passes complete plan checks for ${course.course} in this plan. ${[...summarizeChoiceGroups(blockedMoves, "BLOCKED"), ...summarizeChoiceGroups(moveOptions, "REVIEW_REQUIRED")].join(" ")}`.trim(),
        advisorMessage: `No other term currently passes complete plan checks for ${course.course} in this plan. ${[...summarizeChoiceGroups(blockedMoves, "BLOCKED"), ...summarizeChoiceGroups(moveOptions, "REVIEW_REQUIRED")].join(" ")}`.trim()
      };

      if (Array.isArray(course.alternativeOptions)) {
        course.alternativeOptions = course.alternativeOptions.map(option => {
          if (option.id === currentOptionId || option.course === course.course) {
            return { ...option, status: "CURRENT", message: "Currently selected course." };
          }
          const outcome = testPlanEdit({
            plan: updatedPlan,
            plans,
            edit: { type: "option", fromTermId, courseId, optionId: option.id },
            destination: term,
            student, mapping, schedule, prerequisites, courseCatalog, policyBundle, context: planContext
          });
          return { ...option, ...outcome };
        });
        const selectableReplacements = course.alternativeOptions.filter(option => option.status === "ALLOWED" || option.status === "CONDITIONAL");
        const blockedReplacements = course.alternativeOptions.filter(option => option.status === "BLOCKED");
        course.replacementNotice = selectableReplacements.some(option => option.course !== course.course) ? null : {
          studentMessage: `No alternate replacement for ${course.course} currently passes complete plan checks. ${summarizeChoiceGroups(blockedReplacements, "BLOCKED").join(" ")}`.trim(),
          advisorMessage: `No alternate replacement for ${course.course} currently passes complete plan checks. ${summarizeChoiceGroups(blockedReplacements, "BLOCKED").join(" ")}`.trim()
        };
      }

      const conditionalMoves = summarizeChoiceGroups(moveOptions, "CONDITIONAL");
      const blockedMoveGroups = summarizeChoiceGroups(moveOptions, "BLOCKED");
      const replacementDetails = (course.alternativeOptions || [])
        .filter(option => ["CONDITIONAL", "BLOCKED"].includes(option.status))
        .map(option => `${option.course}: ${option.message}`);
      const guidanceParts = [
        course.moveNoAlternativeNotice?.studentMessage,
        conditionalMoves.length ? `Conditional move choices: ${conditionalMoves.join(" ")}` : "",
        blockedMoveGroups.length && usableMoves.length ? `Unavailable move choices: ${blockedMoveGroups.join(" ")}` : "",
        course.replacementNotice?.studentMessage,
        replacementDetails.length && !course.replacementNotice ? `Replacement choices: ${[...new Set(replacementDetails)].join(" ")}` : ""
      ].filter(Boolean);
      course.moveGuidance = guidanceParts.length ? {
        studentMessage: guidanceParts.join(" "),
        advisorMessage: guidanceParts.join(" ")
      } : null;
    }
    for (const term of updatedPlan.terms || []) {
      const choices = extraCourseChoices({plan:updatedPlan,term,student,policyBundle,courseCatalog});
      const eligibleAtTerm = candidate => {
        const probe = structuredClone(updatedPlan);
        probe.terms.find(row => row.slotId === term.slotId).courses.push({course:candidate.course});
        const assessment = evaluatePlanPrerequisites({plan:probe,student,prerequisites,requireRecordedApprovals:false,policyBundle});
        return assessment.valid && !assessment.reviewFindings.some(item => item.subject?.course === candidate.course);
      };
      term.extraCourseHistory = choices.history.filter(eligibleAtTerm);
      term.extraCourseOptions = choices.candidates.filter(eligibleAtTerm).map(candidate => ({...candidate,
        ...testPlanEdit({plan:updatedPlan,plans,edit:{type:"add-extra",course:candidate.course,toTermId:term.slotId},
          destination:term,student,mapping,schedule,prerequisites,courseCatalog,policyBundle,context:planContext})
      }));
    }
    updatedPlan.advisorNotifications = (updatedPlan.advisorNotifications || [])
      .filter(notice => !String(notice.code || "").startsWith("PLAN_EDIT_OPTIONS_"));
    const noticeMessages = new Set((updatedPlan.studentNotices || []).map(notice => notice.message));
    const messages = [...new Set([...(updatedPlan.warnings || []), ...(updatedPlan.studentMessages || []),
      ...(updatedPlan.feasibility?.warnings || [])].filter(message => !noticeMessages.has(message)
        && !/projected placement/i.test(message)))];
    updatedPlan.planningDetailMessages = messages.filter(message => /depends on successful completion|^Seat availability for /i.test(message));
    updatedPlan.displayWarnings = messages.filter(message => !updatedPlan.planningDetailMessages.includes(message));
    if (updatedPlan.planningDetailMessages.some(message => /depends on successful completion/i.test(message))) {
      updatedPlan.displayWarnings.push(policyBundle.planningAdvice.display.prerequisiteCompletion);
    }
    if (updatedPlan.planningDetailMessages.some(message => /^Seat availability for /i.test(message))) {
      updatedPlan.displayWarnings.push(policyBundle.planningAdvice.display.seatConfirmation);
    }
    updatedPlan.displayWarnings.sort((left, right) => left.localeCompare(right));
    updatedPlan.planNotes = buildEconomicsPlanNotes({ plan: updatedPlan, student, mapping, policyBundle, courseCatalog });
    updatedPlan.feasibilityStatus = classifyFeasibility(updatedPlan, student);
    const searchEvidenceCleared = updatedPlan.search === null && updatedPlan.feasibility?.search === null;
    updatedPlan.feasibility = buildFeasibilityDetails(updatedPlan, student, updatedPlan.feasibility?.search || null);
    if (searchEvidenceCleared) updatedPlan.feasibility.search = null;
    updatedPlan.majorRequirementsChecklist = buildMajorRequirementsChecklist({ plan: updatedPlan, mapping });
    updatedPlan.planConditions = buildPlanConditions({ plan: updatedPlan, mapping, policyBundle, student });
    return updatedPlan;
  });
}

function _buildEconomicsTermPlanGreedy({
  student = {},
  mapping,
  schedule,
  prerequisites = {},
  courseCatalog = [],
  planningContext = null,
  planVariant = PLAN_VARIANTS[0],
  allowConcurrentMath = false,
  planningMode = "standard"
}) {
  const context = planningContext || (student.planCreationDate ? resolvePlanningContext(student) : null);
  if (context?.isTransferStudent && !context.transferValidation.valid) return null;
  const normalizedSchedule = normalizeEconomicsSchedule(schedule);

  const courses = normalizeStudentCourses(student.courses);
  const completedCodes = new Set(courses
    .filter(course => ["completed", "transfer"].includes(course.status) && canCountCompletedCourse(course))
    .map(course => course.code));
  const inProgressCodes = new Set(courses
    .filter(course => course.status === "in_progress" && canCountCompletedCourse(course))
    .map(course => course.code));
  const scheduledCodes = new Set([...completedCodes, ...inProgressCodes].map(code => canonicalScheduleCode(normalizedSchedule, code)));
  const slots = planSlotsFor(student, context, mapping, courseCatalog).map(slot => ({
    ...slot,
    academicYear: slot.academicYear || normalizedAcademicYear(normalizedSchedule?.academicYear)
  }));
  const unresolvedItems = remainingRequirements(mapping);
  const hasAssigned100LevelElective = assigned100LevelElectives(mapping).length >= electiveMaximum100(runtimePolicyBundle());
  const distribution = buildDistribution(unresolvedItems.length, context, planVariant, slots);
  const yearCounts = new Map();
  const termCounts = new Map();
  for (const slot of slots) {
    yearCounts.set(slot.yearIndex, (yearCounts.get(slot.yearIndex) || 0) + Number(slot.fixedTrackedCourseCount || 0));
    termCounts.set(slot.id, Number(slot.fixedTrackedCourseCount || 0));
  }
  const courseTitles = new Map(courseCatalog.map(course => [course.code, course.title]));
  const plannedCourseYears = new Map([...completedCodes].map(code => [code, -1]));
  const termPlans = slots.map(slot => ({
    slotId: slot.id,
    term: slot.label,
    displayTerm: slot.displayTerm || slot.termKey,
    academicYear: slot.academicYear || normalizedAcademicYear(normalizedSchedule?.academicYear),
    termKey: slot.termKey,
    scheduleTerm: slot.scheduleTerm,
    yearIndex: slot.yearIndex,
    absoluteStandingIndex: slot.absoluteStandingIndex,
    seniorStandingBasis: slot.seniorStandingBasis,
    isCurrentTerm: Boolean(slot.isCurrentTerm),
    inProgressPrerequisitesAvailable: slot.inProgressPrerequisitesAvailable,
    isSummer: slot.isSummer,
    courses: [...(slot.fixedCourses || [])]
  }));
  const unscheduled = [];
  const advisorChecks = [];
  const summerFallbacks = [];

  function availableForSlot(slotIndex) {
    const available = availableBeforeSlot(termPlans, slotIndex, completedCodes, inProgressCodes, context);
    return available;
  }

  function inProgressAvailableBeforeYear(yearIndex) {
    if (!context || context.isSummer || yearIndex > 0) return true;
    return slots.some(slot => (
      slot.yearIndex === yearIndex
      && !slot.isSummer
      && (PLANNING_TERM_INDEX.get(slot.termKey) ?? -1) > context.startTermIndex
    ));
  }

  function requirementPrerequisitesSatisfiedBeforeYear(code, yearIndex) {
    const rule = prerequisites?.[code];
    if (!rule) return true;
    const availableBeforeYear = requiredCode => (
      completedCodes.has(requiredCode)
      || (inProgressCodes.has(requiredCode) && inProgressAvailableBeforeYear(yearIndex))
      || (plannedCourseYears.has(requiredCode) && plannedCourseYears.get(requiredCode) < yearIndex)
    );
    if ((rule.all || []).some(requiredCode => !availableBeforeYear(requiredCode))) return false;
    return (rule.any || []).every(group => (
      group.some(availableBeforeYear)
      || (group.every(option => STATISTICS_OPTIONS.includes(option)) && availableBeforeYear(STATISTICS_REQUIREMENT))
    ));
  }

  function placeholderYearOrder() {
    return [...new Set(slots.map(slot => slot.yearIndex))].sort((left, right) => {
      const leftTarget = distribution.targetYearCounts[left] ?? 0;
      const rightTarget = distribution.targetYearCounts[right] ?? 0;
      const leftOpen = (yearCounts.get(left) || 0) < leftTarget ? 0 : 1;
      const rightOpen = (yearCounts.get(right) || 0) < rightTarget ? 0 : 1;
      return leftOpen - rightOpen || left - right;
    });
  }

  function latestSafeYearIndex(requirementId) {
    const finalYearIndex = Math.max(0, ...slots.map(slot => slot.yearIndex));
    if (["eco-113", "eco-114", "cognate"].includes(requirementId)) return Math.max(0, finalYearIndex - 1);
    if (["eco-213", "eco-214", "statistics"].includes(requirementId)) return finalYearIndex;
    return finalYearIndex;
  }

  function tryPlacePlaceholder(code, requirement, title, details = {}) {
    for (const yearIndex of placeholderYearOrder()) {
      if (yearIndex > latestSafeYearIndex(requirement.id)) continue;
      if (!requirementPrerequisitesSatisfiedBeforeYear(code, yearIndex)) continue;
      const candidateSlots = slots.filter(slot => slot.yearIndex === yearIndex && !slot.isSummer);
      for (const slot of candidateSlots) {
        const slotIndex = slots.indexOf(slot);
        const plan = termPlans[slotIndex];
        if (!projectedTermAllowed(code, slot, plan) || !canUseSlot(plan, slot, code, planningMode)) continue;
        plan.courses.push({
          course: code,
          title: title || courseTitles.get(code) || requirement.label,
          requirementId: requirement.id,
          source: "projected-offering",
          scheduleProvenance: SCHEDULE_PROVENANCE.PLANNING_PROJECTION,
          publicationStatus: SCHEDULE_PROVENANCE.PLANNING_PROJECTION,
          offeringStatus: "planning_projection",
          ...details
        });
        yearCounts.set(yearIndex, (yearCounts.get(yearIndex) || 0) + 1);
        termCounts.set(slot.id, (termCounts.get(slot.id) || 0) + 1);
        if (code !== "ECO elective") plannedCourseYears.set(code, yearIndex);
        return plan;
      }
    }
    return null;
  }

  function tryPlaceRecurringCapstone(code, requirement) {
    const candidateSlots = slots
      .filter(slot => slot.termKey === "Winter" && slot.absoluteStandingIndex >= 3)
      .sort((left, right) => left.yearIndex - right.yearIndex || left.order - right.order);
    for (const slot of candidateSlots) {
      const slotIndex = slots.indexOf(slot);
      const plan = termPlans[slotIndex];
      if (!canUseSlot(plan, slot, code, planningMode)) continue;
      const available = availableForSlot(slotIndex);
      if (prerequisiteMissing(code, available, prerequisites, slot).length) continue;
      plan.courses.push({
        course: code,
        title: courseTitles.get(code) || requirement.label,
        requirementId: requirement.id,
        source: "recurring-rule-unconfirmed",
        scheduleProvenance: SCHEDULE_PROVENANCE.PLANNING_PROJECTION,
        publicationStatus: SCHEDULE_PROVENANCE.PLANNING_PROJECTION,
        offeringStatus: "planning_projection",
        ...(code === "ECO 461" ? { residency: "hanover" } : {})
      });
      yearCounts.set(slot.yearIndex, (yearCounts.get(slot.yearIndex) || 0) + 1);
      termCounts.set(slot.id, (termCounts.get(slot.id) || 0) + 1);
      plannedCourseYears.set(code, slot.yearIndex);
      return plan;
    }
    return null;
  }

  function tryPlace(code, requirementId, allowSummer = false) {
    const candidateSlots = slots.filter(slot => (allowSummer || !slot.isSummer) && (allowSummer || slot.termKey !== "Summer"));
    for (const slot of preferredSlotOrder(candidateSlots, context, distribution, yearCounts, termCounts)) {
      const slotIndex = slots.indexOf(slot);
      const plan = termPlans[slotIndex];
      if (!canUseSlot(plan, slot, code, planningMode)) continue;
      if (!isSeniorWinterOnly(code, slot, student, context)) continue;
      const offering = selectConflictFreeOffering(normalizedSchedule, slot, code, plan.courses);
      if (!offering) continue;

      const available = availableForSlot(slotIndex);
      const assessment = concurrentPrerequisiteAssessment(
        code,
        available,
        new Set(plan.courses.map(course => course.course)),
        prerequisites,
        slot
      );
      const canUseConcurrentMath = allowConcurrentMath
        && assessment.missing.length === 0
        && assessment.approvals.length > 0;
      const missing = canUseConcurrentMath
        ? []
        : prerequisiteMissing(code, available, prerequisites, slot);
      if (missing.length) {
        addAdvisorCheck(advisorChecks, {
          course: code,
          term: plan.term,
          reason: `Prerequisites must be completed before this course: ${missing.join("; ")}`
        });
        continue;
      }

      return {
        slot,
        slotIndex,
        plan,
        offering,
        concurrentApprovals: canUseConcurrentMath ? assessment.approvals : []
      };
    }
    return null;
  }

  function projectedTermAllowed(code, slot, plan) {
    return !slot.isSummer && !slot.isPlaceholder
      && normalizedAcademicYear(slot.academicYear) !== normalizedAcademicYear(normalizedSchedule?.academicYear)
      && courseTermEligibility({ course: code }, { ...slot, courses: plan.courses }, runtimePolicyBundle()).allowed;
  }

  function tryPlaceProjected(code, requirement, details = {}) {
    const candidateSlots = preferredSlotOrder(
      slots.filter(slot => !slot.isSummer),
      context,
      distribution,
      yearCounts,
      termCounts
    );
    for (const slot of candidateSlots) {
      const slotIndex = slots.indexOf(slot);
      const plan = termPlans[slotIndex];
      if (!projectedTermAllowed(code, slot, plan)) continue;
      if (!canUseSlot(plan, slot, code, planningMode)) continue;
      if (!isSeniorWinterOnly(code, slot, student, context)) continue;
      const available = availableForSlot(slotIndex);
      const sameTermCodes = new Set(plan.courses.map(course => course.course));
      sameTermCodes.add(code);
      const assessment = concurrentPrerequisiteAssessment(
        code,
        available,
        sameTermCodes,
        prerequisites,
        slot
      );
      const canUseConcurrentApproval = allowConcurrentMath
        && assessment.missing.length === 0
        && assessment.approvals.length > 0;
      const missing = canUseConcurrentApproval ? [] : prerequisiteMissing(code, available, prerequisites, slot);
      if (missing.length) continue;
      const course = {
        course: code,
        title: code === "ECO elective"
          ? "Eligible ECO elective (future offering to verify)"
          : courseTitles.get(code) || requirement.label,
        requirementId: requirement.id,
        source: "projected-offering",
        scheduleProvenance: SCHEDULE_PROVENANCE.PLANNING_PROJECTION,
        publicationStatus: SCHEDULE_PROVENANCE.PLANNING_PROJECTION,
        offeringStatus: "planning_projection",
        verificationStatus: "unverified",
        ...(code === "ECO 461" ? { residency: "hanover" } : {}),
        ...(assessment.approvals.length ? { approvalRequired: assessment.approvals } : {}),
        ...details
      };
      plan.courses.push(course);
      yearCounts.set(slot.yearIndex, (yearCounts.get(slot.yearIndex) || 0) + 1);
      termCounts.set(slot.id, (termCounts.get(slot.id) || 0) + 1);
      if (code !== "ECO elective") {
        scheduledCodes.add(code);
        plannedCourseYears.set(code, slot.yearIndex);
      }
      for (const approval of assessment.approvals) {
        const authority = approval.type === "department" ? "Economics Department" : `${code} instructor`;
        addAdvisorCheck(advisorChecks, {
          course: code,
          term: plan.term,
          reason: `${approval.prerequisite} is projected concurrently with ${code}; approval from the ${authority} is required.`
        });
      }
      return plan;
    }
    return null;
  }

  function commitVerifiedPlacement(code, requirement, selectedPlacement) {
    selectedPlacement.plan.courses.push({
      ...selectedPlacement.offering,
      requirementId: requirement.id,
      source: selectedPlacement.slot.isSummer ? "summer-last-resort" : "verified-offering",
      ...(code === "ECO 461" ? { residency: "hanover" } : {}),
      ...(selectedPlacement.concurrentApprovals.length
        ? { approvalRequired: selectedPlacement.concurrentApprovals }
        : {})
    });
    yearCounts.set(selectedPlacement.slot.yearIndex, (yearCounts.get(selectedPlacement.slot.yearIndex) || 0) + 1);
    termCounts.set(selectedPlacement.slot.id, (termCounts.get(selectedPlacement.slot.id) || 0) + 1);
    scheduledCodes.add(canonicalScheduleCode(normalizedSchedule, code));
    plannedCourseYears.set(code, selectedPlacement.slot.yearIndex);
    for (const approval of selectedPlacement.concurrentApprovals) {
      const authority = approval.type === "department"
        ? "Economics Department"
        : `${code} instructor`;
      addAdvisorCheck(advisorChecks, {
        course: code,
        term: selectedPlacement.plan.term,
        reason: `${approval.prerequisite} is placed with ${code} because no prerequisite-first placement fits this plan. Concurrent enrollment requires approval from the ${authority}.`
      });
    }
    if (selectedPlacement.slot.isSummer) {
      const summerFallback = {
        course: code,
        term: selectedPlacement.plan.term,
        reason: "Regular-term placement was not sufficient under the current prerequisites, schedule, and planning horizon."
      };
      summerFallbacks.push(summerFallback);
      addAdvisorCheck(advisorChecks, {
        course: code,
        term: selectedPlacement.plan.term,
        reason: `Summer, online, last-resort option. ${summerFallback.reason}`
      });
    }
  }

  function tryPlaceStatisticsAssumption(requirement) {
    if (context?.effectiveStanding !== "senior" && !(context?.earlyGraduation && context.remainingYears === 1)) return null;
    const fallSlots = slots
      .filter(slot => slot.termKey === "Fall" && scheduleOfferings(normalizedSchedule, slot, "ECO 213").length > 0)
      .sort((left, right) => left.order - right.order);
    for (const slot of fallSlots) {
      const slotIndex = slots.indexOf(slot);
      const plan = termPlans[slotIndex];
      if (!canUseSlot(plan, slot, STATISTICS_REQUIREMENT, planningMode)) continue;
      plan.courses.push({
        course: STATISTICS_REQUIREMENT,
        title: STATISTICS_OPTIONS.join(", "),
        requirementId: requirement.id,
        source: "requirement-placeholder",
        offeringStatus: "schedule_confirmation_required",
        verificationStatus: "unverified",
        options: [...STATISTICS_OPTIONS]
      });
      yearCounts.set(slot.yearIndex, (yearCounts.get(slot.yearIndex) || 0) + 1);
      termCounts.set(slot.id, (termCounts.get(slot.id) || 0) + 1);
      scheduledCodes.add(STATISTICS_REQUIREMENT);
      plannedCourseYears.set(STATISTICS_REQUIREMENT, slot.yearIndex);
      addAdvisorCheck(advisorChecks, {
        course: STATISTICS_REQUIREMENT,
        term: plan.term,
        reason: `Schedule confirmation required: verify that ${STATISTICS_OPTIONS.join(", ")} is offered and does not conflict with the listed Economics courses.`
      });
      return plan;
    }
    return null;
  }

  function electiveCourseOrder(requirement) {
    const excluded = new Set(requirement.excludedCourses || []);
    const scheduledOfferings = slots.flatMap(slot => (
      (normalizedSchedule?.terms?.[slot.scheduleTerm] || [])
        .filter(offering => normalizedAcademicYear(offering.academicYear) === normalizedAcademicYear(slot.academicYear))
    ));
    const codes = [...new Set(scheduledOfferings.map(offering => offering.course))]
      .filter(code => isEconomicCourse(code) && !excluded.has(code) && isValidElectiveCourse(requirement, code, mapping));
    if (planVariant.strategy === "explore-first") {
      return codes.sort((left, right) => {
        if (left === "ECO 260") return -1;
        if (right === "ECO 260") return 1;
        return 0;
      });
    }
    return codes;
  }

  function tryPlaceVerifiedElective(requirement) {
    const selected100LevelCount = assigned100LevelElectives(mapping).length
      + termPlans.flatMap(term => term.courses).filter(course => (
        String(course.requirementId || "").startsWith("eco-elective")
        && is100LevelEconomicsCourse(course.course)
      )).length;
    for (const code of electiveCourseOrder(requirement)) {
      const canonicalCode = canonicalScheduleCode(normalizedSchedule, code);
      if (scheduledCodes.has(canonicalCode)) continue;
      if (is100LevelEconomicsCourse(code) && selected100LevelCount >= electiveMaximum100(runtimePolicyBundle())) continue;
      const placement = tryPlace(code, requirement.id);
      if (!placement) continue;
      commitVerifiedPlacement(code, requirement, placement);
      return placement.plan;
    }
    return null;
  }

  for (const item of unresolvedItems) {
    const requirement = (mapping.requirements || []).find(candidate => candidate.id === item.requirementId);
    if (!requirement) continue;

    if (requirement.kind === "elective") {
      const verifiedPlacement = tryPlaceVerifiedElective(requirement);
      const projectedPlacement = verifiedPlacement ? null : tryPlaceProjected(
        "ECO elective",
        requirement,
        hasAssigned100LevelElective ? { minimumLevel: electivePlaceholderMinimumLevel(runtimePolicyBundle()) } : {}
      );
      const placement = verifiedPlacement || projectedPlacement || tryPlacePlaceholder(
        "ECO elective",
        requirement,
        hasAssigned100LevelElective
          ? "ECO elective at the 200 level or above (future offering to verify)"
          : "Eligible ECO elective (future offering to verify)",
        hasAssigned100LevelElective ? { minimumLevel: electivePlaceholderMinimumLevel(runtimePolicyBundle()) } : {}
      );
      if (placement) {
        // Verified offerings are preferred; future schedules remain explicit placeholders.
      } else {
        unscheduled.push({
          requirementId: requirement.id,
          label: requirement.label,
          course: "ECO elective",
          reason: "No safe academic year has capacity for this elective placeholder."
        });
      }
      continue;
    }

    let placed = false;
    for (const code of orderedRequirementOptions(requirement)) {
      if (scheduledCodes.has(code)) continue;
      const placement = tryPlace(code, requirement.id);
      if (placement) {
        commitVerifiedPlacement(code, requirement, placement);
        placed = true;
        break;
      }
      const summerPlacement = code === "ECO 113"
        ? tryPlace(code, requirement.id, true)
        : null;
      if (summerPlacement) {
        commitVerifiedPlacement(code, requirement, summerPlacement);
        placed = true;
        break;
      }
      const projectedPlacement = tryPlaceProjected(code, requirement);
      if (projectedPlacement) {
        placed = true;
        break;
      }
    }

    if (!placed && requirement.id === "statistics") {
      placed = Boolean(tryPlaceStatisticsAssumption(requirement));
    }

    if (!placed && requirement.id === "eco-461") {
      placed = Boolean(tryPlaceRecurringCapstone("ECO 461", requirement));
    }

    if (!placed) {
      for (const code of orderedRequirementOptions(requirement)) {
        if (scheduledCodes.has(code)) continue;
        const placeholder = tryPlacePlaceholder(code, requirement);
        if (!placeholder) continue;
        scheduledCodes.add(code);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const graduationReason = requirement.id === "eco-461" && context?.effectiveStanding === "senior"
        ? `ECO 461 cannot be completed by ${context.expectedGraduationTerm}: ECO 213, ECO 214, and the statistics requirement must be completed before senior Winter; same-term enrollment does not satisfy those prerequisites.`
        : "No safe year is available under the current prerequisites and graduation horizon.";
      unscheduled.push({
        requirementId: requirement.id,
        label: requirement.label,
        course: (requirement.options || []).join(" / ") || requirement.label,
        reason: graduationReason
      });
    }
  }

  for (const plan of termPlans) {
    if ((plan.termKey === "Spring" || plan.termKey === "May") && plan.courses.length > 1) {
      addAdvisorCheck(advisorChecks, {
        course: "Spring/May",
        term: plan.term,
        reason: "Spring/May is limited to one total course."
      });
    }
  }

  const plan = {
    id: planVariant.id,
    label: planVariant.label,
    description: planningMode === "graduation_priority"
      ? "Graduation-priority pacing uses verified offerings and permits a heavier Economics load when the standard limit cannot finish the major on time."
      : planVariant.description,
    academicYear: normalizedSchedule?.academicYear || null,
    isEarlyGraduation: Boolean(context?.earlyGraduation),
    isExtendedGraduation: Boolean(context?.extendedGraduation),
    planningMode,
    planningContext: context,
    distribution: {
      ...distribution,
      actualYearCounts: distribution.targetYearCounts.map((targetCount, yearIndex) => ({
        yearIndex,
        targetCount,
        actualCount: yearCounts.get(yearIndex) || 0
      })),
      actualTermCounts: Object.fromEntries(Object.keys(distribution.targetTermCounts).map(slotId => [
        slotId,
        { targetCount: distribution.targetTermCounts[slotId], actualCount: termCounts.get(slotId) || 0 }
      ]))
    },
    terms: visibleTerms(termPlans),
    unscheduled,
    advisorChecks,
    summerFallbacks,
    rules: canonicalPlanningRuleSummaries()
  };
  plan.validation = validateGeneratedPlan(plan, { student, mapping, schedule: normalizedSchedule, prerequisites, context });
  applyDecisionContracts(plan);
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.prerequisiteNotices = buildPrerequisiteStatusNotices({plan, student, prerequisites});
  plan.studentMessages = [...new Set([
    ...plan.validation.warnings,
    ...(plan.studentNotices || []).map(notice => notice.message),
    ...plan.prerequisiteNotices.map(notice => notice.message),
    ...plan.terms.flatMap(term => term.courses.map(course => course.studentHistoricalOfferingMessage).filter(Boolean)),
    ...plan.terms.flatMap(term => term.courses.flatMap(course => (
      course.approvalRequired || []
    ).map(approval => approval.type === "department"
      ? `${approval.prerequisite} is planned concurrently with ${course.course}. Economics Department approval is required.`
      : `${approval.prerequisite} is planned concurrently with ${course.course}. Approval from the ${course.course} instructor is required.`)))
  ].filter(Boolean))];
  plan.verification = {
    status: plan.feasibilityStatus,
    scheduleVerifiedOn: normalizedSchedule?.provider?.verifiedOn || null,
    hasApprovals: advisorChecks.length > 0
  };
  plan.warnings = plan.validation.warnings;
  return plan;
}

export function buildEconomicsTermPlan({
  student = {},
  mapping,
  schedule: _schedule,
  prerequisites = {},
  courseCatalog = [],
  planningContext = null,
  planVariant = PLAN_VARIANTS[0],
  allowConcurrentMath = false,
  planningMode = "standard",
  nodeLimit = TERM_SOLVER_NODE_LIMIT,
  candidateLimit = CANDIDATE_POOL_LIMIT,
  solutionBudget = TERM_SOLVER_SOLUTION_BUDGET,
  strategyBaseline = null,
  metricsDiagnostics = null,
  diagnosticContext = null,
  policyBundle = runtimePolicyBundle()
}) {
  const baseContext = planningContext || (student.planCreationDate ? resolvePlanningContext(student) : null);
  const context = baseContext ? withCatalogApplicability(baseContext, student, policyBundle) : null;
  if (context?.isTransferStudent && !context.transferValidation.valid) return null;
  const effectiveStrategyBaseline = planVariant.strategy === "explore-first" && !strategyBaseline
    ? buildEconomicsTermPlan({
        student,
        mapping,
        schedule: _schedule,
        prerequisites,
        courseCatalog,
        planningContext: context,
        planVariant: PLAN_VARIANTS.find(variant => variant.strategy === planVariant.eligibility?.baselineStrategyId),
        allowConcurrentMath,
        planningMode,
        nodeLimit,
        candidateLimit,
        solutionBudget,
        policyBundle
      })
    : strategyBaseline;
  const normalizedSchedule = normalizeEconomicsSchedule(runtimeEconomicsSchedule());
  const slots = planSlotsFor(student, context, mapping, courseCatalog, policyBundle).map(slot => ({
    ...slot,
    academicYear: slot.academicYear || normalizedAcademicYear(normalizedSchedule?.academicYear)
  }));
  const unresolvedItems = remainingRequirements(mapping);
  const distribution = buildDistribution(unresolvedItems.length, context, planVariant, slots, effectiveStrategyBaseline);
  const requirementPriority = exploreFirstRequirementPriority(student, planVariant, context);
  const searchLimit = Math.max(1, Number(nodeLimit) || TERM_SOLVER_NODE_LIMIT);
  const preferredSearchLimit = Math.max(1, Math.min(
    searchLimit,
    Math.floor(searchLimit * PREFERRED_SEARCH_BUDGET_SHARE)
  ));
  const solverSolutionBudget = Math.max(1, Math.min(
    TERM_SOLVER_SOLUTION_BUDGET,
    Number(solutionBudget) || TERM_SOLVER_SOLUTION_BUDGET
  ));
  const runSearch = (stage, input) => {
    const startedAt = diagnosticsNow();
    const result = solveEconomicsTermPlan(input);
    Object.defineProperty(result.search, "durationMs", {
      value: roundDiagnosticDuration(diagnosticsNow() - startedAt),
      enumerable: false,
      configurable: true
    });
    if (metricsDiagnostics?.searchAttempts) {
      metricsDiagnostics.searchAttempts.push(solverDiagnostic(result, {
        ...(diagnosticContext || {}),
        strategyId: planVariant.id,
        strategyLabel: planVariant.label,
        strategy: planVariant.strategy,
        planningMode,
        allowConcurrentMath,
        approvalMode: allowConcurrentMath ? "DOCUMENTED_CONCURRENCY_ALLOWED" : "STRICT_PREREQUISITES",
        concurrencyMode: allowConcurrentMath ? "ALLOW_APPROVED_CONCURRENCY" : "NO_CONCURRENCY",
        innerSearchStage: stage
      }, diagnosticsNow() - startedAt));
    }
    return result;
  };
  const preferredSearch = runSearch("preferred-distribution", {
    student,
    mapping,
    schedule: normalizedSchedule,
    prerequisites,
    courseCatalog,
    slots,
    context,
    distribution,
    planVariant,
    planningMode,
    allowConcurrentMath,
    policyBundle,
    requireAnnualCoverage: true,
    requireTargetDistribution: true,
    nodeLimit: preferredSearchLimit,
    solutionBudget: solverSolutionBudget,
    ...(requirementPriority ? { requirementPriority, prioritizeEarlyRequirements: true } : {})
  });
  let selectedSearch = preferredSearch;
  let preferredDistributionException = null;
  let annualDistributionException = null;
  if (!preferredSearch.solution) {
    const rescueReason = preferredSearch.search.complete === false
      ? "NORMAL_SEARCH_INCOMPLETE_WITHOUT_INCUMBENT"
      : "NORMAL_SEARCH_ZERO_SOLUTIONS";
    const preferredNodes = Number(preferredSearch.search.nodesVisited || 0);
    const normalRelaxedLimit = Math.max(1, Math.min(
      searchLimit - preferredNodes,
      Math.floor(searchLimit * NORMAL_RELAXED_RESCUE_BUDGET_SHARE)
    ));
    const normalRelaxedRaw = runSearch("soft-preference-rescue", {
      student,
      mapping,
      schedule: normalizedSchedule,
      prerequisites,
      courseCatalog,
      slots,
      context,
      distribution,
      planVariant,
      planningMode,
      allowConcurrentMath,
      policyBundle,
      requireAnnualCoverage: false,
      requireTargetDistribution: false,
      nodeLimit: normalRelaxedLimit,
      solutionBudget: solverSolutionBudget,
      searchStrategy: "normal",
      ...(requirementPriority ? { requirementPriority, prioritizeEarlyRequirements: true } : {})
    });
    const normalRelaxedSearch = offsetSolutionDiscovery(
      normalRelaxedRaw,
      preferredNodes,
      preferredSearch.search.durationMs
    );
    selectedSearch = {
      ...normalRelaxedSearch,
      search: combineSearchDiagnostics(
        preferredSearch,
        normalRelaxedSearch,
        preferredNodes + normalRelaxedLimit,
        { innerSearchStage: "preferred-distribution", annualCoverageRequired: true, preferredDistributionRequired: true },
        {
          innerSearchStage: "soft-preference-rescue",
          annualCoverageRequired: false,
          preferredDistributionRequired: false,
          rescue: true,
          rescueReason,
          searchStrategy: "normal",
          softConstraintsRelaxed: ["PREFERRED_DISTRIBUTION", "ANNUAL_COVERAGE"]
        }
      )
    };
    if (normalRelaxedSearch.search.complete) {
      selectedSearch.search.complete = true;
      selectedSearch.search.rescueExhaustiveForRelaxedSuperset = true;
    }
    selectedSearch.search.rescueTriggered = true;
    if (!normalRelaxedSearch.solution && normalRelaxedSearch.search.complete === false) {
      const priorNodes = preferredNodes + Number(normalRelaxedSearch.search.nodesVisited || 0);
      const priorDurationMs = Number(preferredSearch.search.durationMs || 0) + Number(normalRelaxedSearch.search.durationMs || 0);
      const rescueLimit = Math.max(1, searchLimit - priorNodes);
      const rescueRaw = runSearch("same-solver-rescue", {
        student,
        mapping,
        schedule: normalizedSchedule,
        prerequisites,
        courseCatalog,
        slots,
        context,
        distribution,
        planVariant,
        planningMode,
        allowConcurrentMath,
        policyBundle,
        requireAnnualCoverage: false,
        requireTargetDistribution: false,
        nodeLimit: rescueLimit,
        solutionBudget: solverSolutionBudget,
        searchStrategy: "rescue",
        ...(requirementPriority ? { requirementPriority, prioritizeEarlyRequirements: true } : {})
      });
      const rescueSearch = offsetSolutionDiscovery(rescueRaw, priorNodes, priorDurationMs);
      selectedSearch = {
        ...rescueSearch,
        search: combineSearchDiagnostics(
          selectedSearch,
          rescueSearch,
          searchLimit,
          {},
          {
            innerSearchStage: "same-solver-rescue",
            annualCoverageRequired: false,
            preferredDistributionRequired: false,
            rescue: true,
            rescueReason,
            searchStrategy: "rescue",
            softConstraintsRelaxed: ["PREFERRED_DISTRIBUTION", "ANNUAL_COVERAGE"]
          }
        )
      };
      if (rescueSearch.search.complete) {
        selectedSearch.search.complete = true;
        selectedSearch.search.rescueExhaustiveForRelaxedSuperset = true;
      }
      selectedSearch.search.rescueTriggered = true;
    }
    if (selectedSearch.solution) {
      const actualYearCounts = annualCourseCounts(selectedSearch.solution, distribution.targetYearCounts);
      const allowedAnnualDistance = distribution.targetYearCounts.reduce((sum, target, yearIndex) => (
        sum + Math.abs(target - actualYearCounts[yearIndex])
      ), 0);
      preferredDistributionException = {
        code: "PREFERRED_DISTRIBUTION_EXCEPTION",
        allowedAnnualDistance,
        targetYearCounts: [...distribution.targetYearCounts],
        actualYearCounts,
        message: preferredSearch.search.complete
          ? `The exact ${distributionDesignLabel(distribution.strategy)} yearly distribution is not feasible under the current prerequisite and offering sequence. This plan uses a validated alternative distribution.`
          : `This validated plan uses an alternative to the preferred ${distributionDesignLabel(distribution.strategy)} yearly distribution because the preference is nonblocking.`
      };
      annualDistributionException = {
        code: "ANNUAL_DISTRIBUTION_EXCEPTION",
        message: "This validated plan uses an alternative to the nonblocking annual-distribution preference."
      };
    }
  }
  selectedSearch.search.limit = searchLimit;

  const solutionTerms = selectedSearch.solution?.terms || slots.map(slot => ({
    slotId: slot.id,
    term: slot.label,
    displayTerm: slot.displayTerm || slot.termKey,
    academicYear: slot.academicYear || normalizedAcademicYear(normalizedSchedule?.academicYear),
    termKey: slot.termKey,
    scheduleTerm: slot.scheduleTerm,
    yearIndex: slot.yearIndex,
    absoluteStandingIndex: slot.absoluteStandingIndex,
    seniorStandingBasis: slot.seniorStandingBasis,
    isCurrentTerm: Boolean(slot.isCurrentTerm),
    inProgressPrerequisitesAvailable: slot.inProgressPrerequisitesAvailable,
    isSummer: slot.isSummer,
    courses: [...(slot.fixedCourses || [])]
  })).filter(term => !term.isSummer);
  const placedRequirementIds = new Set(solutionTerms.flatMap(term => term.courses.map(course => course.requirementId)));
  const unscheduled = selectedSearch.solution ? [] : unresolvedItems
    .filter(item => !placedRequirementIds.has(item.requirementId))
    .map(item => ({
      requirementId: item.requirementId,
      label: item.label,
      course: (item.options || []).join(" / ") || item.label,
      reason: selectedSearch.failure === "SEARCH_INCOMPLETE"
        ? SEARCH_INCOMPLETE_MESSAGE
        : "No complete assignment satisfies the term-level prerequisites, verified offerings, and recorded term-load capacity."
    }));
  const actualYearCounts = distribution.targetYearCounts.map((targetCount, yearIndex) => ({
    yearIndex,
    targetCount,
    actualCount: solutionTerms.filter(term => term.yearIndex === yearIndex)
      .reduce((sum, term) => sum + term.courses.length, 0)
  }));
  const actualTermCounts = Object.fromEntries(Object.keys(distribution.targetTermCounts).map(slotId => [
    slotId,
    {
      targetCount: distribution.targetTermCounts[slotId],
      actualCount: solutionTerms.find(term => term.slotId === slotId)?.courses.length || 0
    }
  ]));
  const advisorChecks = solutionTerms.flatMap(term => term.courses.flatMap(course => (
    course.approvalRequired || []
  ).map(approval => ({ course: course.course, term: term.term, reason: approval.message }))));
  if (annualDistributionException) advisorChecks.push({
    course: "Annual distribution",
    term: null,
    reason: annualDistributionException.message
  });
  if (preferredDistributionException) advisorChecks.push({
    course: "Plan distribution",
    term: null,
    reason: preferredDistributionException.message
  });
  if (selectedSearch.failure === "SEARCH_INCOMPLETE") advisorChecks.push({
    course: "Plan search",
    term: null,
    reason: SEARCH_INCOMPLETE_MESSAGE
  });
  const summerFallbacks = solutionTerms.flatMap(term => term.courses
    .filter(course => course.source === "summer-last-resort")
    .map(course => ({
      course: course.course,
      term: term.term,
      reason: "Regular-term placement was not sufficient under the current prerequisites, schedule, and planning horizon."
    })));
  const plan = {
    id: planVariant.id,
    label: planVariant.label,
    description: planningMode === "graduation_priority"
      ? "Graduation-priority pacing permits a heavier Economics load only when it is needed to reach the selected graduation term."
      : planVariant.description,
    academicYear: normalizedSchedule?.academicYear || null,
    isEarlyGraduation: Boolean(context?.earlyGraduation),
    isExtendedGraduation: Boolean(context?.extendedGraduation),
    planningMode,
    planningContext: context,
    distribution: { ...distribution, actualYearCounts, actualTermCounts },
    preferredDistributionException,
    terms: solutionTerms,
    unscheduled,
    advisorChecks,
    summerFallbacks,
    annualDistributionException,
    solverMetrics: selectedSearch.metrics,
    solverFailure: selectedSearch.failure,
    search: {
      ...selectedSearch.search,
      failure: selectedSearch.failure,
      solutionFound: Boolean(selectedSearch.solution)
    },
    rules: canonicalPlanningRuleSummaries()
  };
  plan.validation = validateGeneratedPlan(plan, {
    student,
    mapping,
    schedule: normalizedSchedule,
    prerequisites,
    context,
    policyBundle
  });
  applyDecisionContracts(plan, policyBundle);
  plan.requirementAllocation = plan.validation.requirementAllocation;
  if (selectedSearch.search.terminationReason === "NODE_LIMIT" && selectedSearch.solution) {
    plan.validation.warnings.push("The solver found this valid plan but did not exhaust every possible alternative before reaching its safety limit.");
  }
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.prerequisiteNotices = buildPrerequisiteStatusNotices({plan, student, prerequisites});
  plan.warnings = [...new Set([
    ...plan.validation.warnings,
    ...(preferredDistributionException ? [preferredDistributionException.message] : []),
    ...(annualDistributionException ? [annualDistributionException.message] : [])
  ])];
  plan.studentMessages = [...new Set([
    ...plan.warnings,
    ...advisorChecks.map(item => item.reason).filter(Boolean),
    ...(plan.studentNotices || []).map(notice => notice.message),
    ...plan.prerequisiteNotices.map(notice => notice.message),
    ...plan.terms.flatMap(term => term.courses.map(course => course.studentHistoricalOfferingMessage).filter(Boolean)),
    ...(plan.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? [SEARCH_INCOMPLETE_MESSAGE] : [])
  ].filter(Boolean))];
  plan.feasibility = buildFeasibilityDetails(plan, student, plan.search);
  plan.verification = {
    status: plan.feasibilityStatus,
    scheduleVerifiedOn: normalizedSchedule?.provider?.verifiedOn || null,
    hasApprovals: plan.feasibility.requiredApprovals.length > 0,
    ...plan.feasibility.verification
  };
  plan.differentiationMetrics = planDifferentiationMetrics(plan, student);

  let rawSolutions = selectedSearch.solutions?.length
    ? selectedSearch.solutions
    : selectedSearch.solution
      ? [{
          plan: selectedSearch.solution,
          metrics: selectedSearch.metrics || {},
          signature: planSignature(plan)
        }]
      : [];
  let materialized = rawSolutions.map(solution => materializeSolverCandidate(plan, solution, {
    student,
    mapping,
    schedule: normalizedSchedule,
    prerequisites,
    context,
    policyBundle
  }));
  if (rawSolutions.length > 0 && !materialized.some(candidate => candidate.validation.valid)) {
    const priorNodes = Number(selectedSearch.search?.nodesVisited || 0);
    const priorDurationMs = Number(selectedSearch.search?.durationMs || 0);
    const remainingNodeBudget = Math.max(0, searchLimit - priorNodes);
    const finalValidatorRescueLimit = Math.min(
      remainingNodeBudget,
      Math.max(1, Math.floor(searchLimit * FINAL_VALIDATOR_RESCUE_BUDGET_SHARE))
    );
    if (finalValidatorRescueLimit > 0) {
    const finalValidatorRescueRaw = runSearch("final-validator-rescue", {
      student,
      mapping,
      schedule: normalizedSchedule,
      prerequisites,
      courseCatalog,
      slots,
      context,
      distribution,
      planVariant,
      planningMode,
      allowConcurrentMath,
      policyBundle,
      requireAnnualCoverage: false,
      requireTargetDistribution: false,
      nodeLimit: finalValidatorRescueLimit,
      solutionBudget: solverSolutionBudget,
      excludedSolutionSignatures: rawSolutions.map(solution => solution.signature).filter(Boolean),
      searchStrategy: "rescue",
      ...(requirementPriority ? { requirementPriority, prioritizeEarlyRequirements: true } : {})
    });
    const finalValidatorRescue = offsetSolutionDiscovery(
      finalValidatorRescueRaw,
      priorNodes,
      priorDurationMs
    );
    selectedSearch.search = combineSearchDiagnostics(
      selectedSearch,
      finalValidatorRescue,
      priorNodes + finalValidatorRescueLimit,
      {},
      {
        innerSearchStage: "final-validator-rescue",
        annualCoverageRequired: false,
        preferredDistributionRequired: false,
        rescue: true,
        rescueReason: "NORMAL_SEARCH_FINAL_VALIDATOR_ZERO",
        searchStrategy: "rescue",
        softConstraintsRelaxed: ["PREFERRED_DISTRIBUTION", "ANNUAL_COVERAGE"]
      }
    );
    selectedSearch.search.rescueTriggered = true;
    selectedSearch.search.finalValidatorZeroRescue = true;
    const rescueSolutions = finalValidatorRescue.solutions || [];
    rawSolutions = [...rawSolutions, ...rescueSolutions];
    materialized = [
      ...materialized,
      ...rescueSolutions.map(solution => materializeSolverCandidate(plan, solution, {
        student,
        mapping,
        schedule: normalizedSchedule,
        prerequisites,
        context,
        policyBundle
      }))
    ];
    }
  }
  const finalExact = new Map();
  let finalExactDuplicatesRemoved = 0;
  for (const candidate of materialized) {
    if (!candidate.validation.valid) continue;
    const signature = planSignature(candidate);
    if (finalExact.has(signature)) {
      finalExactDuplicatesRemoved += 1;
      continue;
    }
    finalExact.set(signature, candidate);
  }
  const finalValid = [...finalExact.values()];
  const rejected = materialized.filter(candidate => !candidate.validation.valid);
  const strategyIneligibleReasons = {};
  const eligibleFinalValid = finalValid.filter(candidate => {
    const assessment = assessStrategyEligibility(candidate, planVariant, effectiveStrategyBaseline);
    candidate.strategyEligibility = assessment;
    if (!assessment.eligible) {
      strategyIneligibleReasons[assessment.reason] = Number(strategyIneligibleReasons[assessment.reason] || 0) + 1;
    }
    return assessment.eligible;
  });
  const semanticGroups = new Map();
  let semanticDuplicatesRemoved = 0;
  for (const candidate of eligibleFinalValid) {
    const signature = semanticPlanSignature(candidate);
    const existing = semanticGroups.get(signature);
    if (!existing) {
      semanticGroups.set(signature, candidate);
      continue;
    }
    semanticDuplicatesRemoved += 1;
    if (compareStrategyCandidates(candidate, existing, { planVariant, student, prerequisites }) < 0) {
      semanticGroups.set(signature, candidate);
    }
  }
  const rankedCandidates = [...semanticGroups.values()]
    .sort((left, right) => compareStrategyCandidates(left, right, { planVariant, student, prerequisites }))
    .slice(0, Math.max(1, Number(candidateLimit) || CANDIDATE_POOL_LIMIT));
  const candidatePool = candidatePoolSummary(
    selectedSearch.search,
    finalValid,
    eligibleFinalValid,
    rankedCandidates,
    rejected,
    finalExactDuplicatesRemoved,
    semanticDuplicatesRemoved,
    strategyIneligibleReasons
  );
  for (const [index, candidate] of rankedCandidates.entries()) {
    candidate.candidateRank = index + 1;
    candidate.strategyScore = strategyScore(candidate, { planVariant, student, prerequisites });
    candidate.safetyScore = planSafetyMetrics(candidate);
    candidate.candidatePool = candidatePool;
    candidate.search = {
      ...candidate.search,
      ...selectedSearch.search,
      firstFinalValidatorPlanNode: candidatePool.firstFinalValidatorPlanNode,
      incumbentPreservedAtLimit: candidatePool.incumbentPreservedAtLimit
    };
    Object.defineProperty(candidate.search, "timeToFirstFinalValidatorPlanMs", {
      value: candidatePool.timeToFirstFinalValidatorPlanMs,
      enumerable: false,
      configurable: true
    });
    if (candidate.feasibility) candidate.feasibility.search = candidate.search;
  }
  const selected = rankedCandidates[0] || plan;
  selected.strategyEligibility = rankedCandidates[0]?.strategyEligibility || {
    eligible: planVariant.strategy !== "explore-first",
    reason: Object.keys(strategyIneligibleReasons).sort()[0] || null,
    baselineFirstYearLoad: effectiveStrategyBaseline ? plannerTrackedYearLoad(effectiveStrategyBaseline, 0) : null,
    candidateFirstYearLoad: planVariant.strategy === "explore-first" ? plannerTrackedYearLoad(plan, 0) : null
  };
  selected.candidatePool = candidatePool;
  Object.defineProperty(selected, "_candidateReserve", {
    value: rankedCandidates,
    enumerable: false,
    configurable: true
  });
  return selected;
}

function courseTermIndex(term = {}) {
  return Number(term.yearIndex || 0) * 10 + (PLANNING_TERM_INDEX.get(term.termKey) ?? 9);
}

function foundationHistory(student = {}) {
  const completed = new Set(normalizeStudentCourses(student.courses)
    .filter(course => ["completed", "transfer"].includes(course.status))
    .map(course => course.code));
  return {
    eco113: completed.has("ECO 113"),
    eco114: completed.has("ECO 114"),
    mathematics: MATH_OPTIONS.some(code => completed.has(code)),
    statistics: STATISTICS_OPTIONS.some(code => completed.has(code))
  };
}

function foundationPlacementTimes(plan = {}) {
  const placements = {};
  for (const term of plan.terms || []) {
    for (const course of term.courses || []) {
      const time = courseTermIndex(term);
      if (course.course === "ECO 113") placements.eco113 = Math.min(placements.eco113 ?? time, time);
      if (course.course === "ECO 114") placements.eco114 = Math.min(placements.eco114 ?? time, time);
      if (MATH_OPTIONS.includes(course.course)) placements.mathematics = Math.min(placements.mathematics ?? time, time);
      if (STATISTICS_OPTIONS.includes(course.course)) placements.statistics = Math.min(placements.statistics ?? time, time);
    }
  }
  return placements;
}

export function planDifferentiationMetrics(plan = {}, student = {}) {
  const courses = (plan.terms || []).flatMap(term => (term.courses || []).map(course => ({ term, course })));
  const yearCount = Math.max(
    Number(plan.planningContext?.remainingYears || 0),
    ...courses.map(({ term }) => Number(term.yearIndex || 0) + 1),
    0
  );
  const yearLoadVector = Array.from({ length: yearCount }, (_item, yearIndex) => (
    courses.filter(({ term }) => Number(term.yearIndex || 0) === yearIndex)
      .reduce((sum, { course }) => sum + (Number.isFinite(Number(course.units)) ? Number(course.units) : 1), 0)
  ));
  const firstAdvancedTime = Math.min(...courses
    .filter(({ course }) => /^ECO (2\d{2}|3\d{2}|4\d{2})$/.test(course.course) && course.course !== "ECO 257")
    .map(({ term }) => courseTermIndex(term)));
  const hasNewAdvancedWork = Number.isFinite(firstAdvancedTime);
  const history = foundationHistory(student);
  const placements = foundationPlacementTimes(plan);
  const foundationKeys = ["eco113", "eco114", "mathematics", "statistics"];
  const foundationNumerator = hasNewAdvancedWork
    ? foundationKeys.filter(key => history[key] || Number(placements[key]) < firstAdvancedTime).length
    : 0;
  const foundationDenominator = hasNewAdvancedWork ? foundationKeys.length : 0;
  const weightedUnits = courses.reduce((sum, { course }) => sum + (Number.isFinite(Number(course.units)) ? Number(course.units) : 1), 0);
  const backloadingIndex = weightedUnits
    ? courses.reduce((sum, { term, course }) => (
      sum + (Number.isFinite(Number(course.units)) ? Number(course.units) : 1) * (Number(term.yearIndex || 0) + 1)
    ), 0) / weightedUnits
    : 0;
  return {
    yearLoadVector,
    foundationFirst: {
      numerator: foundationNumerator,
      denominator: foundationDenominator,
      rate: foundationDenominator ? foundationNumerator / foundationDenominator : 1,
      emptyDenominatorBehavior: "RATE_IS_1_WHEN_NO_NEW_INTERMEDIATE_OR_HIGHER_ECONOMICS_COURSE_IS_PLANNED"
    },
    backloadingIndex
  };
}

function materialCourseFacts(course = {}) {
  return {
    source: course.source || null,
    provenance: course.scheduleProvenance || course.publicationStatus || null,
    availability: course.availability?.status || null,
    seatsOpen: Number.isFinite(course.availability?.seatsOpen) ? course.availability.seatsOpen : null,
    capacity: Number.isFinite(course.availability?.capacity) ? course.availability.capacity : null,
    meeting: course.meeting?.days?.length
      ? `${course.meeting.days.join(",")}:${course.meeting.startMinutes ?? "?"}:${course.meeting.endMinutes ?? "?"}`
      : null,
    approval: (course.approvalRequired || []).map(item => `${item.type}:${item.prerequisite}:${item.reason}`).sort(),
    historicalPriority: course.historicalPriority || null
  };
}

function materialPlacementMap(plan = {}) {
  const fixed = new Map();
  const electives = [];
  for (const term of plan.terms || []) {
    for (const course of term.courses || []) {
      const placement = { course: course.course, slot: term.slotId || term.term, yearIndex: Number(term.yearIndex || 0), termKey: term.termKey || null, facts: materialCourseFacts(course) };
      if (String(course.requirementId || "").startsWith("eco-elective")) electives.push(placement);
      else fixed.set(course.requirementId || course.course, placement);
    }
  }
  electives.sort((left, right) => `${left.yearIndex}:${left.termKey}:${left.slot}`.localeCompare(`${right.yearIndex}:${right.termKey}:${right.slot}`));
  return { fixed, electives };
}

export function materialPlanDistance(left = {}, right = {}) {
  const leftMap = materialPlacementMap(left);
  const rightMap = materialPlacementMap(right);
  const keys = new Set([...leftMap.fixed.keys(), ...rightMap.fixed.keys()]);
  const changedFixed = [...keys].filter(key => JSON.stringify(leftMap.fixed.get(key) || null) !== JSON.stringify(rightMap.fixed.get(key) || null));
  const fixedTiming = [...keys].filter(key => (
    JSON.stringify(leftMap.fixed.get(key) && { slot: leftMap.fixed.get(key).slot, yearIndex: leftMap.fixed.get(key).yearIndex, termKey: leftMap.fixed.get(key).termKey })
    !== JSON.stringify(rightMap.fixed.get(key) && { slot: rightMap.fixed.get(key).slot, yearIndex: rightMap.fixed.get(key).yearIndex, termKey: rightMap.fixed.get(key).termKey })
  ));
  const electiveTiming = JSON.stringify(leftMap.electives.map(item => [item.slot, item.yearIndex, item.termKey]))
    === JSON.stringify(rightMap.electives.map(item => [item.slot, item.yearIndex, item.termKey])) ? 0 : 1;
  const leftFacts = [...leftMap.fixed.values(), ...leftMap.electives].map(item => item.facts);
  const rightFacts = [...rightMap.fixed.values(), ...rightMap.electives].map(item => item.facts);
  const factChange = selector => JSON.stringify(leftFacts.map(selector).sort()) === JSON.stringify(rightFacts.map(selector).sort()) ? 0 : 1;
  const approvalConditions = factChange(item => item.approval);
  const verification = factChange(item => `${item.source}:${item.provenance}`);
  const availability = factChange(item => `${item.availability}:${item.seatsOpen}:${item.capacity}`);
  const conflicts = factChange(item => item.meeting);
  const offeringRisk = factChange(item => item.historicalPriority);
  const horizonChanged = String(left.planningContext?.expectedGraduationTerm || "") !== String(right.planningContext?.expectedGraduationTerm || "") ? 1 : 0;
  const total = fixedTiming.length + electiveTiming + approvalConditions + verification + availability + conflicts + offeringRisk + horizonChanged;
  return {
    nonInterchangeableRequirementTiming: fixedTiming.length,
    changedNonInterchangeableRequirements: changedFixed,
    genericElectiveTiming: electiveTiming,
    approvalConditions,
    verification,
    availability,
    conflicts,
    offeringRisk,
    horizonChanged,
    total,
    materiallyDifferent: total > 0
  };
}

export function semanticPlanSignature(plan) {
  return JSON.stringify({
    graduationTerm: plan?.planningContext?.expectedGraduationTerm || null,
    planningPace: plan?.planningContext?.planningPace || null,
    earlyGraduation: Boolean(plan?.planningContext?.earlyGraduation),
    extendedGraduation: Boolean(plan?.planningContext?.extendedGraduation),
    status: plan?.feasibilityStatus || null,
    verification: plan?.feasibility?.verification || null,
    approvalDimensions: (plan?.feasibility?.requiredApprovals || [])
      .map(item => `${item.type}:${item.reason}:${item.prerequisite}`)
      .sort(),
    conditionDimensions: (plan?.feasibility?.enrollmentConditions || [])
      .map(item => `${item.type}:${item.term || ""}`)
      .sort(),
    terms: (plan?.terms || []).map(term => ({
      slot: term.slotId || term.term,
      courses: (term.courses || []).map(course => {
        const interchangeableElective = String(course.requirementId || "").startsWith("eco-elective");
        return {
          requirement: interchangeableElective ? "eco-elective" : course.requirementId || null,
          course: interchangeableElective ? null : course.course,
          section: interchangeableElective ? null : (course.section || null),
          source: course.source,
          availability: course.availability?.status || null,
          seatsOpen: Number.isFinite(course.availability?.seatsOpen) ? course.availability.seatsOpen : null,
          capacity: Number.isFinite(course.availability?.capacity) ? course.availability.capacity : null,
          meeting: course.meeting?.days?.length
            ? `${course.meeting.days.join(",")}:${course.meeting.startMinutes ?? "?"}:${course.meeting.endMinutes ?? "?"}`
            : null,
          approvals: (course.approvalRequired || []).map(item => `${item.type}:${item.prerequisite}:${item.reason}`).sort()
        };
      }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }))
  });
}

function planSafetyMetrics(plan) {
  const terms = plan?.terms || [];
  const courses = terms.flatMap(term => term.courses || []);
  const requiredApprovals = plan?.feasibility?.requiredApprovals || courses.flatMap(course => course.approvalRequired || []);
  const enrollmentConditions = plan?.feasibility?.enrollmentConditions || [];
  const assignableCourses = courses.filter(course => course.fixedInProgress !== true);
  const verifiedCount = assignableCourses.filter(course => ["verified-offering", "summer-last-resort"].includes(course.source)).length;
  const namedProjectionCount = assignableCourses.filter(course => (
    course.course !== "ECO elective" && course.source !== "requirement-placeholder"
  )).length;
  const placeholderCount = assignableCourses.filter(course => (
    course.course === "ECO elective" || course.source === "requirement-placeholder"
  )).length;
  const veryLowHistoricalCount = assignableCourses.filter(course => course.historicalPriority === "VERY_LOW").length;
  const maxEco = Math.max(0, ...terms.map(term => term.courses.filter(course => isEconomicCourse(course.course)).length));
  const regularLoads = terms.filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey)).map(term => term.courses.length);
  const yearTerms = new Map();
  for (const term of terms.filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey))) {
    const loads = yearTerms.get(term.yearIndex) || {Fall: 0, Winter: 0, May: 0};
    const key = term.termKey === "Spring" ? "May" : term.termKey;
    loads[key] = plannerTrackedTermLoad(term);
    yearTerms.set(term.yearIndex, loads);
  }
  let annualOverFour = 0;
  let fourCoursePatternPenalty = 0;
  let mayCourseCount = 0;
  let mayTermCount = 0;
  for (const loads of yearTerms.values()) {
    const total = loads.Fall + loads.Winter + loads.May;
    annualOverFour += Math.max(0, total - 4);
    if (total === 4) {
      const signature = `${loads.Fall}/${loads.Winter}/${loads.May}`;
      fourCoursePatternPenalty += ["1/2/1", "2/1/1"].includes(signature) ? 0 : signature === "2/2/0" ? 1 : 2;
    }
    if (loads.May > 0) {
      mayTermCount += 1;
      mayCourseCount += loads.May;
    }
  }
  const overloadCount = (plan?.validation?.conditions || []).filter(item => item.reasonCode === "TERM_OVERLOAD_APPROVED").length;
  return {
    verifiedCount,
    namedProjectionCount,
    placeholderCount,
    veryLowHistoricalCount,
    approvalWeight: requiredApprovals.reduce((sum, item) => sum + (item.type === "department" ? 2 : 1), 0),
    conditionCount: enrollmentConditions.length,
    annualOverFour,
    fourCoursePatternPenalty,
    mayCourseCount,
    mayTermCount,
    overloadCount,
    maxEco,
    loadSquares: regularLoads.reduce((sum, count) => sum + count * count, 0),
    imbalance: regularLoads.length ? Math.max(...regularLoads) - Math.min(...regularLoads) : 0,
    signature: semanticPlanSignature(plan)
  };
}

function compareAcademicSafetyPlans(left, right) {
  const a = planSafetyMetrics(left);
  const b = planSafetyMetrics(right);
  return b.verifiedCount - a.verifiedCount
    || b.namedProjectionCount - a.namedProjectionCount
    || a.placeholderCount - b.placeholderCount
    || a.approvalWeight - b.approvalWeight
    || a.conditionCount - b.conditionCount
    || a.veryLowHistoricalCount - b.veryLowHistoricalCount
    || a.overloadCount - b.overloadCount
    || a.maxEco - b.maxEco;
}

export function compareEconomicsPlans(left, right) {
  const a = planSafetyMetrics(left);
  const b = planSafetyMetrics(right);
  return capstoneYearIndex(left) - capstoneYearIndex(right)
    || b.verifiedCount - a.verifiedCount
    || b.namedProjectionCount - a.namedProjectionCount
    || a.placeholderCount - b.placeholderCount
    || a.approvalWeight - b.approvalWeight
    || a.conditionCount - b.conditionCount
    || a.veryLowHistoricalCount - b.veryLowHistoricalCount
    || a.annualOverFour - b.annualOverFour
    || a.fourCoursePatternPenalty - b.fourCoursePatternPenalty
    || b.mayTermCount - a.mayTermCount
    || b.mayCourseCount - a.mayCourseCount
    || a.overloadCount - b.overloadCount
    || a.maxEco - b.maxEco
    || a.loadSquares - b.loadSquares
    || a.imbalance - b.imbalance
    || a.signature.localeCompare(b.signature);
}

export function buildEconomicsTermPlans(args) {
  const policyBundle = args.policyBundle || runtimePolicyBundle();
  const metricsDiagnostics = args.collectDiagnostics ? {
    schemaVersion: 1,
    strategyAttempts: [],
    searchAttempts: []
  } : null;
  const baseContext = args.planningContext || resolvePlanningContext(args.student || {});
  const context = withCatalogApplicability(baseContext, args.student || {}, policyBundle, args.catalogApplicability);
  if ((context.isTransferStudent && !context.transferValidation.valid)
    || (context.customGraduationEnabled && !context.customGraduationValidation.valid)
    || !context.planningValidation?.valid) {
    return {
      context,
      plans: [],
      candidateOutcomes: [],
      convergences: [],
      planningGaps: [],
      ...(metricsDiagnostics ? {
        metricsDiagnostics: {
          ...metricsDiagnostics,
          invalidInput: {
            code: context.isTransferStudent && !context.transferValidation.valid
              ? "INVALID_TRANSFER_CONTEXT"
              : context.customGraduationEnabled && !context.customGraduationValidation.valid
                ? "INVALID_CUSTOM_GRADUATION_CONTEXT"
              : "INVALID_PLANNING_CONTEXT",
            errors: [
              ...(context.transferValidation?.errors || []),
              ...(context.customGraduationValidation?.errors || []),
              ...(context.planningValidation?.errors || [])
            ]
          }
        }
      } : {})
    };
  }
  const planningContext = args.student?.planCreationDate ? context : null;
  const earlyContext = planningContext?.earlyComparisonRequested && !planningContext.isTransferStudent
    && isPlanningStrategyEligible(EARLY_GRADUATION_VARIANT.id, planningContext.effectiveStanding)
    ? withCatalogApplicability(buildEarlyGraduationContext(planningContext), args.student || {}, policyBundle, args.catalogApplicability)
    : null;
  const standing = planningContext?.effectiveStanding || String(args.student?.academicStanding || "freshman").toLowerCase();

  function buildCandidate(candidateContext, variant, graduationPriorityEligible, contextKind, strategyBaseline = null) {
    const attempts = [];
    function runCandidateAttempt(mode, allowConcurrentMath) {
      const startedAt = diagnosticsNow();
      const plan = buildEconomicsTermPlan({
        ...args,
        planningContext: candidateContext,
        planVariant: variant,
        planningMode: mode,
        allowConcurrentMath,
        policyBundle,
        metricsDiagnostics,
        diagnosticContext: { contextKind },
        strategyBaseline
      });
      if (metricsDiagnostics) {
        const pool = plan?.candidatePool || null;
        const search = plan?.search || {};
        metricsDiagnostics.strategyAttempts.push({
          contextKind,
          strategyId: variant.id,
          strategyLabel: variant.label,
          strategy: variant.strategy,
          planningMode: mode,
          allowConcurrentMath,
          approvalMode: allowConcurrentMath ? "DOCUMENTED_CONCURRENCY_ALLOWED" : "STRICT_PREREQUISITES",
          concurrencyMode: allowConcurrentMath ? "ALLOW_APPROVED_CONCURRENCY" : "NO_CONCURRENCY",
          attempted: true,
          durationMs: roundDiagnosticDuration(diagnosticsNow() - startedAt),
          complete: Boolean(search.complete),
          exhaustive: Boolean(search.complete),
          terminationReason: search.terminationReason || (search.complete ? "EXHAUSTED" : null),
          failure: plan?.solverFailure || search.failure || null,
          solutionFound: Boolean(search.solutionFound),
          validationValid: Boolean(plan?.validation?.valid),
          validationErrors: plan?.validation?.errors || [],
          nodesVisited: Number(search.nodesVisited || 0),
          nodeLimit: Number(search.limit || TERM_SOLVER_NODE_LIMIT),
          perInvocationSolutionLimit: Number(search.solutionLimit || TERM_SOLVER_SOLUTION_BUDGET),
          rawSolutionsByStage: (search.attempts?.length ? search.attempts : [search]).map(attempt => ({
            stage: attempt.innerSearchStage || attempt.searchStrategy || "preferred-distribution",
            solutionLimit: Number(attempt.solutionLimit || TERM_SOLVER_SOLUTION_BUDGET),
            rawSolutionsEncountered: Number(attempt.validSolutionCount || 0),
            terminationReason: attempt.terminationReason || (attempt.complete ? "EXHAUSTED" : null)
          })),
          totalRawSolutionsAcrossAttemptChain: Number(pool?.totalRawSolutionsAcrossAttemptChain || search.validSolutionCount || 0),
          completeSchedulesExamined: Number(pool?.completeSchedulesExamined || search.completeSchedulesExamined || 0),
          prerequisiteValidSchedules: Number(pool?.prerequisiteValidSchedules || search.prerequisiteValidSchedules || 0),
          finalValidSchedules: Number(pool?.finalValidSchedules || 0),
          eligibleFinalValidSchedules: Number(pool?.eligibleFinalValidSchedules || 0),
          validatorRejectedSchedules: Number(pool?.validatorRejectedSchedules || 0),
          validatorRejectionReasons: pool?.validatorRejectionReasons || {},
          exactDuplicatesRemoved: Number(pool?.exactDuplicatesRemoved || search.exactDuplicatesRemoved || 0),
          semanticDuplicatesRemoved: Number(pool?.semanticDuplicatesRemoved || 0),
          strategyIneligibleSchedules: Number(pool?.strategyIneligibleSchedules || 0),
          strategyIneligibleReasons: pool?.strategyIneligibleReasons || {},
          retainedDistinctSchedules: Number(pool?.retainedDistinctSchedules || 0),
          candidatePoolSize: Number(pool?.retainedDistinctSchedules || 0),
          firstSolutionNode: search.firstSolutionNode ?? null,
          firstFinalValidatorPlanNode: pool?.firstFinalValidatorPlanNode ?? null,
          timeToFirstFinalValidatorPlanMs: pool?.timeToFirstFinalValidatorPlanMs ?? null,
          finalValidCandidatesAfterFirst: Math.max(0, Number(pool?.finalValidSchedules || 0) - 1),
          firstIncumbentSignature: pool?.firstIncumbentSignature || null,
          incumbentPreservedAtLimit: Boolean(pool?.incumbentPreservedAtLimit),
          rescueTriggered: Boolean(search.rescueTriggered),
          finalValidatorZeroRescue: Boolean(search.finalValidatorZeroRescue),
          rescueAttempts: (search.attempts || []).filter(attempt => attempt.rescue).length,
          rescueSucceeded: Boolean(search.rescueTriggered && Number(pool?.finalValidSchedules || 0) > 0)
        });
      }
      return plan;
    }
    for (const mode of ["standard", ...(graduationPriorityEligible ? ["graduation_priority"] : [])]) {
      let plan = runCandidateAttempt(mode, false);
      attempts.push(plan);
      const strictReserve = plan?._candidateReserve || [];
      if (strictReserve.length) {
        return { variant, selected: strictReserve[0], reserve: strictReserve, attempts };
      }
      if (plan?.search?.complete === false) {
        return { variant, selected: plan || null, reserve: [], attempts };
      }
      if (!plan?.validation?.valid) {
        plan = runCandidateAttempt(mode, true);
        attempts.push(plan);
      }
      const approvalReserve = plan?._candidateReserve || [];
      if (approvalReserve.length) return { variant, selected: approvalReserve[0], reserve: approvalReserve, attempts };
      if (plan?.search?.complete === false) return { variant, selected: plan || null, reserve: [], attempts };
    }
    return { variant, selected: attempts.at(-1) || null, reserve: [], attempts };
  }

  function fallbackIsSafe(topCandidate, alternative) {
    if (!topCandidate || !alternative) return false;
    if (topCandidate.feasibilityStatus !== alternative.feasibilityStatus) return false;
    const top = planSafetyMetrics(topCandidate);
    const next = planSafetyMetrics(alternative);
    return capstoneYearIndex(alternative) <= capstoneYearIndex(topCandidate)
      && next.approvalWeight <= top.approvalWeight
      && next.conditionCount <= top.conditionCount
      && next.maxEco <= top.maxEco
      && next.loadSquares <= top.loadSquares;
  }

  function selectDistinctRepresentative(result, owners, convergences) {
    const selectableCandidates = result.reserve.length
      ? result.reserve
      : (result.selected?.validation?.valid ? [result.selected] : []);
    const top = selectableCandidates[0] || null;
    for (const candidate of selectableCandidates) {
      const signature = semanticPlanSignature(candidate);
      if (owners.has(signature)) continue;
      if (candidate !== top && !fallbackIsSafe(top, candidate)) continue;
      candidate.selectionReason = candidate === top ? "TOP_RANKED" : "NEXT_DISTINCT_RESERVE";
      owners.set(signature, candidate);
      return { ...result, selected: candidate };
    }

    if (top) {
      const samePlan = selectableCandidates.find(candidate => owners.has(semanticPlanSignature(candidate)));
      const kept = samePlan ? owners.get(semanticPlanSignature(samePlan)) : null;
      if (kept) {
        convergences.push({
          code: "PLANS_CONVERGED",
          keptPlanId: kept.id,
          keptLabel: kept.label,
          convergedPlanId: result.variant.id,
          convergedLabel: result.variant.label,
          message: `${kept.label} and ${result.variant.label} produce the same validated schedule because no meaningful distinct alternative remains.`
        });
      }
    }
    return { ...result, selected: null };
  }

  const graduationPriorityEligible = Boolean(
    planningContext && (planningContext.remainingYears <= 2 || standing === "senior")
  );
  const normalVariants = PLAN_VARIANTS.filter(variant => isPlanningStrategyEligible(variant.id, standing));
  const normalContextKind = planningContext?.extendedGraduation
    ? "extended-graduation-horizon"
    : planningContext?.customGraduationEnabled
      ? "custom-graduation-horizon"
    : planningContext?.isTransferStudent && planningContext?.earlyGraduation
      ? "compressed-transfer-horizon"
      : "standard-horizon";
  const balancedVariant = normalVariants.find(variant => variant.strategy === "balanced");
  const exploreVariant = normalVariants.find(variant => variant.strategy === "explore-first");
  const balancedCandidateResult = buildCandidate(
    planningContext,
    balancedVariant,
    graduationPriorityEligible,
    normalContextKind
  );
  const balancedBaseline = balancedCandidateResult.reserve[0]
    || (balancedCandidateResult.selected?.validation?.valid ? balancedCandidateResult.selected : null);
  let exploreCandidateResult = null;
  if (exploreVariant) {
    if (!balancedBaseline) {
      const balancedIncomplete = balancedCandidateResult.selected?.search?.complete === false;
      exploreCandidateResult = {
        variant: exploreVariant,
        selected: null,
        reserve: [],
        attempts: [],
        strategySuppression: balancedIncomplete
          ? {
              code: "SEARCH_INCOMPLETE",
              message: "The Balanced search stopped before a valid baseline was established, so Explore the Major could not be evaluated."
            }
          : {
              code: "EXPLORE_BASELINE_UNAVAILABLE",
              message: "Explore the Major requires a valid Balanced plan with the same fixed graduation term."
            }
      };
    } else if (plannerTrackedYearLoad(balancedBaseline, 0) === 0 || Number(planningContext?.remainingYears || 0) <= 1) {
      exploreCandidateResult = {
        variant: exploreVariant,
        selected: null,
        reserve: [],
        attempts: [],
        strategySuppression: {
          code: "EXPLORE_NO_LIGHTER_FIRST_YEAR",
          message: "The selected Balanced plan already has no planner-tracked work in the first planned year, so no lighter Explore the Major plan is possible."
        }
      };
    } else {
      exploreCandidateResult = buildCandidate(
        planningContext,
        exploreVariant,
        graduationPriorityEligible,
        normalContextKind,
        balancedBaseline
      );
    }
  }
  const normalCandidateResults = [balancedCandidateResult, ...(exploreCandidateResult ? [exploreCandidateResult] : [])];
  const earlyCandidateResult = earlyContext
    ? buildCandidate(earlyContext, EARLY_GRADUATION_VARIANT, true, "early-graduation-horizon")
    : null;
  const candidateResults = [
    ...normalCandidateResults,
    ...(earlyCandidateResult ? [earlyCandidateResult] : [])
  ];
  const semanticOwners = new Map();
  const convergences = [];
  const selectedResults = candidateResults.map(result => (
    result.reserve.length || result.selected?.validation?.valid
      ? selectDistinctRepresentative(result, semanticOwners, convergences)
      : result
  ));
  const normalSelectedCandidates = selectedResults
    .filter(result => result.variant.strategy !== "one-year-early")
    .map(result => result.selected)
    .filter(plan => plan?.validation?.valid);
  const earlySelectedCandidate = selectedResults
    .filter(result => result.variant.strategy === "one-year-early")
    .map(result => result.selected)
    .find(plan => plan?.validation?.valid) || null;
  const earliestNormalCapstoneYearIndex = normalSelectedCandidates.length
    ? Math.min(...normalSelectedCandidates.map(capstoneYearIndex))
    : Number.POSITIVE_INFINITY;
  const distinctCandidates = normalSelectedCandidates
    .filter(plan => capstoneYearIndex(plan) <= earliestNormalCapstoneYearIndex)
    .sort(compareEconomicsPlans);
  const normalDisplayLimit = ["freshman", "sophomore"].includes(standing) ? 2 : 1;
  const plans = [
    ...distinctCandidates.slice(0, normalDisplayLimit),
    ...(earlySelectedCandidate ? [earlySelectedCandidate] : [])
  ];

  const displayedIds = new Set(plans.map(plan => plan.id));
  const convergenceById = new Map(convergences.map(item => [item.convergedPlanId, item]));
  const candidateOutcomes = selectedResults.map(result => {
    const plan = result.selected || result.attempts.at(-1) || null;
    const displayed = Boolean(plan && displayedIds.has(plan.id));
    const substitute = result.selected?.selectionReason === "NEXT_DISTINCT_RESERVE";
    const pool = plan?.candidatePool || null;
    let suppressionReason = null;
    if (result.strategySuppression) suppressionReason = result.strategySuppression;
    else if (!result.reserve.length && plan?.search?.complete === false) suppressionReason = {
      code: "SEARCH_INCOMPLETE",
      message: plan?.strategyEligibility?.eligible === false
        ? "No qualifying Explore the Major incumbent was found before the deterministic search limit. This does not prove that no qualifying plan exists."
        : SEARCH_INCOMPLETE_MESSAGE
    };
    else if (!plan?.validation?.valid) suppressionReason = {
      code: plan?.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? "SEARCH_INCOMPLETE" : "NOT_FEASIBLE",
      message: plan?.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE
        ? SEARCH_INCOMPLETE_MESSAGE
        : plan?.unscheduled?.[0]?.reason || plan?.validation?.errors?.[0] || "The candidate does not satisfy the planning rules."
    };
    else if (!result.reserve.length && plan?.strategyEligibility?.eligible === false) suppressionReason = {
      code: plan.strategyEligibility.reason === "EXPLORE_NOT_LIGHTER_THAN_BALANCED"
        ? "EXPLORE_NO_LIGHTER_PLAN"
        : "EXPLORE_NO_VALID_DISTINCT_PLAN",
      message: plan.strategyEligibility.reason === "EXPLORE_NOT_LIGHTER_THAN_BALANCED"
        ? "The exhaustive bounded search found no final-valid plan with a lighter first planned year than Balanced."
        : "The exhaustive bounded search found no final-valid lighter plan that was materially distinct from Balanced."
    };
    else if (!result.selected && convergenceById.has(result.variant.id)) suppressionReason = {
      code: "SEMANTIC_CONVERGENCE",
      message: convergenceById.get(result.variant.id).message
    };
    else if (!displayed && result.variant.strategy !== "one-year-early" && plan?.validation?.valid && capstoneYearIndex(plan) > earliestNormalCapstoneYearIndex) suppressionReason = {
      code: "LATER_CAPSTONE_FALLBACK_NOT_NEEDED",
      message: "This alternative places ECO 461 in a later senior Winter even though an earlier eligible senior Winter is feasible."
    };
    else if (!displayed) suppressionReason = {
      code: standing === "senior" ? "LOWER_SENIOR_RANK" : "DISPLAY_LIMIT",
      message: standing === "senior"
        ? "A safer or more balanced completion schedule ranked higher."
        : "A higher-ranked distinct plan fills the standing-specific display limit."
    };
    return {
      id: result.variant.id,
      label: result.variant.label,
      status: plan?.feasibilityStatus || FEASIBILITY_STATUS.NOT_FEASIBLE,
      displayed,
      selectedCandidateRank: result.selected?.candidateRank || null,
      reserveCandidatesAvailable: result.selected?.candidateRank
        ? Math.max(0, result.reserve.length - result.selected.candidateRank)
        : result.reserve.length,
      candidatePool: pool,
      substitutionReason: substitute ? "NEXT_DISTINCT_RESERVE" : null,
      suppressionReason,
      reasons: displayed || plan?.validation?.valid
        ? (substitute
            ? [{ code: "NEXT_DISTINCT_RESERVE", message: `${result.variant.label} uses its next-best distinct validated schedule.` }]
            : (suppressionReason ? [suppressionReason] : []))
        : uniquePlanningGaps([
            ...(plan?.unscheduled || []),
            ...(plan?.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? [] : (plan?.validation?.errors || []))
          ])
    };
  });
  const expectedPlanCount = normalDisplayLimit + (earlyContext ? 1 : 0);
  const planSetValidation = validatePlanSet(plans);
  const allAttemptedPlans = selectedResults.map(result => result.selected || result.attempts.at(-1)).filter(Boolean);
  const hasIncompleteSearch = allAttemptedPlans.some(plan => plan.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE);
  const planningGaps = uniquePlanningGaps([
    ...(plans.length ? [] : allAttemptedPlans.flatMap(plan => plan.unscheduled || [])),
    ...(plans.length ? [] : allAttemptedPlans.flatMap(plan => (
      plan.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? [] : (plan.validation?.errors || [])
    ))),
    ...convergences,
    ...(plans.length < expectedPlanCount ? [{
      code: "FEWER_THAN_EXPECTED_VALID_PLANS",
      message: plans.length
        ? `The current rules and schedule support ${plans.length} genuinely distinct feasible plan${plans.length === 1 ? "" : "s"}; duplicate or infeasible filler plans were not shown.`
        : hasIncompleteSearch
          ? SEARCH_INCOMPLETE_MESSAGE
          : "No graduation-feasible plan fits the available schedule, prerequisite sequence, section availability, and course-load limits."
    }] : [])
  ]);
  const plansWithChoices = annotateEconomicsPlanChoices({
    plans,
    student: args.student || {},
    mapping: args.mapping,
    schedule: args.schedule,
    prerequisites: args.prerequisites || {},
    courseCatalog: args.courseCatalog || [],
    context: planningContext,
    policyBundle
  });
  return {
    context: planningContext,
    earlyGraduationContext: earlyContext,
    plans: plansWithChoices,
    candidateOutcomes,
    convergences,
    planningGaps,
    planSetValidation: { ...planSetValidation, displayedPlanCount: plans.length },
    ...(metricsDiagnostics ? { metricsDiagnostics } : {})
  };
}

export {
  EARLY_GRADUATION_VARIANT,
  PLAN_VARIANTS,
  compareStrategyCandidates as compareCp5ReferenceCandidates,
  materializeSolverCandidate as materializeCp5ReferenceCandidate,
  planSignature as exactPlanSignature
};
