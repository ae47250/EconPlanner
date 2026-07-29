import { buildPlanningSlots, resolvePlanningContext } from "./horizon.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";

const LEGACY_TERM_ORDER = ["Fall", "Winter", "May"];
const STANDING_INDEX = { freshman: 0, sophomore: 1, junior: 2, senior: 3 };
const PLAN_VARIANTS = [
  { id: "plan-1", label: "Plan 1", description: "Balanced plan with courses placed at the earliest safe terms." },
  { id: "plan-2", label: "Plan 2", description: "Junior-weighted plan with more flexible courses in junior year than senior year." },
  { id: "plan-3", label: "Plan 3", description: "Staggered later plan weighted toward senior year, then junior year." }
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
  return value ? String(value).replace("-", "/") : null;
}

function offeredCourse(schedule, term, code) {
  return (schedule?.terms?.[term] || []).find(course => course.course === code) || null;
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

function preferredSlotOrder(slots, variant, context, isElective) {
  if (!isElective || variant.id === "plan-1" || !context) return [...slots].sort((a, b) => a.order - b.order);

  const currentStandingIndex = STANDING_INDEX[context.effectiveStanding] ?? 0;
  const preferredStandingOrder = variant.id === "plan-2" ? [2, 3, 1, 0] : [3, 2, 1, 0];
  return [...slots].sort((a, b) => {
    const aStanding = Math.max(currentStandingIndex, a.absoluteStandingIndex ?? currentStandingIndex);
    const bStanding = Math.max(currentStandingIndex, b.absoluteStandingIndex ?? currentStandingIndex);
    const aRank = preferredStandingOrder.indexOf(aStanding);
    const bRank = preferredStandingOrder.indexOf(bStanding);
    return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank) || a.order - b.order;
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
  const termPlans = slots.map(slot => ({
    slotId: slot.id,
    term: slot.label,
    displayTerm: slot.displayTerm || slot.termKey,
    academicYear: slot.academicYear || normalizedAcademicYear(schedule?.academicYear),
    termKey: slot.termKey,
    yearIndex: slot.yearIndex,
    isSummer: slot.isSummer,
    courses: []
  }));
  const unscheduled = [];
  const advisorChecks = [];
  const summerFallbacks = [];

  function tryPlace(code, requirementId, isElective = false, allowSummer = false) {
    const candidateSlots = slots.filter(slot => (allowSummer || !slot.isSummer) && (allowSummer || slot.termKey !== "Summer"));
    for (const slot of preferredSlotOrder(candidateSlots, planVariant, context, isElective)) {
      const slotIndex = slots.indexOf(slot);
      const plan = termPlans[slotIndex];
      if (!canUseSlot(plan, slot, code)) continue;
      if (!isSeniorWinterOnly(code, slot, student, context)) continue;
      if (!isElective && !offeredCourse(schedule, slot.scheduleTerm, code)) continue;

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

  for (const item of mapping?.optimistic?.unresolved || []) {
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

      const offering = offeredCourse(schedule, selectedPlacement.slot.scheduleTerm, code);
      if (!offering) continue;
      selectedPlacement.plan.courses.push({
        ...offering,
        requirementId: requirement.id,
        source: selectedPlacement.slot.isSummer ? "summer-last-resort" : "verified-offering"
      });
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

  return {
    id: planVariant.id,
    label: planVariant.label,
    description: planVariant.description,
    academicYear: schedule?.academicYear || null,
    planningContext: context,
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
}

export function buildEconomicsTermPlans(args) {
  const context = resolvePlanningContext(args.student || {});
  if (args.student?.planCreationDate && context.requiresSummerClarification) {
    return { context, plans: [] };
  }

  const planningContext = args.student?.planCreationDate ? context : null;
  return {
    context: planningContext,
    plans: PLAN_VARIANTS.map(planVariant => buildEconomicsTermPlan({ ...args, planningContext, planVariant }))
  };
}

export { PLAN_VARIANTS };
