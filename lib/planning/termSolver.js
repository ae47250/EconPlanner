import { normalizeStudentCourses } from "../requirements/normalize.js";
import {
  availabilityIsStale,
  canonicalScheduleCode,
  meetingsConflict,
  normalizeEconomicsSchedule,
  scheduleOfferings
} from "./scheduleProvider.js";
import { assessCoursePrerequisites, evaluatePlanPrerequisites } from "./prerequisiteEvaluator.js";
import {
  canAllocateCourseToRequirement,
  mayAllocateCourseToRequirement
} from "./requirementAllocation.js";

export const TERM_SOLVER_NODE_LIMIT = 250_000;
const TERM_SOLVER_SOLUTION_BUDGET = 100;
const SUPPORTING_PLACEHOLDERS = new Set(["BUSN 323", "MAT 113", "MAT 121", "MAT 217", "PSY 217"]);
const PLANNING_PRIORITY = new Map([
  ["eco-113", 1], ["eco-114", 1], ["cognate", 1], ["statistics", 2],
  ["eco-213", 3], ["eco-214", 3], ["finance", 3],
  ["eco-elective-1", 4], ["eco-elective-2", 4], ["eco-elective-3", 4], ["eco-elective-4", 4],
  ["eco-461", 5]
]);

function academicYear(value) {
  return String(value || "").replace("/", "-");
}

function isEconomics(code) {
  return String(code || "").startsWith("ECO ");
}

function is100LevelEconomics(code) {
  return /^ECO 1\d{2}$/.test(String(code || ""));
}

function termCapacity(slot) {
  const reserved = Math.max(0, Number(slot.reservedCourseUnits || 0));
  return Math.max(0, (["Spring", "May", "Summer"].includes(slot.termKey) ? 1 : 4) - reserved);
}

function optionId(course, fallbackSlotId = "term") {
  return `${course.course}-${course.section || "TBC"}-${course.slotId || fallbackSlotId}`;
}

function availabilityRisk(course, referenceDate) {
  if (course.source !== "verified-offering" && course.source !== "summer-last-resort") return "unpublished";
  if (course.availability?.status === "waitlisted") return "waitlisted";
  if (course.availability?.status === "unknown") return "unknown";
  if (availabilityIsStale(course.availability, referenceDate)) return "stale";
  return "current";
}

function sourceRank(course) {
  if (course.source === "verified-offering") return 0;
  if (course.source === "summer-last-resort") return 1;
  if (course.source === "requirement-placeholder") return 2;
  if (course.source === "recurring-rule-unconfirmed") return 3;
  return 4;
}

function projectedTermAllowed(code, slot) {
  if (slot.isSummer) return false;
  if (code === "ECO 461") return slot.termKey === "Winter";
  if (["ECO 213", "ECO 214"].includes(code)) return ["Fall", "Winter"].includes(slot.termKey);
  if (["ECO 113", "ECO 114", "MAT 113", "MAT 121", "MAT 217", "ECO 257", "PSY 217", "ECO 321", "BUSN 323"].includes(code)) {
    return ["Fall", "Winter"].includes(slot.termKey);
  }
  return ["Fall", "Winter", "Spring", "May"].includes(slot.termKey);
}

function validElective(requirement, code, requirements, existingAssignments) {
  if (!isEconomics(code)) return false;
  return mayAllocateCourseToRequirement({
    requirement,
    code,
    requirements,
    assignments: existingAssignments
  });
}

function completedCourseCodes(student) {
  return new Set(normalizeStudentCourses(student.courses)
    .filter(course => ["completed", "transfer", "in_progress"].includes(course.status))
    .filter(course => course.code !== "ECO 461" || (
      course.status === "completed" && !/ap|transfer|equivalency|outside/i.test(course.source || "")
    ))
    .map(course => course.code));
}

function completedBeforePlanCodes(student) {
  return new Set(normalizeStudentCourses(student.courses)
    .filter(course => ["completed", "transfer"].includes(course.status))
    .filter(course => course.code !== "ECO 461" || (
      course.status === "completed" && !/ap|transfer|equivalency|outside/i.test(course.source || "")
    ))
    .map(course => course.code));
}

function existing100LevelElectives(mapping) {
  return (mapping.assignments || []).filter(item => (
    String(item.slotId || "").startsWith("eco-elective") && is100LevelEconomics(item.code)
  )).length;
}

function buildCoursePlacement({ requirement, code, slot, offering, title, source }) {
  const base = offering ? { ...offering } : {
    course: code,
    title,
    section: "",
    verificationStatus: "unverified",
    availability: { status: "unknown", seatsOpen: null, capacity: null, asOf: null },
    meeting: { days: [], startMinutes: null, endMinutes: null }
  };
  return {
    ...base,
    course: code,
    title: base.title || title || requirement.label,
    requirementId: requirement.id,
    slotId: slot.id,
    source,
    offeringStatus: source === "verified-offering" || source === "summer-last-resort"
      ? "verified"
      : source === "requirement-placeholder"
        ? "schedule_confirmation_required"
        : "future_schedule_confirmation_required",
    ...(code === "ECO 461" ? { residency: "hanover" } : {})
  };
}

function requirementDomains({ requirement, requirements, slots, schedule, mapping, courseTitles, existingAssignments }) {
  const choices = [];
  const scheduleYear = academicYear(schedule?.academicYear);
  const options = [...new Set([...(requirement.preferredOptions || []), ...(requirement.options || [])])];

  if (requirement.kind === "elective") {
    for (const slot of slots) {
      const isVerifiedYear = academicYear(slot.academicYear) === scheduleYear;
      if (isVerifiedYear) {
        for (const offering of Object.values(schedule?.terms || {}).flat().filter(item => (
          item.term === slot.scheduleTerm
          && academicYear(item.academicYear) === academicYear(slot.academicYear)
          && item.verificationStatus === "verified"
          && item.availability?.status !== "closed"
          && validElective(requirement, item.course, requirements, existingAssignments)
        ))) {
          choices.push(buildCoursePlacement({
            requirement,
            code: offering.course,
            slot,
            offering,
            title: offering.title,
            source: slot.isSummer ? "summer-last-resort" : "verified-offering"
          }));
        }
      } else if (!slot.isSummer && ["Fall", "Winter", "Spring"].includes(slot.termKey)) {
        choices.push({
          ...buildCoursePlacement({
            requirement,
            code: "ECO elective",
            slot,
            title: "Eligible ECO elective (future offering to verify)",
            source: "projected-offering"
          }),
          minimumLevel: existing100LevelElectives(mapping) ? 200 : null
        });
      }
    }
    return choices;
  }

  for (const code of options) {
    for (const slot of slots) {
      if (code === "ECO 461" && (slot.termKey !== "Winter" || slot.absoluteStandingIndex < 3)) continue;
      const isVerifiedYear = academicYear(slot.academicYear) === scheduleYear;
      const offerings = isVerifiedYear ? scheduleOfferings(schedule, slot, code) : [];
      for (const offering of offerings) {
        if (offering.verificationStatus !== "verified" || offering.availability?.status === "closed") continue;
        choices.push(buildCoursePlacement({
          requirement,
          code,
          slot,
          offering,
          title: courseTitles.get(code),
          source: slot.isSummer ? "summer-last-resort" : "verified-offering"
        }));
      }
      if (offerings.length) continue;
      if (isVerifiedYear && SUPPORTING_PLACEHOLDERS.has(code) && ["Fall", "Winter"].includes(slot.termKey)) {
        choices.push(buildCoursePlacement({
          requirement,
          code,
          slot,
          title: courseTitles.get(code),
          source: "requirement-placeholder"
        }));
      } else if (!isVerifiedYear && projectedTermAllowed(code, slot)) {
        choices.push(buildCoursePlacement({
          requirement,
          code,
          slot,
          title: courseTitles.get(code),
          source: code === "ECO 461" ? "recurring-rule-unconfirmed" : "projected-offering"
        }));
      }
    }
  }
  return choices;
}

function planTerms(slots, assignments) {
  return slots.map(slot => ({
    slotId: slot.id,
    term: slot.label,
    displayTerm: slot.displayTerm || slot.termKey,
    academicYear: slot.academicYear,
    termKey: slot.termKey,
    scheduleTerm: slot.scheduleTerm,
    yearIndex: slot.yearIndex,
    absoluteStandingIndex: slot.absoluteStandingIndex,
    isSummer: slot.isSummer,
    courses: assignments.filter(item => item.slotId === slot.id)
      .map(({ slotId: _slotId, ...course }) => course)
      .sort((left, right) => left.course.localeCompare(right.course) || String(left.section).localeCompare(String(right.section)))
  })).filter(term => !term.isSummer || term.courses.length);
}

function planCourseMetrics(plan, student, targetDistribution) {
  const terms = plan.terms || [];
  const courses = terms.flatMap(term => term.courses || []);
  const approvals = courses.flatMap(course => course.approvalRequired || []);
  const conditions = courses.map(course => availabilityRisk(course, student.planCreationDate));
  const maxEco = Math.max(0, ...terms.map(term => term.courses.filter(course => isEconomics(course.course)).length));
  const regularLoads = terms.filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey)).map(term => term.courses.length);
  const yearCounts = new Map();
  for (const term of terms) yearCounts.set(term.yearIndex, (yearCounts.get(term.yearIndex) || 0) + term.courses.length);
  const distributionDistance = (targetDistribution?.targetYearCounts || []).reduce((sum, target, yearIndex) => (
    sum + Math.abs(target - (yearCounts.get(yearIndex) || 0))
  ), 0) + Object.entries(targetDistribution?.targetTermCounts || {}).reduce((sum, [slotId, target]) => {
    const actual = terms.find(term => term.slotId === slotId)?.courses.length || 0;
    return sum + Math.abs(target - actual);
  }, 0);
  return {
    unverified: courses.filter(course => sourceRank(course) >= 2).length,
    approvals: approvals.reduce((sum, item) => sum + (item.type === "department" ? 2 : 1), 0),
    conditions: conditions.filter(item => item !== "current" && item !== "unpublished").length,
    summer: courses.filter(course => course.source === "summer-last-resort").length,
    maxEco,
    loadSquares: regularLoads.reduce((sum, count) => sum + count * count, 0),
    imbalance: regularLoads.length ? Math.max(...regularLoads) - Math.min(...regularLoads) : 0,
    distributionDistance
  };
}

function compareMetrics(left, right) {
  const keys = ["distributionDistance", "summer", "unverified", "approvals", "conditions", "maxEco", "loadSquares", "imbalance"];
  for (const key of keys) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

function annualCoverageSatisfied(assignments, slots, unresolvedCount) {
  const years = [...new Set(slots.filter(slot => !slot.isSummer).map(slot => slot.yearIndex))];
  if (unresolvedCount < years.length) return true;
  return years.every(yearIndex => assignments.some(item => slots.find(slot => slot.id === item.slotId)?.yearIndex === yearIndex));
}

function preferredAnnualDistributionSatisfied(assignments, slots, distribution) {
  const targets = distribution?.targetYearCounts;
  if (!Array.isArray(targets) || !targets.length) return true;
  return targets.every((target, yearIndex) => (
    assignments.filter(item => slots.find(slot => slot.id === item.slotId)?.yearIndex === yearIndex).length === target
  ));
}

function decorateApprovals(plan, approvals) {
  for (const approval of approvals) {
    const term = plan.terms.find(item => item.term === approval.term);
    const course = term?.courses.find(item => item.course === approval.course);
    if (!course) continue;
    course.approvalRequired = [...(course.approvalRequired || []), approval];
  }
}

function addElectiveAlternatives(plan, domains, student, mapping, prerequisites) {
  const selected = plan.terms.flatMap(term => term.courses.map(course => ({ term, course })));
  const requirementsById = new Map((mapping.requirements || []).map(requirement => [requirement.id, requirement]));
  for (const { term, course } of selected) {
    if (!String(course.requirementId || "").startsWith("eco-elective") || course.course === "ECO elective") continue;
    const risk = availabilityRisk(course, student.planCreationDate);
    const alternatives = (domains.get(course.requirementId) || []).filter(option => (
      option.slotId === term.slotId
      && option.course !== course.course
      && availabilityRisk(option, student.planCreationDate) === risk
      && !selected.some(item => item.course.course === option.course)
      && !term.courses.some(other => other !== course && meetingsConflict(option, other))
    )).filter(option => {
      const allocationAssignments = [
        ...(mapping.assignments || []),
        ...selected.map(item => ({
          slotId: item.course.requirementId,
          code: item.course === course ? option.course : item.course.course
        }))
      ];
      if (!canAllocateCourseToRequirement({
        requirement: requirementsById.get(course.requirementId),
        code: option.course,
        assignments: allocationAssignments
      })) return false;
      if (is100LevelEconomics(option.course)) {
        const otherSelected100 = selected.filter(item => (
          item.course !== course
          && String(item.course.requirementId || "").startsWith("eco-elective")
          && is100LevelEconomics(item.course.course)
        )).length;
        if (existing100LevelElectives(mapping) + otherSelected100 >= 1) return false;
      }
      const termIndex = plan.terms.findIndex(item => item.slotId === term.slotId);
      const beforeTerm = completedCourseCodes(student);
      for (const item of selected) {
        const itemTermIndex = plan.terms.findIndex(candidate => candidate.slotId === item.term.slotId);
        if (itemTermIndex < termIndex && item.course.course !== "ECO elective") beforeTerm.add(item.course.course);
      }
      const sameTerm = new Set(term.courses
        .filter(item => item !== course && item.course !== "ECO elective")
        .map(item => item.course));
      sameTerm.add(option.course);
      const assessment = assessCoursePrerequisites({
        code: option.course,
        term,
        beforeTerm,
        sameTerm,
        completedBeforePlan: completedBeforePlanCodes(student),
        prerequisites
      });
      return assessment.valid && assessment.requiredApprovals.length === 0;
    });
    const all = [course, ...alternatives]
      .map(option => ({
        id: optionId(option, term.slotId),
        course: option.course,
        section: option.section || "",
        title: option.title || option.course,
        source: option.source,
        availability: option.availability || null,
        meeting: option.meeting || null,
        verificationStatus: option.verificationStatus || "unverified"
      }))
      .sort((left, right) => left.course.localeCompare(right.course) || left.section.localeCompare(right.section));
    if (all.length > 1) {
      course.selectedOptionId = optionId(course, term.slotId);
      course.alternativeOptions = all;
    }
  }
}

export function solveEconomicsTermPlan({
  student = {},
  mapping,
  schedule,
  prerequisites = {},
  courseCatalog = [],
  slots = [],
  context = null,
  distribution = null,
  planningMode = "standard",
  allowConcurrentMath = false,
  requireAnnualCoverage = true,
  requireTargetDistribution = false,
  nodeLimit = TERM_SOLVER_NODE_LIMIT
}) {
  const normalizedSchedule = normalizeEconomicsSchedule(schedule);
  const unresolvedIds = new Set((mapping?.projectedAfterInProgress?.optimistic?.unresolved || mapping?.optimistic?.unresolved || [])
    .map(item => item.requirementId));
  const requirements = (mapping?.requirements || []).filter(item => unresolvedIds.has(item.id));
  const selectedCodes = completedCourseCodes(student);
  const completedBeforePlan = completedBeforePlanCodes(student);
  const courseTitles = new Map(courseCatalog.map(course => [course.code, course.title]));
  const existingAssignments = mapping?.assignments || [];
  const domains = new Map(requirements.map(requirement => [
    requirement.id,
    requirementDomains({
      requirement,
      requirements: mapping?.requirements || [],
      slots,
      schedule: normalizedSchedule,
      mapping,
      courseTitles,
      existingAssignments
    })
      .sort((left, right) => sourceRank(left) - sourceRank(right)
        || slots.findIndex(slot => slot.id === left.slotId) - slots.findIndex(slot => slot.id === right.slotId)
        || left.course.localeCompare(right.course)
        || String(left.section).localeCompare(String(right.section)))
  ]));
  const totalCapacity = slots.reduce((sum, slot) => sum + termCapacity(slot), 0);
  const minimumEconomicsCourses = requirements.filter(requirement => (
    requirement.kind === "elective"
    || (requirement.options || []).every(code => isEconomics(code))
  )).length;
  const economicsCapacity = slots.reduce((sum, slot) => {
    if (["Fall", "Winter"].includes(slot.termKey)) return sum + Math.min(termCapacity(slot), planningMode === "standard" ? 2 : 4);
    return sum + (slot.isSummer ? Math.min(termCapacity(slot), 1) : Math.min(termCapacity(slot), 1));
  }, 0);
  if (requirements.length > totalCapacity || minimumEconomicsCourses > economicsCapacity) {
    return {
      solution: null,
      metrics: null,
      domains,
      search: {
        complete: true,
        nodesVisited: 0,
        limit: nodeLimit,
        completionAttempts: 0,
        prerequisiteFailures: 0,
        deadEnds: 0,
        deadEndsByRequirement: {},
        prerequisiteFailureReasons: {},
        firstSolutionNode: null,
        validSolutionCount: 0,
        terminationReason: "COUNT_CAPACITY"
      },
      failure: "COUNT_CAPACITY"
    };
  }
  const orderedRequirements = [...requirements].sort((left, right) => (
    (PLANNING_PRIORITY.get(left.id) || 50) - (PLANNING_PRIORITY.get(right.id) || 50)
    || (domains.get(left.id)?.length || 0) - (domains.get(right.id)?.length || 0)
    || left.id.localeCompare(right.id)
  ));

  let nodesVisited = 0;
  let exhausted = false;
  let terminationReason = null;
  let best = null;
  let firstSolutionNode = null;
  let completionAttempts = 0;
  let validSolutionCount = 0;
  let prerequisiteFailures = 0;
  let deadEnds = 0;
  const deadEndsByRequirement = new Map();
  const prerequisiteFailureReasons = new Map();
  const assigned = [];
  const usedCodes = new Set([...selectedCodes].map(code => canonicalScheduleCode(normalizedSchedule, code)));
  const termCourses = new Map(slots.map(slot => [slot.id, []]));
  const memo = new Set();
  const starting100LevelCount = existing100LevelElectives(mapping);

  function legal(choice, requirement) {
    const slot = slots.find(item => item.id === choice.slotId);
    const inTerm = termCourses.get(choice.slotId);
    if (!slot || inTerm.length >= termCapacity(slot)) return false;
    if (requireTargetDistribution && Array.isArray(distribution?.targetYearCounts)) {
      const target = distribution.targetYearCounts[slot.yearIndex] ?? 0;
      const assignedInYear = assigned.filter(item => (
        slots.find(candidateSlot => candidateSlot.id === item.slotId)?.yearIndex === slot.yearIndex
      )).length;
      if (assignedInYear >= target) return false;
    }
    const canonical = choice.course === "ECO elective" ? null : canonicalScheduleCode(normalizedSchedule, choice.course);
    if (canonical && usedCodes.has(canonical)) return false;
    if (choice.course !== "ECO elective" && inTerm.some(course => meetingsConflict(choice, course))) return false;
    if (requirement.kind === "elective" && is100LevelEconomics(choice.course)) {
      const assigned100 = assigned.filter(item => (
        String(item.requirementId || "").startsWith("eco-elective") && is100LevelEconomics(item.course)
      )).length;
      if (starting100LevelCount + assigned100 >= 1) return false;
    }
    const ecoCount = inTerm.filter(course => isEconomics(course.course)).length + (isEconomics(choice.course) ? 1 : 0);
    if (planningMode === "standard" && ["Fall", "Winter"].includes(slot.termKey) && ecoCount > 2) return false;
    if (["Fall", "Winter"].includes(slot.termKey) && ecoCount > 4) return false;
    if (["ECO 213", "ECO 214"].includes(choice.course) && choice.source === "projected-offering") {
      const counterpart = choice.course === "ECO 213" ? "ECO 214" : "ECO 213";
      if (inTerm.some(course => course.course === counterpart && course.source === "projected-offering")) return false;
    }
    const allocationAssignments = [
      ...existingAssignments,
      ...assigned.map(item => ({ slotId: item.requirementId, code: item.course }))
    ];
    if (!canAllocateCourseToRequirement({
      requirement,
      code: choice.course,
      assignments: allocationAssignments
    })) return false;
    if (requirement.kind === "elective") {
      const previousElective = [...assigned].reverse().find(item => String(item.requirementId || "").startsWith("eco-elective"));
      if (previousElective) {
        const previousKey = `${String(slots.findIndex(item => item.id === previousElective.slotId)).padStart(3, "0")}:${previousElective.course}:${previousElective.section || ""}`;
        const choiceKey = `${String(slots.findIndex(item => item.id === choice.slotId)).padStart(3, "0")}:${choice.course}:${choice.section || ""}`;
        if (choiceKey < previousKey) return false;
      }
    }
    if (choice.course !== "ECO elective") {
      const choiceSlotIndex = slots.findIndex(item => item.id === choice.slotId);
      const beforeTerm = new Set(selectedCodes);
      const sameTerm = new Set([choice.course]);
      for (const item of assigned) {
        const itemSlotIndex = slots.findIndex(slotItem => slotItem.id === item.slotId);
        if (itemSlotIndex < choiceSlotIndex) beforeTerm.add(item.course);
        if (item.slotId === choice.slotId) sameTerm.add(item.course);
      }
      const prerequisiteAssessment = assessCoursePrerequisites({
        code: choice.course,
        term: slot,
        beforeTerm,
        sameTerm,
        completedBeforePlan,
        prerequisites
      });
      if (!prerequisiteAssessment.valid) return false;
      if (!allowConcurrentMath && prerequisiteAssessment.requiredApprovals.some(item => item.type === "instructor")) return false;
    }
    return true;
  }

  function visit(index) {
    if (nodesVisited >= nodeLimit) {
      exhausted = true;
      terminationReason = "NODE_LIMIT";
      return;
    }
    nodesVisited += 1;
    if (index === orderedRequirements.length) {
      completionAttempts += 1;
      if (requireAnnualCoverage && !annualCoverageSatisfied(assigned, slots, requirements.length)) return;
      if (requireTargetDistribution && !preferredAnnualDistributionSatisfied(assigned, slots, distribution)) return;
      const plan = { terms: planTerms(slots, assigned) };
      const prereq = evaluatePlanPrerequisites({ plan, student, prerequisites, context, requireRecordedApprovals: false });
      if (!prereq.valid) {
        prerequisiteFailures += 1;
        const reason = prereq.errors[0] || "unknown";
        prerequisiteFailureReasons.set(reason, (prerequisiteFailureReasons.get(reason) || 0) + 1);
        return;
      }
      if (!allowConcurrentMath && prereq.requiredApprovals.some(item => item.type === "instructor")) return;
      validSolutionCount += 1;
      decorateApprovals(plan, prereq.requiredApprovals);
      const metrics = planCourseMetrics(plan, student, distribution);
      const signature = JSON.stringify(plan.terms.map(term => [term.slotId, term.courses.map(course => [course.requirementId, course.course, course.section])]));
      if (!best || compareMetrics(metrics, best.metrics) < 0 || (compareMetrics(metrics, best.metrics) === 0 && signature < best.signature)) {
        if (firstSolutionNode === null) firstSolutionNode = nodesVisited;
        best = { plan, metrics, signature, prereq };
      }
      if (validSolutionCount >= TERM_SOLVER_SOLUTION_BUDGET) {
        exhausted = true;
        terminationReason = "SOLUTION_BUDGET";
      }
      return;
    }

    if (best) {
      const remainingRequirements = orderedRequirements.slice(index);
      const assignedUnverified = assigned.filter(course => sourceRank(course) >= 2).length;
      const unavoidableUnverified = remainingRequirements.filter(item => (
        !(domains.get(item.id) || []).some(course => sourceRank(course) < 2)
      )).length;
      const assignedConditions = assigned.filter(course => {
        const risk = availabilityRisk(course, student.planCreationDate);
        return risk !== "current" && risk !== "unpublished";
      }).length;
      const assignedSummer = assigned.filter(course => course.source === "summer-last-resort").length;
      const currentMaxEco = Math.max(0, ...slots.map(slot => (
        termCourses.get(slot.id).filter(course => isEconomics(course.course)).length
      )));
      const lowerBound = {
        unverified: assignedUnverified + unavoidableUnverified,
        approvals: 0,
        conditions: assignedConditions,
        summer: assignedSummer,
        maxEco: currentMaxEco,
        distributionDistance: 0,
        loadSquares: 0,
        imbalance: 0
      };
      if (compareMetrics(lowerBound, best.metrics) > 0) return;
    }

    const requirement = orderedRequirements[index];
    const choices = domains.get(requirement.id) || [];
    if (!choices.length) {
      deadEnds += 1;
      deadEndsByRequirement.set(requirement.id, (deadEndsByRequirement.get(requirement.id) || 0) + 1);
      return;
    }
    const stateKey = `${index}|${assigned.map(item => `${item.requirementId}:${item.course}:${item.section || ""}:${item.slotId}`).sort().join("|")}`;
    if (memo.has(stateKey)) return;
    memo.add(stateKey);
    const assignedYearCounts = new Map();
    for (const item of assigned) {
      const yearIndex = slots.find(slot => slot.id === item.slotId)?.yearIndex;
      assignedYearCounts.set(yearIndex, (assignedYearCounts.get(yearIndex) || 0) + 1);
    }
    const orderedChoices = [...choices].sort((left, right) => {
      const leftSlot = slots.find(slot => slot.id === left.slotId);
      const rightSlot = slots.find(slot => slot.id === right.slotId);
      const leftYearOpen = (assignedYearCounts.get(leftSlot?.yearIndex) || 0) < (distribution?.targetYearCounts?.[leftSlot?.yearIndex] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const rightYearOpen = (assignedYearCounts.get(rightSlot?.yearIndex) || 0) < (distribution?.targetYearCounts?.[rightSlot?.yearIndex] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const leftTermOpen = termCourses.get(left.slotId).length < (distribution?.targetTermCounts?.[left.slotId] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const rightTermOpen = termCourses.get(right.slotId).length < (distribution?.targetTermCounts?.[right.slotId] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const leftSummer = leftSlot?.isSummer ? 1 : 0;
      const rightSummer = rightSlot?.isSummer ? 1 : 0;
      return leftYearOpen - rightYearOpen
        || leftTermOpen - rightTermOpen
        || leftSummer - rightSummer
        || sourceRank(left) - sourceRank(right)
        || choices.indexOf(left) - choices.indexOf(right);
    });
    let legalChoiceCount = 0;
    for (const choice of orderedChoices) {
      if (!legal(choice, requirement)) continue;
      legalChoiceCount += 1;
      const canonical = choice.course === "ECO elective" ? null : canonicalScheduleCode(normalizedSchedule, choice.course);
      assigned.push(choice);
      termCourses.get(choice.slotId).push(choice);
      if (canonical) usedCodes.add(canonical);
      visit(index + 1);
      if (canonical) usedCodes.delete(canonical);
      termCourses.get(choice.slotId).pop();
      assigned.pop();
      if (exhausted) break;
    }
    if (!legalChoiceCount) {
      deadEnds += 1;
      deadEndsByRequirement.set(requirement.id, (deadEndsByRequirement.get(requirement.id) || 0) + 1);
    }
  }

  visit(0);
  if (best) addElectiveAlternatives(best.plan, domains, student, mapping, prerequisites);
  return {
    solution: best?.plan || null,
    metrics: best?.metrics || null,
    domains,
    search: {
      complete: !exhausted,
      nodesVisited,
      limit: nodeLimit,
      completionAttempts,
      prerequisiteFailures,
      deadEnds,
      deadEndsByRequirement: Object.fromEntries(deadEndsByRequirement),
      prerequisiteFailureReasons: Object.fromEntries([...prerequisiteFailureReasons].slice(0, 10)),
      firstSolutionNode,
      validSolutionCount,
      terminationReason
    },
    failure: exhausted && !best ? "SEARCH_INCOMPLETE" : best ? null : "NO_COMPLETE_ASSIGNMENT"
  };
}
