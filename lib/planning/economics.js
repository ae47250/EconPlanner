import { academicYearTbcSlot, buildEarlyGraduationContext, buildPlanningSlots, resolvePlanningContext } from "./horizon.js";
import { evaluatePlan as evaluatePolicyPlan } from "../decision-engine/plan.js";
import { normalizeStudentFacts } from "../decision-engine/student-facts.js";
import { resolveCatalogApplicability } from "../catalog/applicability.js";
import { runtimeEconomicsSchedule, runtimePolicyBundle } from "../policy/compat-normalized.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";
import {
  canonicalScheduleCode,
  availabilityIsStale,
  meetingsConflict,
  normalizeEconomicsSchedule,
  scheduleOfferings,
  selectConflictFreeOffering
} from "./scheduleProvider.js";
import { evaluatePlanPrerequisites } from "./prerequisiteEvaluator.js";
import { solveEconomicsTermPlan, TERM_SOLVER_NODE_LIMIT } from "./termSolver.js";
import {
  buildRequirementAllocation,
  requirementAllocationSummary
} from "./requirementAllocation.js";

const LEGACY_TERM_ORDER = ["Fall", "Winter", "May"];
const PLANNING_TERM_INDEX = new Map(["Fall", "Winter", "Spring", "May", "Summer"].map((term, index) => [term, index]));
const STANDING_INDEX = { freshman: 0, sophomore: 1, junior: 2, senior: 3 };
const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const STATISTICS_REQUIREMENT = "Statistics requirement";
const STATISTICS_OPTIONS = ["MAT 217", "ECO 257", "PSY 217"];
const SUPPORTING_REQUIREMENT_PLACEHOLDERS = new Map([
  [STATISTICS_REQUIREMENT, "statistics"],
  ["Mathematics cognate", "cognate"],
  ["Finance requirement", "finance"]
]);
const PLAN_VARIANTS = [
  { id: "plan-1", label: "Plan A", strategy: "equal", description: "Courses are distributed as evenly as possible across the remaining academic years." },
  { id: "plan-2", label: "Plan B", strategy: "increasing", description: "Courses gradually increase in later academic years, creating a staggered path to graduation." },
  { id: "plan-3", label: "Plan C", strategy: "standing-specific", description: "Explore First builds a portable introductory Economics, mathematics, and statistics path before later major commitments." }
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
const EARLY_GRADUATION_VARIANT = {
  id: "plan-c2",
  label: "Plan C-2",
  strategy: "early-graduation",
  description: "The complete prerequisite and offering sequence is compressed into a one-year-early graduation horizon."
};
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

function distributeEvenly(total, yearCount) {
  const counts = Array.from({ length: yearCount }, () => Math.floor(total / yearCount));
  let remainder = total - counts.reduce((sum, count) => sum + count, 0);
  for (let index = 0; index < yearCount && remainder > 0; index += 1, remainder -= 1) {
    counts[index] += 1;
  }
  return counts;
}

function distributeByWeights(total, weights) {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map(weight => total * weight / weightTotal);
  const counts = raw.map(value => Math.floor(value));
  let remainder = total - counts.reduce((sum, count) => sum + count, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || b.index - a.index);
  for (const item of order) {
    if (remainder <= 0) break;
    counts[item.index] += 1;
    remainder -= 1;
  }
  return counts;
}

function buildDistribution(total, context, variant, slots = []) {
  if (!context) {
    return {
      strategy: variant.strategy,
      targetYearCounts: [total],
      targetYears: [{ yearIndex: 0, standing: "senior", targetCount: total }],
      targetTermCounts: Object.fromEntries(slots.map(slot => [slot.id, Math.ceil(total / Math.max(1, slots.length))]))
    };
  }

  const yearCount = context.remainingYears;
  const standing = context.effectiveStanding;
  let targetYearCounts;

  if (variant.strategy === "increasing") {
    targetYearCounts = distributeByWeights(total, Array.from({ length: yearCount }, (_, index) => index + 1));
  } else if (variant.strategy === "standing-specific" && standing === "freshman") {
    // Explore First starts with three portable foundations: ECO 113, ECO 114,
    // and mathematics or statistics. Remaining work stays balanced.
    const firstYearCount = Math.min(3, total);
    targetYearCounts = [firstYearCount, ...distributeEvenly(total - firstYearCount, yearCount - 1)];
  } else if (variant.strategy === "standing-specific" && standing === "sophomore") {
    // A sophomore exploring Economics normally needs the missing introduction,
    // the linked intermediate, and one statistics course before an elective.
    const firstYearCount = Math.min(3, total);
    targetYearCounts = [firstYearCount, ...distributeEvenly(total - firstYearCount, yearCount - 1)];
  } else {
    targetYearCounts = distributeEvenly(total, yearCount);
  }

  const targetTermCounts = {};
  for (const yearIndex of [...new Set(slots.map(slot => slot.yearIndex))]) {
    const yearSlots = slots.filter(slot => slot.yearIndex === yearIndex && !slot.isSummer);
    const yearTarget = targetYearCounts[yearIndex] || 0;
    const termCounts = distributeTermsWithinYear(yearTarget, yearSlots.length);
    yearSlots.forEach((slot, index) => {
      targetTermCounts[slot.id] = termCounts[index] || 0;
    });
  }

  if (variant.strategy === "standing-specific" && ["freshman", "sophomore"].includes(standing)) {
    // Explore First should reserve regular-term space for its required
    // foundation sequence instead of treating Spring/May as a two-course term.
    // A freshman can safely take the two introductions and one quantitative
    // course together. A sophomore uses two Fall/Winter openings for the
    // introduction/intermediate/statistics sequence when that is available.
    const firstYearRegularSlots = slots.filter(slot => slot.yearIndex === 0 && !slot.isSummer);
    const firstRegularSlot = firstYearRegularSlots[0];
    if (firstRegularSlot) {
      for (const slot of firstYearRegularSlots) targetTermCounts[slot.id] = 0;
      if (standing === "freshman") {
        targetTermCounts[firstRegularSlot.id] = Math.min(3, total);
      } else {
        targetTermCounts[firstRegularSlot.id] = Math.min(2, total);
        const secondRegularSlot = firstYearRegularSlots[1];
        if (secondRegularSlot) targetTermCounts[secondRegularSlot.id] = Math.min(1, Math.max(0, total - 2));
      }
    }
  }

  return {
    strategy: variant.strategy,
    targetYearCounts,
    targetTermCounts,
    targetYears: targetYearCounts.map((targetCount, yearIndex) => ({
      yearIndex,
      standing: context.isTransferStudent
        ? STANDING_ORDER[Math.max(0, 4 - (context.remainingYears - yearIndex))]
        : STANDING_ORDER[Math.min(3, STANDING_INDEX[standing] + yearIndex)],
      targetCount
    }))
  };
}

function distributeTermsWithinYear(total, termCount) {
  if (!termCount) return [];
  const counts = Array.from({ length: termCount }, () => Math.floor(total / termCount));
  let remainder = total - counts.reduce((sum, count) => sum + count, 0);
  const firstNonZeroIndex = counts.findIndex(count => count > 0);
  if (firstNonZeroIndex === -1) {
    for (let index = 0; index < termCount && remainder > 0; index += 1, remainder -= 1) counts[index] += 1;
  } else {
    for (let index = termCount - 1; index >= 0 && remainder > 0; index -= 1, remainder -= 1) counts[index] += 1;
  }
  return counts;
}

function prerequisiteOptionAvailable(availableCodes, option) {
  return availableCodes.has(option);
}

function prerequisiteGroupSatisfied(availableCodes, group) {
  if (group.some(option => prerequisiteOptionAvailable(availableCodes, option))) return true;
  return group.every(option => STATISTICS_OPTIONS.includes(option))
    && availableCodes.has(STATISTICS_REQUIREMENT);
}

function prerequisiteMissing(code, completedCodes, prerequisites) {
  const rule = prerequisites?.[code];
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

function concurrentPrerequisiteAssessment(code, availableCodes, sameTermCodes, prerequisites, completedBeforePlan = availableCodes) {
  const rule = prerequisites?.[code];
  if (!rule) return { missing: [], approvals: [] };

  const missing = [];
  const approvals = [];

  for (const required of rule.all || []) {
    if (prerequisiteOptionAvailable(availableCodes, required)) continue;
    const policy = (rule.concurrentWithApproval || []).find(item => (item.options || []).includes(required));
    const options = policy?.options || [];
    const concurrentOptions = options.filter(item => sameTermCodes.has(item));
    const completedOptions = options.filter(item => completedBeforePlan.has(item));
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

function isSeniorWinterOnly(code, slot, student, context) {
  if (code !== "ECO 461") return true;
  if (slot.termKey !== "Winter") return false;
  if (context) return slot.absoluteStandingIndex >= 3;
  return String(student.academicStanding || "").toLowerCase() === "senior";
}

function canCountCompletedCourse(course) {
  if (course.code !== "ECO 461") return true;
  return !["transfer", "uncertain"].includes(course.status);
}

function termCapacity(slot, planningMode = "standard") {
  const reserved = Math.max(0, Number(slot.reservedCourseUnits || 0));
  if (slot.isPlaceholder) return {
    total: Math.max(0, 4 - reserved),
    economics: planningMode === "graduation_priority" ? 4 : 2
  };
  if (slot.termKey === "Spring" || slot.termKey === "May" || slot.termKey === "Summer") {
    return { total: Math.max(0, 1 - reserved), economics: 1 };
  }
  return {
    total: Math.max(0, 4 - reserved),
    economics: planningMode === "graduation_priority" ? 4 : 2
  };
}

function canUseSlot(plan, slot, code, planningMode = "standard") {
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
    const aTermTarget = distribution.targetTermCounts[a.id] ?? aTarget;
    const bTermTarget = distribution.targetTermCounts[b.id] ?? bTarget;
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

function planSlotsFor(student, planningContext) {
  if (planningContext?.hasExplicitDate) return buildPlanningSlots(planningContext).map((slot, order) => ({
    ...slot,
    order,
    reservedCourseUnits: Number(student.reservedCourseUnits?.[slot.id]
      ?? student.reservedCourseUnits?.[slot.label]
      ?? 0)
  }));
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
      .reduce((sum, term) => sum + (term.courses || []).length, 0)
  ));
}

function distributionDesignLabel(strategy) {
  if (strategy === "equal") return "Balanced";
  if (strategy === "increasing") return "Staggered";
  if (strategy === "standing-specific") return "Explore First";
  if (strategy === "early-graduation") return "One Year Early";
  return "preferred";
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
    exact: annualDistance === 0,
    design,
    annualDistance,
    allowedAnnualDistance: exceptionApplies ? allowedDistance : 0,
    targetYearCounts: [...targets],
    actualYearCounts: actual,
    errors: valid ? [] : [mismatchMessage],
    warnings: valid && annualDistance > 0
      ? [plan.preferredDistributionException.message]
      : []
  };
}

export function validateGeneratedPlan(plan, {
  student = {},
  mapping,
  schedule: _schedule,
  prerequisites = {},
  context = null,
  policyBundle = runtimePolicyBundle(),
  enforcePlanIntegrity = false
} = {}) {
  const errors = [];
  const integrityErrors = [];
  const warnings = [];
  const normalizedSchedule = normalizeEconomicsSchedule(runtimeEconomicsSchedule());
  collapseUnsupportedExactFutureTerms(plan, normalizedSchedule);
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
  const availableCodes = new Set(completedCodes);
  const hasAssigned100LevelElective = assigned100LevelElectives(mapping).length > 0;
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
    planSlotsFor(student, authoritativeContext).map(slot => [slot.id, slot])
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
      reservedCourseUnits: authoritativeSlot?.reservedCourseUnits ?? 0
    }, plan?.planningMode);
    const economicsCount = (term.courses || []).filter(course => isEconomicCourse(course.course)).length;
    if (term.courses.length > capacity.total) errors.push(`${term.term} exceeds the total course limit.`);
    if (economicsCount > capacity.economics) errors.push(`${term.term} exceeds the Economics course limit.`);
    if (plan?.planningMode === "graduation_priority" && economicsCount > 2) {
      warnings.push(`This plan uses more than two Economics courses in ${term.term} because the additional courses are needed to meet the graduation target.`);
    }
    if ((term.termKey === "Spring" || term.termKey === "May") && term.courses.length > 1) {
      errors.push(`${term.term} exceeds the Spring/May one-course limit.`);
    }

    const termCodes = new Set();
    const termMeetingOfferings = [];
    const isVerifiedScheduleYear = normalizedAcademicYear(term.academicYear)
      === normalizedAcademicYear(normalizedSchedule?.academicYear);
    for (const course of term.courses || []) {
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
          ? `Schedule confirmation required for ${term.term}: confirm whether MAT 217, ECO 257, or PSY 217 is actually offered without a time conflict.`
          : `Schedule confirmation required for ${course.course} in ${term.term}: confirm a valid option without a time conflict.`);
        continue;
      }
      if (course.course === "ECO elective") {
        const electiveRequirement = requirementsById.get(course.requirementId);
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
        if (hasAssigned100LevelElective && course.minimumLevel !== 200) {
          errors.push("After one 100-level ECO elective is used, every remaining ECO elective must be restricted to the 200 level or above.");
        }
        if (seenRequirements.has(course.requirementId)) errors.push(`Requirement ${course.requirementId} is assigned more than once.`);
        seenRequirements.add(course.requirementId);
        if (course.source === "projected-offering") {
          warnings.push(`ECO elective in ${term.term} is a projected placement; confirm the future official schedule.`);
        }
        continue;
      }
      const code = course.course;
      const requirement = requirementsById.get(course.requirementId);
      if (!requirement) errors.push(`${code} is not a valid course for requirement ${course.requirementId || "unknown"}.`);
      if (requirement?.kind === "elective" && is100LevelEconomicsCourse(code)) {
        planned100LevelElectiveCount += 1;
        if ((hasAssigned100LevelElective ? 1 : 0) + planned100LevelElectiveCount > 1) {
          errors.push("The plan exceeds the one permitted 100-level Economics elective.");
        }
      }
      if (seenCourses.has(code) || selectedCodes.has(code)) errors.push(`${code} is duplicated or already listed as completed/current.`);
      if (seenRequirements.has(course.requirementId)) errors.push(`Requirement ${course.requirementId} is assigned more than once.`);
      seenCourses.add(code);
      seenRequirements.add(course.requirementId);
      termCodes.add(code);

      const isFuturePlaceholder = course.source === "future-placeholder" && term.isPlaceholder;
      const isProjectedOffering = course.source === "projected-offering";
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
        warnings.push(`${code} in ${term.term} is a projected placement; confirm the future official schedule.`);
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
      if (!["verified-offering", "summer-last-resort", "future-placeholder", "projected-offering", "recurring-rule-unconfirmed", "requirement-placeholder"].includes(course.source)) {
        errors.push(`${code} does not have a verified-offering source.`);
      }
      if (course.source === "future-placeholder" && !term.isPlaceholder) {
        errors.push(`${code} claims an unverified future offering in a specific term.`);
      }
      if (term.isSummer && code !== "ECO 113") errors.push(`${code} is not allowed in a Summer slot.`);
      if (!isSeniorWinterOnly(code, term, student, context)) errors.push(`${code} is not in a valid senior Winter slot.`);
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
  const authoritativeErrors = policyEvaluation.academicallyValid && !integrityBlocked
    ? []
    : integrityBlocked
      ? [...new Set(integrityErrors)]
    : errors.length
      ? [...new Set(errors)]
      : [...new Set(policyEvaluation.decisions
          .filter(decision => ["BLOCK", "UNKNOWN"].includes(decision.status))
          .map(decision => decision.reasonCode))];
  const reviewWarnings = policyEvaluation.reviewFindings.map(decision => (
    decision.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW"
      ? `${decision.subject.course} is retained in the academic history, but its historical prerequisite evidence requires advisor review.`
      : `${decision.subject.course || "A recorded academic fact"} requires advisor review (${decision.reasonCode}).`
  ));
  const { latencyMs: _decisionLatencyMs, ...stablePolicyEvaluation } = policyEvaluation;

  const validation = {
    valid: policyEvaluation.academicallyValid && !integrityBlocked,
    approved: policyEvaluation.approvedForAuthority && !integrityBlocked,
    completionStatus: policyEvaluation.completionStatus,
    evidenceStatus: policyEvaluation.evidenceStatus,
    readinessStatus: policyEvaluation.readinessStatus,
    planDisposition: policyEvaluation.planDisposition,
    advisorActionRequired: policyEvaluation.advisorActionRequired,
    advisorActions: policyEvaluation.advisorActions,
    conditions: policyEvaluation.conditions,
    temporalSemantics: policyEvaluation.temporalSemantics,
    catalogApplicability: policyEvaluation.catalogApplicability,
    evidenceFacts: policyEvaluation.evidenceFacts,
    errors: authoritativeErrors,
    warnings: [...new Set([...warnings, ...reviewWarnings])],
    requiredApprovals: prerequisiteEvaluation.requiredApprovals,
    reviewFindings: policyEvaluation.reviewFindings,
    checkedCourseCount: seenCourses.size,
    checkedRequirementCount: seenRequirements.size,
    distribution: distributionValidation,
    requirementAllocation: requirementAllocationSummary(requirementAllocation),
    policyDecision: stablePolicyEvaluation,
    policyBundleVersion: policyBundle.bundleVersion,
    policyBundleHash: policyBundle.contentHash
  };
  Object.defineProperty(validation, "policyDecisionLatencyMs", {
    value: policyEvaluation.latencyMs,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return validation;
}

function applyDecisionContracts(plan) {
  const validation = plan?.validation;
  if (!validation) return plan;
  plan.readinessStatus = validation.readinessStatus;
  plan.planDisposition = validation.planDisposition;
  plan.advisorActionRequired = validation.advisorActionRequired;
  plan.advisorActions = validation.advisorActions;
  plan.conditions = validation.conditions;
  plan.temporalSemantics = validation.temporalSemantics;
  plan.catalogApplicability = validation.catalogApplicability;
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
  const preliminary = courses.some(course => [
    "future-placeholder",
    "projected-offering",
    "recurring-rule-unconfirmed",
    "requirement-placeholder"
  ].includes(course.source));
  if (preliminary) return FEASIBILITY_STATUS.PRELIMINARY;
  const conditional = courses.some(course => (
    (Array.isArray(course.approvalRequired) && course.approvalRequired.length > 0)
    || ["waitlisted", "unknown"].includes(course.availability?.status)
    || !course.meeting?.days?.length
    || !Number.isFinite(course.meeting?.startMinutes)
    || !Number.isFinite(course.meeting?.endMinutes)
    || availabilityIsStale(course.availability, student.planCreationDate)
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
    const status = course.availability?.status;
    if (["waitlisted", "unknown"].includes(status)) {
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
  const preliminarySources = new Set(["future-placeholder", "projected-offering", "recurring-rule-unconfirmed", "requirement-placeholder"]);
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
      offerings: preliminaryCount === 0 ? "verified" : verifiedCount === 0 ? "unpublished" : "mixed",
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
  return {
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
    terminationReason: secondSearch.terminationReason || firstSearch.terminationReason || null,
    attempts: [
      ...(Array.isArray(firstSearch.attempts)
        ? firstSearch.attempts
        : [{ ...firstAttempt, ...firstSearch }]),
      { ...secondAttempt, ...secondSearch }
    ]
  };
}

function collapseUnsupportedExactFutureTerms(plan, schedule) {
  if (!Array.isArray(plan?.terms) || plan.terms.some(term => normalizedTermKey(term.termKey) === "TBC")) return plan;
  const exactAcademicYear = normalizedAcademicYear(schedule?.academicYear);
  const futureByYear = new Map();
  const retained = [];
  for (const term of plan.terms) {
    const academicYear = normalizedAcademicYear(term.academicYear);
    const isUnsupportedExactFuture = academicYear
      && academicYear !== exactAcademicYear
      && (term.courses || []).length > 0
      && (term.courses || []).every(course => [
        "future-placeholder",
        "projected-offering",
        "recurring-rule-unconfirmed",
        "requirement-placeholder"
      ].includes(course.source))
      && (term.courses || []).every(course => (
        course.course !== "ECO 461" || normalizedTermKey(term.termKey) === "Winter"
      ));
    if (!isUnsupportedExactFuture) {
      retained.push(term);
      continue;
    }
    if (!futureByYear.has(academicYear)) futureByYear.set(academicYear, []);
    futureByYear.get(academicYear).push(term);
  }
  if (!futureByYear.size) return plan;
  for (const [academicYear, terms] of futureByYear) {
    const first = terms[0];
    const placeholder = academicYearTbcSlot({ ...first, academicYear });
    if (!placeholder) {
      retained.push(...terms);
      continue;
    }
    retained.push({
      ...placeholder,
      slotId: placeholder.id,
      term: placeholder.label,
      courses: terms.flatMap((term, termOrder) => (term.courses || []).map((course, courseOrder) => ({
        ...course,
        termToBeConfirmed: true,
        projectedTerm: term.termKey,
        ...(Array.isArray(course.approvalRequired) ? {
          approvalRequired: course.approvalRequired.map(approval => ({
            ...approval,
            projectedTerm: approval.term || null,
            term: placeholder.label
          }))
        } : {}),
        planningSequence: termOrder * 100 + courseOrder
      })))
    });
  }
  plan.terms = retained.filter(term => (
    (term.courses || []).length > 0 || !futureByYear.has(normalizedAcademicYear(term.academicYear))
  )).sort((left, right) => (
    Number(left.yearIndex || 0) - Number(right.yearIndex || 0)
      || (PLANNING_TERM_INDEX.get(left.termKey) ?? 99) - (PLANNING_TERM_INDEX.get(right.termKey) ?? 99)
  ));
  return plan;
}

function projectedSeniorStandingMessage(context) {
  if (!context?.projectedSeniorStandingConfirmation) return null;
  return `Senior standing for ${context.projectedSeniorStandingAcademicYear.replace("-", "/")} is based on the student's report that the Registrar or advisor confirmed it; verify that status before enrolling in ECO 461.`;
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
    firstSolutionNode: search.firstSolutionNode ?? null
  };
}

const CANDIDATE_POOL_LIMIT = 12;

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
  const count = Math.max(0, ...(plan?.distribution?.targetYearCounts || []).map((_item, index) => index + 1));
  return Array.from({ length: count }, (_item, yearIndex) => (
    (plan?.terms || [])
      .filter(term => term.yearIndex === yearIndex)
      .reduce((sum, term) => sum + (term.courses || []).length, 0)
  ));
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
    .find(item => ["MAT 217", "ECO 257", "PSY 217"].includes(item.course.course)) || null;
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
  if (planVariant?.strategy !== "standing-specific") return null;
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
    rank([["eco-113", 1], ["eco-114", 2], ["cognate", 3], ["statistics", 4], ["eco-213", 5], ["eco-214", 6], ["finance", 7], ["eco-461", 9]]);
    return priority;
  }
  if (standing !== "sophomore") return null;

  const has113 = completed.has("ECO 113");
  const has114 = completed.has("ECO 114");
  const hasMath = completed.has("MAT 113") || completed.has("MAT 121");
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
  const maximumAnnualLoad = Math.max(0, ...loads);
  const regularLoads = (plan?.terms || [])
    .filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey))
    .map(term => term.courses.length);
  const maxTermLoad = Math.max(0, ...regularLoads);

  if (planVariant?.strategy === "increasing") {
    const backwardLoad = loads.reduce((sum, load, index) => (
      index ? sum + Math.max(0, loads[index - 1] - load) : sum
    ), 0);
    const abruptSpikes = loads.reduce((sum, load, index) => (
      index > 1 ? sum + Math.max(0, Math.abs(load - loads[index - 1]) - 2) : sum
    ), 0);
    return [annualDistance, backwardLoad, abruptSpikes, loads[0] || 0];
  }

  if (planVariant?.strategy === "standing-specific") {
    const completed = completedCourseSet(student);
    const standing = plan?.planningContext?.effectiveStanding || String(student?.academicStanding || "").toLowerCase();
    const firstYear = item => firstYearCourseCount(plan, item);
    if (standing === "freshman") {
      const foundations = ["ECO 113", "ECO 114"]
        .filter(code => !completed.has(code));
      const foundationLate = foundations.reduce((sum, code) => (
        sum + (yearIndexForCourse(plan, code) > 0 ? 1 : 0)
      ), 0);
      const portableCount = firstYear(course => (
        ["MAT 113", "MAT 121", "MAT 217", "ECO 257", "PSY 217"].includes(course.course)
      ));
      const earlyAdvanced = firstYear(course => (
        /^ECO (2\d{2}|3\d{2}|4\d{2})$/.test(course.course)
        && !["ECO 257"].includes(course.course)
      ));
      return [foundationLate, portableCount ? 0 : 1, earlyAdvanced, annualDistance];
    }

    if (standing === "sophomore") {
      const has113 = completed.has("ECO 113");
      const has114 = completed.has("ECO 114");
      const hasMath = completed.has("MAT 113") || completed.has("MAT 121");
      const priorityCourses = has113 && !has114
        ? ["ECO 114", ...(hasMath ? ["ECO 213"] : [])]
        : has114 && !has113
          ? ["ECO 113", ...(hasMath ? ["ECO 214"] : [])]
          : [];
      const sequenceLate = priorityCourses.reduce((sum, code) => (
        sum + (completed.has(code) || yearIndexForCourse(plan, code) === 0 ? 0 : 1)
      ), 0);
      const statsLate = ["MAT 217", "ECO 257", "PSY 217"].some(code => completed.has(code))
        || yearIndexForCourse(plan, "MAT 217") === 0
        || yearIndexForCourse(plan, "ECO 257") === 0
        || yearIndexForCourse(plan, "PSY 217") === 0
        ? 0
        : 1;
      const mathLate = hasMath || yearIndexForCourse(plan, "MAT 113") === 0 || yearIndexForCourse(plan, "MAT 121") === 0 ? 0 : 1;
      const preferredPrerequisites = new Set(has113 ? ["ECO 113", "ECO 213"] : ["ECO 114", "ECO 214"]);
      return [
        mathLate,
        sequenceLate,
        statsLate,
        statisticsSafetyPenalty(plan),
        electiveRelevancePenalty(plan, preferredPrerequisites, prerequisites),
        annualDistance
      ];
    }
  }

  if (planVariant?.strategy === "early-graduation") {
    const maxEco = Math.max(0, ...(plan?.terms || []).map(term => (
      (term.courses || []).filter(course => isEconomicCourse(course.course)).length
    )));
    return [maxTermLoad, maxEco, annualDistance];
  }

  return [annualDistance, fallWinterImbalance(plan), maximumAnnualLoad];
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
  const scoreDifference = compareScoreArrays(
    strategyScore(left, options),
    strategyScore(right, options)
  );
  if (scoreDifference) return scoreDifference;
  return compareEconomicsPlans(left, right);
}

function candidatePoolSummary(search, finalValidPlans, retainedPlans, rejectedPlans, exactDuplicatesRemoved, semanticDuplicatesRemoved) {
  return {
    completeSchedulesExamined: Number(search?.completeSchedulesExamined || search?.completionAttempts || 0),
    prerequisiteValidSchedules: Number(search?.prerequisiteValidSchedules || search?.validSolutionCount || 0),
    finalValidSchedules: finalValidPlans.length,
    validatorRejectedSchedules: rejectedPlans.length,
    validatorRejectionReasons: Object.fromEntries(rejectedPlans.reduce((reasons, plan) => {
      const reason = plan.validation?.errors?.[0] || "The complete plan validator rejected this schedule.";
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
      return reasons;
    }, new Map())),
    exactDuplicatesRemoved: Number(search?.exactDuplicatesRemoved || 0) + exactDuplicatesRemoved,
    semanticDuplicatesRemoved,
    retainedDistinctSchedules: retainedPlans.length,
    nodesVisited: Number(search?.nodesVisited || 0),
    limit: Number(search?.limit || TERM_SOLVER_NODE_LIMIT),
    complete: Boolean(search?.complete),
    terminationReason: search?.terminationReason || (search?.complete ? "EXHAUSTED" : null)
  };
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
  plan.validation = validateGeneratedPlan(plan, { student, mapping, schedule, prerequisites, context, policyBundle });
  applyDecisionContracts(plan);
  plan.requirementAllocation = plan.validation.requirementAllocation;
  if (plan.search?.terminationReason === "NODE_LIMIT" && plan.search?.solutionFound) {
    plan.validation.warnings.push("The solver found this valid plan but did not exhaust every possible alternative before reaching its safety limit.");
  }
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.warnings = [...new Set([
    ...plan.validation.warnings,
    ...(plan.preferredDistributionException ? [plan.preferredDistributionException.message] : []),
    ...(plan.annualDistributionException ? [plan.annualDistributionException.message] : [])
  ])];
  plan.studentMessages = [...new Set([
    ...plan.warnings,
    ...advisorChecks.map(item => item.reason).filter(Boolean),
    projectedSeniorStandingMessage(context),
    ...(plan.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? [SEARCH_INCOMPLETE_MESSAGE] : [])
  ].filter(Boolean))];
  plan.feasibility = buildFeasibilityDetails(plan, student, plan.search);
  plan.verification = {
    status: plan.feasibilityStatus,
    scheduleVerifiedOn: normalizeEconomicsSchedule(schedule)?.provider?.verifiedOn || null,
    hasApprovals: plan.feasibility.requiredApprovals.length > 0,
    ...plan.feasibility.verification
  };
  return plan;
}

export function validatePlanSet(plans = []) {
  const signatures = plans.map(planSignature);
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
  const errors = pairwise.filter(pair => !pair.different).map(pair => `${pair.left} and ${pair.right} have the same course placements.`);
  return {
    valid: plans.length > 0 && plans.length <= PLAN_VARIANTS.length + 1 && uniqueSignatures.size === plans.length && plans.every(plan => plan.validation?.valid !== false),
    planCount: plans.length,
    uniquePlanCount: uniqueSignatures.size,
    pairwise,
    errors
  };
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
  const slots = planSlotsFor(student, context).map(slot => ({
    ...slot,
    academicYear: slot.academicYear || normalizedAcademicYear(normalizedSchedule?.academicYear)
  }));
  const unresolvedItems = remainingRequirements(mapping);
  const hasAssigned100LevelElective = assigned100LevelElectives(mapping).length > 0;
  const distribution = buildDistribution(unresolvedItems.length, context, planVariant, slots);
  const yearCounts = new Map();
  const termCounts = new Map();
  const courseTitles = new Map(courseCatalog.map(course => [course.code, course.title]));
  const plannedCourseYears = new Map([...completedCodes].map(code => [code, -1]));
  const placeholderPlans = new Map();
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
    isSummer: slot.isSummer,
    courses: []
  }));
  const unscheduled = [];
  const advisorChecks = [];
  const summerFallbacks = [];

  function availableForSlot(slotIndex) {
    const available = availableBeforeSlot(termPlans, slotIndex, completedCodes, inProgressCodes, context);
    const targetYearIndex = termPlans[slotIndex]?.yearIndex ?? 0;
    for (const placeholderPlan of placeholderPlans.values()) {
      if (placeholderPlan.yearIndex >= targetYearIndex) continue;
      for (const course of placeholderPlan.courses) {
        if (course.course && course.course !== "ECO elective") available.add(course.course);
      }
    }
    return available;
  }

  function completedBeforeYear(yearIndex) {
    const available = new Set(completedCodes);
    for (const [code, plannedYearIndex] of plannedCourseYears) {
      if (plannedYearIndex >= 0 && plannedYearIndex < yearIndex) available.add(code);
    }
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

  function placeholderPlanForYear(yearIndex) {
    if (placeholderPlans.has(yearIndex)) return placeholderPlans.get(yearIndex);
    const representativeSlot = slots.find(slot => slot.yearIndex === yearIndex);
    if (!representativeSlot) return null;
    if (normalizedAcademicYear(representativeSlot.academicYear) === normalizedAcademicYear(normalizedSchedule?.academicYear)) {
      return null;
    }
    const plan = {
      slotId: `term-to-confirm-${representativeSlot.academicYear}`,
      term: "Term to be confirmed",
      displayTerm: "Term to be confirmed",
      academicYear: representativeSlot.academicYear,
      termKey: "TBC",
      scheduleTerm: null,
      yearIndex,
      absoluteStandingIndex: representativeSlot.absoluteStandingIndex,
      seniorStandingBasis: representativeSlot.seniorStandingBasis,
      isSummer: false,
      isPlaceholder: true,
      inProgressPrerequisitesAvailable: inProgressAvailableBeforeYear(yearIndex),
      courses: []
    };
    placeholderPlans.set(yearIndex, plan);
    return plan;
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
      const plan = placeholderPlanForYear(yearIndex);
      if (!plan || plan.courses.length >= termCapacity(plan, planningMode).total) continue;
      plan.courses.push({
        course: code,
        title: title || courseTitles.get(code) || requirement.label,
        requirementId: requirement.id,
        source: "future-placeholder",
        offeringStatus: "unconfirmed",
        ...details
      });
      yearCounts.set(yearIndex, (yearCounts.get(yearIndex) || 0) + 1);
      if (code !== "ECO elective") plannedCourseYears.set(code, yearIndex);
      return plan;
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
      if (prerequisiteMissing(code, available, prerequisites).length) continue;
      plan.courses.push({
        course: code,
        title: courseTitles.get(code) || requirement.label,
        requirementId: requirement.id,
        source: "recurring-rule-unconfirmed",
        offeringStatus: "future_schedule_confirmation_required",
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
        completedBeforeYear(slot.yearIndex)
      );
      const canUseConcurrentMath = allowConcurrentMath
        && assessment.missing.length === 0
        && assessment.approvals.length > 0;
      const missing = canUseConcurrentMath
        ? []
        : prerequisiteMissing(code, available, prerequisites);
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
    if (slot.isSummer || slot.isPlaceholder) return false;
    if (normalizedAcademicYear(slot.academicYear) === normalizedAcademicYear(normalizedSchedule?.academicYear)) return false;
    if (code === "ECO elective") return ["Fall", "Winter", "Spring", "May"].includes(slot.termKey);
    if (code === "ECO 461") return slot.termKey === "Winter";
    if (["ECO 213", "ECO 214"].includes(code)) {
      if (!["Fall", "Winter"].includes(slot.termKey)) return false;
      const counterpart = code === "ECO 213" ? "ECO 214" : "ECO 213";
      return !plan.courses.some(course => course.course === counterpart);
    }
    if ([
      "ECO 113", "ECO 114", "MAT 113", "MAT 121", "MAT 217", "ECO 257", "PSY 217",
      "ECO 321", "BUSN 323"
    ].includes(code)) return ["Fall", "Winter"].includes(slot.termKey);
    return ["Fall", "Winter", "Spring", "May"].includes(slot.termKey);
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
        completedBeforeYear(slot.yearIndex)
      );
      const canUseConcurrentApproval = allowConcurrentMath
        && assessment.missing.length === 0
        && assessment.approvals.length > 0;
      const missing = canUseConcurrentApproval ? [] : prerequisiteMissing(code, available, prerequisites);
      if (missing.length) continue;
      const course = {
        course: code,
        title: code === "ECO elective"
          ? "Eligible ECO elective (future offering to verify)"
          : courseTitles.get(code) || requirement.label,
        requirementId: requirement.id,
        source: "projected-offering",
        offeringStatus: "future_schedule_confirmation_required",
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
        title: "MAT 217, ECO 257, or PSY 217",
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
        reason: "Schedule confirmation required: verify that MAT 217, ECO 257, or PSY 217 is offered and does not conflict with the listed Economics courses."
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
    if (["plan-2", "plan-3"].includes(planVariant.id)) {
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
      if (is100LevelEconomicsCourse(code) && selected100LevelCount >= 1) continue;
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
        hasAssigned100LevelElective ? { minimumLevel: 200 } : {}
      );
      const placement = verifiedPlacement || projectedPlacement || tryPlacePlaceholder(
        "ECO elective",
        requirement,
        hasAssigned100LevelElective
          ? "ECO elective at the 200 level or above (future offering to verify)"
          : "Eligible ECO elective (future offering to verify)",
        hasAssigned100LevelElective ? { minimumLevel: 200 } : {}
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
    terms: visibleTerms([...new Set(slots.map(slot => slot.yearIndex))].flatMap(yearIndex => [
      ...termPlans.filter(term => term.yearIndex === yearIndex),
      ...(placeholderPlans.has(yearIndex) ? [placeholderPlans.get(yearIndex)] : [])
    ])),
    unscheduled,
    advisorChecks,
    summerFallbacks,
    rules: [
      "Prerequisites must precede dependent courses.",
      "A current in-progress prerequisite is assumed completed for dependent courses placed after the current term.",
      "MAT 113 or MAT 121 may be concurrent with ECO 213 or ECO 214 only as a last resort with the ECO course instructor's approval.",
      "ECO 213 and ECO 214 follow the verified Fall/Winter offering order and are not placed in Spring/May.",
      "When one of ECO 213 or ECO 214 is completed, the other may be concurrent with ECO 461 only with Economics Department approval.",
      "ECO 461 is a Hanover-residency capstone offered in senior Winter only.",
      planningMode === "graduation_priority"
        ? "Graduation-priority mode may exceed two Economics courses in Fall or Winter, but never four total courses."
        : "Fall and Winter normally include no more than two Economics courses.",
      hasAssigned100LevelElective
        ? "Because one 100-level ECO elective is already used, every other ECO elective must be at the 200 level or above."
        : "Only one of the four ECO electives may be at the 100 level.",
      "Spring/May has at most one total course.",
      "Summer courses are excluded unless ECO 113 requires a last-resort online placement."
    ]
  };
  plan.validation = validateGeneratedPlan(plan, { student, mapping, schedule: normalizedSchedule, prerequisites, context });
  applyDecisionContracts(plan);
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.studentMessages = [...new Set([
    ...plan.validation.warnings,
    projectedSeniorStandingMessage(context),
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
  metricsDiagnostics = null,
  diagnosticContext = null,
  policyBundle = runtimePolicyBundle()
}) {
  const baseContext = planningContext || (student.planCreationDate ? resolvePlanningContext(student) : null);
  const context = baseContext ? withCatalogApplicability(baseContext, student, policyBundle) : null;
  if (context?.isTransferStudent && !context.transferValidation.valid) return null;
  const normalizedSchedule = normalizeEconomicsSchedule(runtimeEconomicsSchedule());
  const slots = planSlotsFor(student, context).map(slot => ({
    ...slot,
    academicYear: slot.academicYear || normalizedAcademicYear(normalizedSchedule?.academicYear)
  }));
  const unresolvedItems = remainingRequirements(mapping);
  const distribution = buildDistribution(unresolvedItems.length, context, planVariant, slots);
  const requirementPriority = exploreFirstRequirementPriority(student, planVariant, context);
  const searchLimit = Math.max(1, Number(nodeLimit) || TERM_SOLVER_NODE_LIMIT);
  const runSearch = (stage, input) => {
    const startedAt = diagnosticsNow();
    const result = solveEconomicsTermPlan(input);
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
    nodeLimit: searchLimit,
    ...(requirementPriority ? { requirementPriority, prioritizeEarlyRequirements: true } : {})
  });
  let selectedSearch = preferredSearch;
  let preferredDistributionException = null;
  let annualDistributionException = null;
  if (!preferredSearch.solution && preferredSearch.search.complete) {
    const distributionRelaxedSearch = runSearch("distribution-relaxed", {
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
      requireTargetDistribution: false,
      nodeLimit: Math.max(1, searchLimit - preferredSearch.search.nodesVisited),
      ...(requirementPriority ? { requirementPriority, prioritizeEarlyRequirements: true } : {})
    });
    selectedSearch = {
      ...distributionRelaxedSearch,
      search: combineSearchDiagnostics(
        preferredSearch,
        distributionRelaxedSearch,
        searchLimit,
        { annualCoverageRequired: true, preferredDistributionRequired: true },
        { annualCoverageRequired: true, preferredDistributionRequired: false }
      )
    };
    if (!distributionRelaxedSearch.solution && distributionRelaxedSearch.search.complete) {
      const coverageRelaxedSearch = runSearch("annual-coverage-relaxed", {
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
        nodeLimit: Math.max(1, searchLimit - selectedSearch.search.nodesVisited),
        ...(requirementPriority ? { requirementPriority, prioritizeEarlyRequirements: true } : {})
      });
      selectedSearch = {
        ...coverageRelaxedSearch,
        search: combineSearchDiagnostics(
          selectedSearch,
          coverageRelaxedSearch,
          searchLimit,
          {},
          { annualCoverageRequired: false, preferredDistributionRequired: false }
        )
      };
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
        message: `The exact ${distributionDesignLabel(distribution.strategy)} yearly distribution is not feasible under the current prerequisite and offering sequence. This plan uses a validated alternative distribution.`
      };
    }
    if (selectedSearch.solution && selectedSearch.search.attempts?.some(attempt => attempt.annualCoverageRequired === false)) {
      annualDistributionException = {
        code: "ANNUAL_DISTRIBUTION_EXCEPTION",
        message: "A prerequisite or verified-offering constraint prevents at least one remaining academic year from containing an Economics-planner course."
      };
    }
  }

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
    isSummer: slot.isSummer,
    courses: []
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
        : "No complete assignment satisfies the term-level prerequisites, verified offerings, and 4/4/1 capacity."
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
    rules: [
      "Prerequisites must precede dependent courses unless a documented concurrency approval applies.",
      "ECO 461 is a Hanover-residency capstone offered in projected senior Winter only.",
      "Fall and Winter are limited to four total courses; Spring/May is limited to one.",
      planningMode === "graduation_priority"
        ? "More than two Economics courses may be used only when needed for the selected graduation target."
        : "Two Economics courses per Fall/Winter is the preferred maximum.",
      "Projected ECO 213 and ECO 214 offerings remain in different terms until a verified schedule says otherwise."
    ]
  };
  plan.validation = validateGeneratedPlan(plan, {
    student,
    mapping,
    schedule: normalizedSchedule,
    prerequisites,
    context,
    policyBundle
  });
  applyDecisionContracts(plan);
  plan.requirementAllocation = plan.validation.requirementAllocation;
  if (selectedSearch.search.terminationReason === "NODE_LIMIT" && selectedSearch.solution) {
    plan.validation.warnings.push("The solver found this valid plan but did not exhaust every possible alternative before reaching its safety limit.");
  }
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.warnings = [...new Set([
    ...plan.validation.warnings,
    ...(preferredDistributionException ? [preferredDistributionException.message] : []),
    ...(annualDistributionException ? [annualDistributionException.message] : [])
  ])];
  plan.studentMessages = [...new Set([
    ...plan.warnings,
    ...advisorChecks.map(item => item.reason).filter(Boolean),
    projectedSeniorStandingMessage(context),
    ...(plan.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? [SEARCH_INCOMPLETE_MESSAGE] : [])
  ].filter(Boolean))];
  plan.feasibility = buildFeasibilityDetails(plan, student, plan.search);
  plan.verification = {
    status: plan.feasibilityStatus,
    scheduleVerifiedOn: normalizedSchedule?.provider?.verifiedOn || null,
    hasApprovals: plan.feasibility.requiredApprovals.length > 0,
    ...plan.feasibility.verification
  };

  const rawSolutions = selectedSearch.solutions?.length
    ? selectedSearch.solutions
    : selectedSearch.solution
      ? [{
          plan: selectedSearch.solution,
          metrics: selectedSearch.metrics || {},
          signature: planSignature(plan)
        }]
      : [];
  const materialized = rawSolutions.map(solution => materializeSolverCandidate(plan, solution, {
    student,
    mapping,
    schedule: normalizedSchedule,
    prerequisites,
    context,
    policyBundle
  }));
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
  const semanticGroups = new Map();
  let semanticDuplicatesRemoved = 0;
  for (const candidate of finalValid) {
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
    rankedCandidates,
    rejected,
    finalExactDuplicatesRemoved,
    semanticDuplicatesRemoved
  );
  for (const [index, candidate] of rankedCandidates.entries()) {
    candidate.candidateRank = index + 1;
    candidate.strategyScore = strategyScore(candidate, { planVariant, student, prerequisites });
    candidate.safetyScore = planSafetyMetrics(candidate);
    candidate.candidatePool = candidatePool;
  }
  const selected = rankedCandidates[0] || plan;
  selected.candidatePool = candidatePool;
  Object.defineProperty(selected, "_candidateReserve", {
    value: rankedCandidates,
    enumerable: false,
    configurable: true
  });
  return selected;
}

function _buildEconomicsTermPlansLegacy(args) {
  const context = resolvePlanningContext(args.student || {});
  if (context.isTransferStudent && !context.transferValidation.valid) {
    return { context, plans: [], candidateOutcomes: [], convergences: [] };
  }

  const planningContext = args.student?.planCreationDate ? context : null;
  const earlyContext = planningContext ? buildEarlyGraduationContext(planningContext) : null;

  function candidatesForMode(candidateContext, variants, planningMode) {
    return variants.map(planVariant => {
      const strictPlan = buildEconomicsTermPlan({
        ...args,
        planningContext: candidateContext,
        planVariant,
        planningMode,
        allowConcurrentMath: false
      });
      if (strictPlan?.validation?.valid) return strictPlan;
      return buildEconomicsTermPlan({
        ...args,
        planningContext: candidateContext,
        planVariant,
        planningMode,
        allowConcurrentMath: true
      });
    });
  }

  function distinctValidPlans(candidatePlans) {
    const signatures = new Set();
    return candidatePlans.filter(plan => {
      if (!plan?.validation?.valid) return false;
      const signature = planSignature(plan);
      if (signatures.has(signature)) return false;
      signatures.add(signature);
      return true;
    });
  }

  function candidateSet(candidateContext, variants, graduationPriorityEligible) {
    if (!candidateContext && args.student?.planCreationDate) return { candidates: [], plans: [] };
    const standardCandidates = candidatesForMode(candidateContext, variants, "standard");
    const standardPlans = distinctValidPlans(standardCandidates);
    if (standardPlans.length || !graduationPriorityEligible) {
      return { candidates: standardCandidates, plans: standardPlans };
    }
    const graduationCandidates = candidatesForMode(candidateContext, variants, "graduation_priority");
    return { candidates: graduationCandidates, plans: distinctValidPlans(graduationCandidates) };
  }

  const standing = planningContext?.effectiveStanding || String(args.student?.academicStanding || "freshman").toLowerCase();
  const normalSet = candidateSet(planningContext, PLAN_VARIANTS, standing === "senior");
  const earlySet = earlyContext
    ? candidateSet(earlyContext, [EARLY_GRADUATION_VARIANT], true)
    : { candidates: [], plans: [] };
  let requestedPlans;
  if (standing === "senior") {
    requestedPlans = normalSet.plans.slice(0, 1);
  } else if (standing === "junior") {
    requestedPlans = [
      ...normalSet.plans.slice(0, 1),
      ...(earlySet.plans.length ? earlySet.plans.slice(0, 1) : normalSet.plans.slice(1, 2))
    ];
  } else {
    requestedPlans = [...normalSet.plans, ...earlySet.plans.slice(0, 1)];
  }

  const signatureOwners = new Map();
  const convergences = [];
  const plans = requestedPlans.filter(plan => {
    const signature = planSignature(plan);
    if (!signatureOwners.has(signature)) {
      signatureOwners.set(signature, plan);
      return true;
    }
    const kept = signatureOwners.get(signature);
    convergences.push({
      code: "PLANS_CONVERGED",
      keptPlanId: kept.id,
      keptLabel: kept.label,
      convergedPlanId: plan.id,
      convergedLabel: plan.label,
      message: `${kept.label} and ${plan.label} produce the same validated schedule because the prerequisite sequence and offerings leave no meaningful alternative.`
    });
    return false;
  });

  const candidatePlans = [...normalSet.candidates, ...earlySet.candidates];
  const candidateSignatureOwners = new Map();
  for (const candidate of candidatePlans.filter(item => item?.validation?.valid)) {
    const signature = planSignature(candidate);
    if (!candidateSignatureOwners.has(signature)) {
      candidateSignatureOwners.set(signature, candidate);
      continue;
    }
    const kept = candidateSignatureOwners.get(signature);
    if (kept.id === candidate.id || convergences.some(item => item.convergedPlanId === candidate.id)) continue;
    convergences.push({
      code: "PLANS_CONVERGED",
      keptPlanId: kept.id,
      keptLabel: kept.label,
      convergedPlanId: candidate.id,
      convergedLabel: candidate.label,
      message: `${kept.label} and ${candidate.label} produce the same validated schedule because the prerequisite sequence and offerings leave no meaningful alternative.`
    });
  }
  const expectedPlanCount = standing === "senior" ? 1 : standing === "junior" ? 2 : earlyContext ? 4 : 3;
  const candidateOutcomes = candidatePlans.map(plan => ({
    id: plan?.id || "unknown",
    label: plan?.label || "Plan",
    status: plan?.feasibilityStatus || FEASIBILITY_STATUS.NOT_FEASIBLE,
    displayed: plans.some(item => item.id === plan?.id),
    reasons: plan?.validation?.valid
      ? []
      : uniquePlanningGaps([...(plan?.unscheduled || []), ...(plan?.validation?.errors || [])])
  }));
  const planSetValidation = validatePlanSet(plans);
  const planningGaps = uniquePlanningGaps([
    ...(plans.length ? [] : candidatePlans.flatMap(plan => plan?.unscheduled || [])),
    ...(plans.length ? [] : candidatePlans.flatMap(plan => plan?.validation?.errors || [])),
    ...planSetValidation.errors,
    ...convergences,
    ...(plans.length < expectedPlanCount
      ? [{
          code: "FEWER_THAN_EXPECTED_VALID_PLANS",
          message: plans.length
            ? `The current rules and schedule support ${plans.length} genuinely distinct feasible plan${plans.length === 1 ? "" : "s"}; duplicate or infeasible filler plans were not shown.`
            : "No graduation-feasible plan fits the available schedule, prerequisite sequence, section availability, and course-load limits."
        }]
      : [])
  ]);
  return {
    context: planningContext,
    earlyGraduationContext: earlyContext,
    plans,
    candidateOutcomes,
    convergences,
    planningGaps,
    planSetValidation: {
      ...planSetValidation,
      displayedPlanCount: plans.length
    }
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
          course: interchangeableElective ? "eco-elective" : course.course,
          section: interchangeableElective ? null : course.section || null,
          source: course.source,
          availability: course.availability?.status || null,
          meetingVerified: Boolean(
            course.meeting?.days?.length
            && Number.isFinite(course.meeting?.startMinutes)
            && Number.isFinite(course.meeting?.endMinutes)
          ),
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
  const verifiedCount = courses.filter(course => ["verified-offering", "summer-last-resort"].includes(course.source)).length;
  const maxEco = Math.max(0, ...terms.map(term => term.courses.filter(course => isEconomicCourse(course.course)).length));
  const regularLoads = terms.filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey)).map(term => term.courses.length);
  return {
    verifiedCount,
    approvalWeight: requiredApprovals.reduce((sum, item) => sum + (item.type === "department" ? 2 : 1), 0),
    conditionCount: enrollmentConditions.length,
    maxEco,
    loadSquares: regularLoads.reduce((sum, count) => sum + count * count, 0),
    imbalance: regularLoads.length ? Math.max(...regularLoads) - Math.min(...regularLoads) : 0,
    signature: semanticPlanSignature(plan)
  };
}

export function compareEconomicsPlans(left, right) {
  const a = planSafetyMetrics(left);
  const b = planSafetyMetrics(right);
  return capstoneYearIndex(left) - capstoneYearIndex(right)
    || b.verifiedCount - a.verifiedCount
    || a.approvalWeight - b.approvalWeight
    || a.conditionCount - b.conditionCount
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
  if ((context.isTransferStudent && !context.transferValidation.valid) || !context.planningValidation?.valid) {
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
              : "INVALID_PLANNING_CONTEXT",
            errors: [
              ...(context.transferValidation?.errors || []),
              ...(context.planningValidation?.errors || [])
            ]
          }
        }
      } : {})
    };
  }
  const planningContext = args.student?.planCreationDate ? context : null;
  const earlyContext = planningContext?.earlyGraduation && !planningContext.isTransferStudent
    ? planningContext
    : null;
  const standing = planningContext?.effectiveStanding || String(args.student?.academicStanding || "freshman").toLowerCase();

  function buildCandidate(candidateContext, variant, graduationPriorityEligible, contextKind) {
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
        diagnosticContext: { contextKind }
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
          completeSchedulesExamined: Number(pool?.completeSchedulesExamined || search.completeSchedulesExamined || 0),
          prerequisiteValidSchedules: Number(pool?.prerequisiteValidSchedules || search.prerequisiteValidSchedules || 0),
          finalValidSchedules: Number(pool?.finalValidSchedules || 0),
          validatorRejectedSchedules: Number(pool?.validatorRejectedSchedules || 0),
          validatorRejectionReasons: pool?.validatorRejectionReasons || {},
          exactDuplicatesRemoved: Number(pool?.exactDuplicatesRemoved || search.exactDuplicatesRemoved || 0),
          semanticDuplicatesRemoved: Number(pool?.semanticDuplicatesRemoved || 0),
          retainedDistinctSchedules: Number(pool?.retainedDistinctSchedules || 0),
          candidatePoolSize: Number(pool?.retainedDistinctSchedules || 0),
          firstSolutionNode: search.firstSolutionNode ?? null
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
    const top = result.reserve[0] || null;
    for (const candidate of result.reserve) {
      const signature = semanticPlanSignature(candidate);
      if (owners.has(signature)) continue;
      if (candidate !== top && !fallbackIsSafe(top, candidate)) continue;
      candidate.selectionReason = candidate === top ? "TOP_RANKED" : "NEXT_DISTINCT_RESERVE";
      owners.set(signature, candidate);
      return { ...result, selected: candidate };
    }

    if (top) {
      const samePlan = result.reserve.find(candidate => owners.has(semanticPlanSignature(candidate)));
      const kept = samePlan ? owners.get(semanticPlanSignature(samePlan)) : null;
      if (result.selected?.candidatePool?.complete && kept) {
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
  const selectedVariants = earlyContext
    ? [EARLY_GRADUATION_VARIANT]
    : ["junior", "senior"].includes(standing)
      ? PLAN_VARIANTS.filter(variant => variant.strategy !== "standing-specific")
      : PLAN_VARIANTS;
  const contextKind = planningContext?.extendedGraduation
    ? "extended-graduation-horizon"
    : planningContext?.isTransferStudent && planningContext?.earlyGraduation
      ? "compressed-transfer-horizon"
    : earlyContext
      ? "early-graduation-horizon"
      : "standard-horizon";
  const candidateResults = selectedVariants.map(variant => (
    buildCandidate(
      planningContext,
      variant,
      graduationPriorityEligible || Boolean(earlyContext),
      contextKind
    )
  ));
  const semanticOwners = new Map();
  const convergences = [];
  const selectedResults = candidateResults.map(result => (
    result.reserve.length
      ? selectDistinctRepresentative(result, semanticOwners, convergences)
      : result
  ));
  const selectedCandidates = selectedResults
    .map(result => result.selected)
    .filter(plan => plan?.validation?.valid);
  const earliestCapstoneYearIndex = Math.min(...selectedCandidates.map(capstoneYearIndex));
  const distinctCandidates = selectedCandidates
    .filter(plan => capstoneYearIndex(plan) <= earliestCapstoneYearIndex)
    .sort(compareEconomicsPlans);
  let plans;
  if (earlyContext || standing === "senior") {
    plans = distinctCandidates.slice(0, 1);
  } else if (standing === "junior") {
    plans = distinctCandidates.slice(0, 2);
  } else {
    plans = distinctCandidates.slice(0, 3);
  }

  const displayedIds = new Set(plans.map(plan => plan.id));
  const convergenceById = new Map(convergences.map(item => [item.convergedPlanId, item]));
  const candidateOutcomes = selectedResults.map(result => {
    const plan = result.selected || result.attempts.at(-1) || null;
    const displayed = Boolean(plan && displayedIds.has(plan.id));
    const substitute = result.selected?.selectionReason === "NEXT_DISTINCT_RESERVE";
    const pool = plan?.candidatePool || null;
    let suppressionReason = null;
    if (!plan?.validation?.valid) suppressionReason = {
      code: plan?.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE ? "SEARCH_INCOMPLETE" : "NOT_FEASIBLE",
      message: plan?.feasibilityStatus === FEASIBILITY_STATUS.SEARCH_INCOMPLETE
        ? SEARCH_INCOMPLETE_MESSAGE
        : plan?.unscheduled?.[0]?.reason || plan?.validation?.errors?.[0] || "The candidate does not satisfy the planning rules."
    };
    else if (!result.selected && pool?.complete === false) suppressionReason = {
      code: "NO_DISTINCT_RETAINED_CANDIDATE",
      message: "No distinct retained candidate was found before the deterministic search safety limit stopped the strategy."
    };
    else if (!result.selected && convergenceById.has(result.variant.id)) suppressionReason = {
      code: "SEMANTIC_CONVERGENCE",
      message: convergenceById.get(result.variant.id).message
    };
    else if (!displayed && plan?.validation?.valid && capstoneYearIndex(plan) > earliestCapstoneYearIndex) suppressionReason = {
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
  const expectedPlanCount = earlyContext || standing === "senior" ? 1 : standing === "junior" ? 2 : 3;
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
  return {
    context: planningContext,
    earlyGraduationContext: earlyContext,
    plans,
    candidateOutcomes,
    convergences,
    planningGaps,
    planSetValidation: { ...planSetValidation, displayedPlanCount: plans.length },
    ...(metricsDiagnostics ? { metricsDiagnostics } : {})
  };
}

export { EARLY_GRADUATION_VARIANT, PLAN_VARIANTS };
