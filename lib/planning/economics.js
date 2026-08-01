import { buildEarlyGraduationContext, buildPlanningSlots, resolvePlanningContext } from "./horizon.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";
import {
  canonicalScheduleCode,
  availabilityIsStale,
  meetingsConflict,
  normalizeEconomicsSchedule,
  scheduleOfferings,
  selectConflictFreeOffering
} from "./scheduleProvider.js";

const LEGACY_TERM_ORDER = ["Fall", "Winter", "May"];
const PLANNING_TERM_INDEX = new Map(["Fall", "Winter", "Spring", "May", "Summer"].map((term, index) => [term, index]));
const STANDING_INDEX = { freshman: 0, sophomore: 1, junior: 2, senior: 3 };
const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const STATISTICS_REQUIREMENT = "Statistics requirement";
const STATISTICS_OPTIONS = ["MAT 217", "ECO 257", "PSY 217"];
const PLAN_VARIANTS = [
  { id: "plan-1", label: "Plan A", strategy: "equal", description: "Courses are distributed as evenly as possible across the remaining academic years." },
  { id: "plan-2", label: "Plan B", strategy: "increasing", description: "Courses gradually increase in later academic years, creating a staggered path to graduation." },
  { id: "plan-3", label: "Plan C", strategy: "standing-specific", description: "The distribution is adjusted for class standing, with a lighter early path when appropriate." }
];
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
  NOT_FEASIBLE: "NOT_FEASIBLE"
});
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

function distributeEvenly(total, yearCount) {
  const counts = Array.from({ length: yearCount }, () => Math.floor(total / yearCount));
  let remainder = total - counts.reduce((sum, count) => sum + count, 0);
  for (let index = yearCount - 1; index >= 0 && remainder > 0; index -= 1, remainder -= 1) {
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
    targetYearCounts = distributeByWeights(total, [2, 2, 3, 5].slice(0, yearCount));
  } else if (variant.strategy === "standing-specific" && standing === "sophomore") {
    const firstYearCount = Math.min(2, total);
    targetYearCounts = [firstYearCount, ...distributeEvenly(total - firstYearCount, yearCount - 1)];
  } else if (variant.strategy === "equal" && standing === "freshman") {
    const firstYearCount = Math.min(2, total);
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

  return {
    strategy: variant.strategy,
    targetYearCounts,
    targetTermCounts,
    targetYears: targetYearCounts.map((targetCount, yearIndex) => ({
      yearIndex,
      standing: STANDING_ORDER[Math.min(3, STANDING_INDEX[standing] + yearIndex)],
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

function hasMatchingConcurrentApproval(course, approval) {
  const recorded = Array.isArray(course.approvalRequired)
    ? course.approvalRequired
    : course.approvalRequired
      ? [course.approvalRequired]
      : [];
  return recorded.some(item => (
    item.type === approval.type
    && item.reason === approval.reason
    && item.prerequisite === approval.prerequisite
  ));
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
  return !["transfer", "uncertain"].includes(course.status) && !/ap|transfer|equivalency|outside/i.test(course.source || "");
}

function termCapacity(slot, planningMode = "standard") {
  const reserved = Math.max(0, Number(slot.reservedCourseUnits || 0));
  if (slot.isPlaceholder) return { total: Math.max(0, 5 - reserved), economics: 5 };
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
    terms: (plan?.terms || []).map(term => ({
      slot: term.slotId || term.term,
      courses: (term.courses || []).map(course => ({
        requirementId: course.requirementId || null,
        course: course.course,
        section: course.section || null,
        approvals: (Array.isArray(course.approvalRequired) ? course.approvalRequired : [])
          .map(item => `${item.reason}:${item.prerequisite}:${item.type}`)
          .sort()
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }))
  });
}

export function validateGeneratedPlan(plan, { student = {}, mapping, schedule, prerequisites = {}, context = null } = {}) {
  const errors = [];
  const warnings = [];
  const normalizedSchedule = normalizeEconomicsSchedule(schedule);
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
  let validationYearIndex = null;
  let completedBeforeAcademicYear = new Set(completedCodes);
  const hasAssigned100LevelElective = assigned100LevelElectives(mapping).length > 0;
  let planned100LevelElectiveCount = 0;

  for (const term of plan?.terms || []) {
    if (validationYearIndex !== (term.yearIndex ?? 0)) {
      validationYearIndex = term.yearIndex ?? 0;
      completedBeforeAcademicYear = new Set(availableCodes);
    }
    if (isAfterCurrentPlanningTerm(term, context)) {
      for (const code of inProgressCodes) availableCodes.add(code);
    }
    const capacity = termCapacity(term, plan?.planningMode);
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
    const scheduledTermCodes = new Set((term.courses || [])
      .map(course => course.course)
      .filter(code => code && code !== "ECO elective"));
    for (const course of term.courses || []) {
      if (course.course === STATISTICS_REQUIREMENT) {
        const requirement = requirementsById.get(course.requirementId);
        if (requirement?.id !== "statistics" || course.source !== "requirement-placeholder") {
          errors.push("The Statistics requirement placeholder may satisfy only the statistics requirement slot.");
        }
        if (!Array.isArray(course.options) || !STATISTICS_OPTIONS.every(option => course.options.includes(option))) {
          errors.push("The Statistics requirement placeholder must list MAT 217, ECO 257, and PSY 217 as options.");
        }
        if (course.offeringStatus !== "schedule_confirmation_required") {
          errors.push("The Statistics requirement placeholder must require schedule confirmation.");
        }
        if (seenRequirements.has(course.requirementId)) errors.push(`Requirement ${course.requirementId} is assigned more than once.`);
        seenRequirements.add(course.requirementId);
        termCodes.add(STATISTICS_REQUIREMENT);
        warnings.push(`Schedule confirmation required for ${term.term}: confirm whether MAT 217, ECO 257, or PSY 217 is actually offered without a time conflict.`);
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
      const validRequirementCourse = requirement?.kind === "elective"
        ? isValidElectiveCourse(requirement, code, mapping)
        : Boolean(requirement && (requirement.options || []).includes(code));
      if (!validRequirementCourse) {
        errors.push(`${code} is not a valid course for requirement ${course.requirementId || "unknown"}.`);
      }
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
      const verifiedOfferings = scheduleOfferings(normalizedSchedule, term, code);
      const matchingOffering = verifiedOfferings.find(offering => (
        !course.section || offering.section === course.section
      ));
      if (course.source === "verified-offering" && !course.section) {
        errors.push(`${code} must retain its verified section identifier.`);
      }
      if (!isFuturePlaceholder && !isProjectedOffering && !isRecurringCapstone && !matchingOffering) {
        errors.push(`${code} is not verified in the ${term.academicYear || "scheduled"} ${term.termKey} offering.`);
      }
      if (isProjectedOffering) {
        if (normalizedAcademicYear(term.academicYear) === normalizedAcademicYear(normalizedSchedule?.academicYear)) {
          errors.push(`${code} cannot use a projected offering in an academic year with a verified schedule.`);
        }
        warnings.push(`${code} in ${term.term} is a projected placement; confirm the future official schedule.`);
      }
      if (matchingOffering) {
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
      if (!["verified-offering", "summer-last-resort", "future-placeholder", "projected-offering", "recurring-rule-unconfirmed"].includes(course.source)) {
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

      const assessment = concurrentPrerequisiteAssessment(code, availableCodes, scheduledTermCodes, prerequisites, completedBeforeAcademicYear);
      if (assessment.missing.length) {
        errors.push(`${code} is missing prerequisites: ${assessment.missing.join("; ")}.`);
      }
      for (const approval of assessment.approvals) {
        if (!hasMatchingConcurrentApproval(course, approval)) {
          const authority = approval.type === "department" ? "Economics Department" : `${code} instructor`;
          errors.push(`${code} is concurrent with ${approval.prerequisite} but is not marked as requiring approval from the ${authority}.`);
        }
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

  const remainingRequirementIds = new Set(remainingRequirements(mapping).map(item => item.requirementId));
  for (const requirementId of remainingRequirementIds) {
    if (!seenRequirements.has(requirementId)) {
      errors.push(`Requirement ${requirementId} remains unscheduled.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)],
    checkedCourseCount: seenCourses.size,
    checkedRequirementCount: seenRequirements.size
  };
}

export function classifyFeasibility(plan, student = {}) {
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

export function buildEconomicsTermPlan({
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
  if (context?.requiresSummerClarification) return null;
  const normalizedSchedule = normalizeEconomicsSchedule(schedule);

  const courses = normalizeStudentCourses(student.courses);
  const completedCodes = new Set(courses
    .filter(course => ["completed", "transfer"].includes(course.status) && canCountCompletedCourse(course))
    .map(course => course.code));
  const inProgressCodes = new Set(courses
    .filter(course => course.status === "in_progress" && canCountCompletedCourse(course))
    .map(course => course.code));
  const scheduledCodes = new Set([...completedCodes, ...inProgressCodes].map(code => canonicalScheduleCode(normalizedSchedule, code)));
  const slots = planSlotsFor(student, context);
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
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.studentMessages = [...new Set([
    ...plan.validation.warnings,
    ...plan.terms.flatMap(term => term.courses.flatMap(course => (
      course.approvalRequired || []
    ).map(approval => approval.type === "department"
      ? `${approval.prerequisite} is planned concurrently with ${course.course}. Economics Department approval is required.`
      : `${approval.prerequisite} is planned concurrently with ${course.course}. Approval from the ${course.course} instructor is required.`)))
  ])];
  plan.verification = {
    status: plan.feasibilityStatus,
    scheduleVerifiedOn: normalizedSchedule?.provider?.verifiedOn || null,
    hasApprovals: advisorChecks.length > 0
  };
  plan.warnings = plan.validation.warnings;
  return plan;
}

export function buildEconomicsTermPlans(args) {
  const context = resolvePlanningContext(args.student || {});
  if (args.student?.planCreationDate && context.requiresSummerClarification) {
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

export { EARLY_GRADUATION_VARIANT, PLAN_VARIANTS };
