import { buildPlanningSlots, resolvePlanningContext } from "./horizon.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";

const LEGACY_TERM_ORDER = ["Fall", "Winter", "May"];
const STANDING_INDEX = { freshman: 0, sophomore: 1, junior: 2, senior: 3 };
const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const PLAN_VARIANTS = [
  { id: "plan-1", label: "Plan A", strategy: "equal", description: "Courses are distributed as evenly as possible across the remaining academic years." },
  { id: "plan-2", label: "Plan B", strategy: "increasing", description: "Courses gradually increase in later academic years, creating a staggered path to graduation." },
  { id: "plan-3", label: "Plan C", strategy: "standing-specific", description: "The distribution is adjusted for class standing, with a lighter early path when appropriate." }
];

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

function offeredCourse(schedule, slot, code) {
  const scheduleYear = normalizedAcademicYear(schedule?.academicYear);
  const slotYear = normalizedAcademicYear(slot?.academicYear) || scheduleYear;
  if (scheduleYear && slotYear && scheduleYear !== slotYear) return null;
  const term = slot?.scheduleTerm || slot?.termKey || slot;
  return (schedule?.terms?.[term] || []).find(course => course.course === code) || null;
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
    targetYearCounts = distributeByWeights(total, [2, 2, 4, 4].slice(0, yearCount));
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

function prerequisiteMissing(code, completedCodes, prerequisites) {
  const rule = prerequisites?.[code];
  if (!rule) return [];
  const missing = (rule.all || []).filter(item => !completedCodes.has(item));
  for (const group of rule.any || []) {
    if (!group.some(item => completedCodes.has(item))) missing.push(group.join(" / "));
  }
  return missing;
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

function termCapacity(slot) {
  if (slot.termKey === "Spring" || slot.termKey === "May" || slot.termKey === "Summer") return { total: 1, economics: 1 };
  return { total: 4, economics: 2 };
}

function canUseSlot(plan, slot, code) {
  const capacity = termCapacity(slot);
  if (plan.courses.length >= capacity.total) return false;
  if (isEconomicCourse(code) && plan.courses.filter(course => isEconomicCourse(course.course)).length >= capacity.economics) return false;
  if (code === "ECO 213" && plan.courses.some(course => course.course === "ECO 214")) return false;
  if (code === "ECO 214" && plan.courses.some(course => course.course === "ECO 213")) return false;
  return true;
}

function availableBeforeSlot(termPlans, slotIndex, completedCodes) {
  const available = new Set(completedCodes);
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
  if (planningContext?.hasExplicitDate) return buildPlanningSlots(planningContext).map((slot, order) => ({ ...slot, order }));
  return legacySlots();
}

function visibleTerms(termPlans) {
  return termPlans.filter(plan => !plan.isSummer || plan.courses.length > 0);
}

function planSignature(plan) {
  return JSON.stringify((plan?.terms || []).map(term => ({
    slot: term.slotId || term.term,
    courses: (term.courses || []).map(course => `${course.course}:${course.requirementId || ""}`)
  })));
}

export function validateGeneratedPlan(plan, { student = {}, mapping, schedule, prerequisites = {}, context = null } = {}) {
  const errors = [];
  const requirementsById = new Map((mapping?.requirements || []).map(requirement => [requirement.id, requirement]));
  const courses = normalizeStudentCourses(student.courses);
  const completedCodes = new Set(courses
    .filter(course => ["completed", "transfer", "in_progress"].includes(course.status) && canCountCompletedCourse(course))
    .map(course => course.code));
  const seenCourses = new Set();
  const seenRequirements = new Set();
  const availableCodes = new Set(completedCodes);

  for (const term of plan?.terms || []) {
    const capacity = termCapacity(term);
    const economicsCount = (term.courses || []).filter(course => isEconomicCourse(course.course)).length;
    if (term.courses.length > capacity.total) errors.push(`${term.term} exceeds the total course limit.`);
    if (economicsCount > capacity.economics) errors.push(`${term.term} exceeds the Economics course limit.`);
    if ((term.termKey === "Spring" || term.termKey === "May") && term.courses.length > 1) {
      errors.push(`${term.term} exceeds the Spring/May one-course limit.`);
    }

    const termCodes = new Set();
    for (const course of term.courses || []) {
      if (course.course === "ECO elective") continue;
      const code = course.course;
      const requirement = requirementsById.get(course.requirementId);
      if (!requirement || !(requirement.options || []).includes(code)) {
        errors.push(`${code} is not a valid course for requirement ${course.requirementId || "unknown"}.`);
      }
      if (seenCourses.has(code) || completedCodes.has(code)) errors.push(`${code} is duplicated or already listed as completed/current.`);
      if (seenRequirements.has(course.requirementId)) errors.push(`Requirement ${course.requirementId} is assigned more than once.`);
      seenCourses.add(code);
      seenRequirements.add(course.requirementId);
      termCodes.add(code);

      if (!offeredCourse(schedule, term, code)) {
        errors.push(`${code} is not verified in the ${term.academicYear || "scheduled"} ${term.termKey} offering.`);
      }
      if (course.source !== "verified-offering" && course.source !== "summer-last-resort") {
        errors.push(`${code} does not have a verified-offering source.`);
      }
      if (term.isSummer && code !== "ECO 113") errors.push(`${code} is not allowed in a Summer slot.`);
      if (!isSeniorWinterOnly(code, term, student, context)) errors.push(`${code} is not in a valid senior Winter slot.`);

      const missing = prerequisiteMissing(code, availableCodes, prerequisites);
      if (missing.length) errors.push(`${code} is missing prerequisites: ${missing.join("; ")}.`);
    }
    if (termCodes.has("ECO 213") && termCodes.has("ECO 214")) errors.push(`${term.term} contains both ECO 213 and ECO 214.`);
    for (const code of termCodes) availableCodes.add(code);
  }

  return {
    valid: errors.length === 0,
    errors,
    checkedCourseCount: seenCourses.size,
    checkedRequirementCount: seenRequirements.size
  };
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
    valid: plans.length === PLAN_VARIANTS.length && uniqueSignatures.size === plans.length && plans.every(plan => plan.validation?.valid !== false),
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
  planningContext = null,
  planVariant = PLAN_VARIANTS[0]
}) {
  const context = planningContext || (student.planCreationDate ? resolvePlanningContext(student) : null);
  if (context?.requiresSummerClarification) return null;

  const courses = normalizeStudentCourses(student.courses);
  const completedCodes = new Set(courses
    .filter(course => ["completed", "transfer", "in_progress"].includes(course.status) && canCountCompletedCourse(course))
    .map(course => course.code));
  const scheduledCodes = new Set(completedCodes);
  const slots = planSlotsFor(student, context);
  const unresolvedItems = mapping?.optimistic?.unresolved || [];
  const distribution = buildDistribution(unresolvedItems.length, context, planVariant, slots);
  const yearCounts = new Map();
  const termCounts = new Map();
  const termPlans = slots.map(slot => ({
    slotId: slot.id,
    term: slot.label,
    displayTerm: slot.displayTerm || slot.termKey,
    academicYear: slot.academicYear || normalizedAcademicYear(schedule?.academicYear),
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

  function tryPlace(code, requirementId, isElective = false, allowSummer = false) {
    const candidateSlots = slots.filter(slot => (allowSummer || !slot.isSummer) && (allowSummer || slot.termKey !== "Summer"));
    for (const slot of preferredSlotOrder(candidateSlots, context, distribution, yearCounts, termCounts)) {
      const slotIndex = slots.indexOf(slot);
      const plan = termPlans[slotIndex];
      const targetCount = distribution.targetYearCounts[slot.yearIndex];
      if (context && targetCount !== undefined && (yearCounts.get(slot.yearIndex) || 0) >= targetCount) continue;
      const targetTermCount = distribution.targetTermCounts[slot.id];
      if (context && targetTermCount !== undefined && (termCounts.get(slot.id) || 0) >= targetTermCount) continue;
      if (!canUseSlot(plan, slot, code)) continue;
      if (!isSeniorWinterOnly(code, slot, student, context)) continue;
      if (!isElective && !offeredCourse(schedule, slot, code)) continue;

      const available = availableBeforeSlot(termPlans, slotIndex, completedCodes);
      const missing = prerequisiteMissing(code, available, prerequisites);
      if (missing.length) {
        addAdvisorCheck(advisorChecks, {
          course: code,
          term: plan.term,
          reason: `Prerequisites must be completed before this course: ${missing.join("; ")}`
        });
        continue;
      }

      return { slot, slotIndex, plan };
    }
    return null;
  }

  for (const item of unresolvedItems) {
    const requirement = (mapping.requirements || []).find(candidate => candidate.id === item.requirementId);
    if (!requirement) continue;

    if (requirement.kind === "elective") {
      const placement = tryPlace("ECO elective", requirement.id, true);
      if (placement) {
        placement.plan.courses.push({
          course: "ECO elective",
          title: "Eligible ECO elective (future offering to verify)",
          requirementId: requirement.id,
          source: "advisor-placeholder"
        });
        yearCounts.set(placement.slot.yearIndex, (yearCounts.get(placement.slot.yearIndex) || 0) + 1);
        termCounts.set(placement.slot.id, (termCounts.get(placement.slot.id) || 0) + 1);
        addAdvisorCheck(advisorChecks, {
          course: "ECO elective",
          term: placement.plan.term,
          reason: "Choose an eligible ECO elective after the future offering is published; the exact future offering is not yet verified."
        });
      } else {
        unscheduled.push({
          requirementId: requirement.id,
          label: requirement.label,
          course: "ECO elective",
          reason: "No safe term has capacity for this elective placeholder."
        });
      }
      continue;
    }

    let placed = false;
    for (const code of requirement.options || []) {
      if (scheduledCodes.has(code)) continue;
      const placement = tryPlace(code, requirement.id);
      const summerPlacement = !placement && code === "ECO 113"
        ? tryPlace(code, requirement.id, false, true)
        : null;
      const selectedPlacement = placement || summerPlacement;
      if (!selectedPlacement) continue;

      const offering = offeredCourse(schedule, selectedPlacement.slot, code);
      if (!offering) continue;
      selectedPlacement.plan.courses.push({
        ...offering,
        requirementId: requirement.id,
        source: selectedPlacement.slot.isSummer ? "summer-last-resort" : "verified-offering"
      });
      yearCounts.set(selectedPlacement.slot.yearIndex, (yearCounts.get(selectedPlacement.slot.yearIndex) || 0) + 1);
      termCounts.set(selectedPlacement.slot.id, (termCounts.get(selectedPlacement.slot.id) || 0) + 1);
      scheduledCodes.add(code);
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
      placed = true;
      break;
    }

    if (!placed) {
      unscheduled.push({
        requirementId: requirement.id,
        label: requirement.label,
        course: (requirement.options || []).join(" / ") || requirement.label,
        reason: "No verified offering is available in the current schedule data for a safe placement under the current prerequisites and planning horizon."
      });
    }
  }

  for (const plan of termPlans) {
    const coursesInPlan = new Set(plan.courses.map(course => course.course));
    if (coursesInPlan.has("ECO 213") && coursesInPlan.has("ECO 214")) {
      addAdvisorCheck(advisorChecks, {
        course: "ECO 213 / ECO 214",
        term: plan.term,
        reason: "These courses cannot share a term."
      });
    }
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
    description: planVariant.description,
    academicYear: schedule?.academicYear || null,
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
    rules: [
      "Prerequisites must precede dependent courses.",
      "ECO 213 and ECO 214 cannot share a term or be placed in Spring/May.",
      "ECO 461 is senior Winter only.",
      "Spring/May has at most one total course.",
      "Summer courses are excluded unless ECO 113 requires a last-resort online placement."
    ]
  };
  plan.validation = validateGeneratedPlan(plan, { student, mapping, schedule, prerequisites, context });
  return plan;
}

export function buildEconomicsTermPlans(args) {
  const context = resolvePlanningContext(args.student || {});
  if (args.student?.planCreationDate && context.requiresSummerClarification) {
    return { context, plans: [] };
  }

  const planningContext = args.student?.planCreationDate ? context : null;
  const plans = PLAN_VARIANTS.map(planVariant => buildEconomicsTermPlan({ ...args, planningContext, planVariant }));
  const planSetValidation = validatePlanSet(plans);
  const labeledPlans = planSetValidation.valid
    ? plans
    : plans.map((plan, index) => ({ ...plan, label: `Draft ${String.fromCharCode(65 + index)}` }));
  return {
    context: planningContext,
    plans: labeledPlans,
    planSetValidation
  };
}

export { PLAN_VARIANTS };
