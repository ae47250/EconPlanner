import { normalizeStudentCourses } from "../requirements/normalize.js";
import {
  availabilityIsStale,
  canonicalScheduleCode,
  meetingsConflict,
  normalizeEconomicsSchedule,
  scheduleOfferingDecision,
  scheduleOfferings,
  selectConflictFreeOffering
} from "./scheduleProvider.js";
import { assessCoursePrerequisites, evaluatePlanPrerequisites } from "./prerequisiteEvaluator.js";
import { mayAllocateCourseToRequirement } from "./requirementAllocation.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";
import {SCHEDULE_PROVENANCE} from "./notices.js";
import {loadPlanningFlexibilityPolicy} from "../catalog/policy-releases.js";
import {termLoadCapacity} from "../policy/term-load.js";
import { preliminaryEvidenceFor, preliminaryTermId } from "../policy/preliminary-schedule.js";
import {
  partialTermShapeTierRank,
  plannerTrackedCourse,
  plannerTrackedTermLoad,
  termShapePenalty
} from "./distribution.js";

export const TERM_SOLVER_NODE_LIMIT = 250_000;
export const TERM_SOLVER_SOLUTION_BUDGET = 100;
const ORDERING_TRACE_LIMIT = 24;
const SUPPORTING_REQUIREMENT_PLACEHOLDERS = new Map([
  ["statistics", "Statistics requirement"],
  ["cognate", "Mathematics cognate"],
  ["finance", "Finance requirement"]
]);
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

function termCapacity(slot, policyBundle) {
  const reserved = Math.max(0, Number(slot.reservedCourseUnits || 0));
  const capacity = termLoadCapacity(policyBundle, slot);
  return Math.max(0, Math.floor(capacity.activeCourseUnits - reserved));
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
  if (course.source === "historical-pattern") return 1;
  if (course.source === "catalog-statement") return 2;
  if (course.source === "recurring-rule-unconfirmed") return 3;
  if (course.source === "projected-offering" && course.course !== "ECO elective") return 4;
  if (course.source === "requirement-placeholder") return 5;
  return 6;
}

function projectedTermAllowed(code, slot, planningFlexibility) {
  if (slot.isSummer) return false;
  if (code === "ECO 461") return slot.termKey === "Winter";
  if (["ECO 213", "ECO 214"].includes(code)) return ["Fall", "Winter"].includes(slot.termKey);
  const supportPolicy = planningFlexibility?.policy?.supportingCoursePlacement;
  if ((supportPolicy?.courses || []).includes(code)) {
    return (supportPolicy.planningTerms || []).includes(String(slot.canonicalTerm || slot.termKey).toUpperCase());
  }
  if (["ECO 113", "ECO 114", "ECO 257", "ECO 321"].includes(code)) {
    return ["Fall", "Winter"].includes(slot.termKey);
  }
  return ["Fall", "Winter", "Spring", "May"].includes(slot.termKey);
}

function patternCourses(pattern = {}) {
  return Array.isArray(pattern.course) ? pattern.course : [pattern.course];
}

function namedProjectionSource(code, slot, policyBundle) {
  const canonicalTerm = String(slot.canonicalTerm || slot.termKey).toUpperCase().replace("SPRING", "MAY");
  const historical = policyBundle.indexes.historicalOfferingByCourse?.[code];
  if (historical?.activationStatus === "ACTIVE_OWNER_APPROVED"
      && historical.ownerApproval?.approved === true
      && Object.keys(historical.conditionalTermDistribution || {}).includes(canonicalTerm)) {
    return "historical-pattern";
  }
  const pattern = Object.values(policyBundle.indexes.offeringPatternsById || {}).find(candidate => (
    patternCourses(candidate).includes(code)
    && (candidate.approvedRecurringTerms || []).includes(canonicalTerm)
  ));
  if (pattern?.evidenceType === "OFFICIAL_CATALOG_STATEMENT") return "catalog-statement";
  if (pattern?.evidenceType === "DEPARTMENT_RECURRING") return "recurring-rule-unconfirmed";
  return null;
}

export function historicalOfferingProjectionEvidence(code, policyBundle) {
  const record = policyBundle?.indexes?.historicalOfferingByCourse?.[code];
  if (record?.activationStatus !== "ACTIVE_OWNER_APPROVED" || record.ownerApproval?.approved !== true) return null;
  const completeYears = record.completeYears || [];
  const yearsOffered = record.yearsOffered || [];
  const threshold = policyBundle?.provenance?.historicalOfferingContract?.method?.veryLowPriorityRule;
  const priority = threshold
    && completeYears.length >= threshold.minimumCompleteYears
    && yearsOffered.length <= threshold.maximumYearsOffered
    ? "VERY_LOW"
    : "NEUTRAL";
  return {
    priority,
    observationPeriod: record.observationPeriod,
    completeYearCount: completeYears.length,
    yearsOffered: [...yearsOffered],
    annualOfferingRate: record.annualOfferingRate,
    mostRecentOffering: record.mostRecentOffering,
    sourceRefs: record.sourceRefs,
    factualMessage: priority === "VERY_LOW"
      ? `${code} was observed in ${yearsOffered.length} of ${completeYears.length} complete academic years; its most recent observed offering was ${record.mostRecentOffering || "not recorded"}.`
      : null
  };
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

function studentCourseCodes(student, statuses) {
  return new Set(normalizeStudentCourses(student.courses)
    .filter(course => statuses.includes(course.status))
    .filter(course => course.code !== "ECO 461" || (
      course.status === "completed"
    ))
    .map(course => course.code));
}

function completedBeforePlanningCodes(student) {
  return studentCourseCodes(student, ["completed", "transfer"]);
}

function usedStudentCourseCodes(student) {
  return studentCourseCodes(student, ["completed", "transfer", "in_progress"]);
}

function existing100LevelElectives(mapping) {
  return (mapping.assignments || []).filter(item => (
    String(item.slotId || "").startsWith("eco-elective") && is100LevelEconomics(item.code)
  )).length;
}

function buildCoursePlacement({ requirement, code, slot, offering, title, source }) {
  const scheduleProvenance = ["verified-offering", "summer-last-resort"].includes(source)
    ? SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE
    : SCHEDULE_PROVENANCE.PLANNING_PROJECTION;
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
    scheduleProvenance,
    publicationStatus: scheduleProvenance,
    ...(scheduleProvenance === SCHEDULE_PROVENANCE.PLANNING_PROJECTION
      ? {availability: null, meeting: null}
      : {}),
    ...(source === "requirement-placeholder"
      ? { options: [...(requirement.options || [])] }
      : {}),
    offeringStatus: scheduleProvenance === SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE
      ? "verified"
      : source === "requirement-placeholder"
        ? "schedule_confirmation_required"
        : "planning_projection",
    ...(code === "ECO 461" ? { residency: "hanover" } : {})
  };
}

function namedProjectedPlacement({ requirement, code, slot, title, policyBundle }) {
  const source = namedProjectionSource(code, slot, policyBundle);
  const placement = buildCoursePlacement({ requirement, code, slot, title, source });
  const history = source === "historical-pattern"
    ? historicalOfferingProjectionEvidence(code, policyBundle)
    : null;
  return history ? {
    ...placement,
    historicalPriority: history.priority,
    historicalOfferingEvidence: history,
    ...(history.factualMessage ? { studentHistoricalOfferingMessage: history.factualMessage } : {})
  } : placement;
}

function authoritativeOffering(offering, slot, policyBundle) {
  return ["ALLOW", "CONDITIONAL", "PRELIMINARY", "REVIEW_REQUIRED"]
    .includes(scheduleOfferingDecision(offering, slot, policyBundle).status);
}

function requirementDomains({ requirement, requirements, slots, schedule, courseCatalog, courseTitles, existingAssignments, policyBundle, planningFlexibility }) {
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
          && authoritativeOffering(item, slot, policyBundle)
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
        for (const catalogCourse of courseCatalog.filter(course => (
          course.code?.startsWith("ECO ")
          && validElective(requirement, course.code, requirements, existingAssignments)
          && namedProjectionSource(course.code, slot, policyBundle)
        ))) {
          choices.push(namedProjectedPlacement({
            requirement,
            code: catalogCourse.code,
            slot,
            title: catalogCourse.title,
            policyBundle
          }));
        }
        choices.push({
          ...buildCoursePlacement({
            requirement,
            code: "ECO elective",
            slot,
            title: "Eligible ECO elective (future offering to verify)",
            source: "projected-offering"
          }),
          minimumLevel: 200
        });
      } else if (!slot.isSummer && ["May"].includes(slot.termKey)) {
        for (const catalogCourse of courseCatalog.filter(course => (
          course.code?.startsWith("ECO ")
          && validElective(requirement, course.code, requirements, existingAssignments)
          && namedProjectionSource(course.code, slot, policyBundle)
        ))) {
          choices.push(namedProjectedPlacement({
            requirement,
            code: catalogCourse.code,
            slot,
            title: catalogCourse.title,
            policyBundle
          }));
        }
        choices.push({
          ...buildCoursePlacement({
            requirement,
            code: "ECO elective",
            slot,
            title: "Eligible ECO elective (future offering to verify)",
            source: "projected-offering"
          }),
          minimumLevel: 200
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
        if (offering.verificationStatus !== "verified" || !authoritativeOffering(offering, slot, policyBundle)) continue;
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
      if (!isVerifiedYear && projectedTermAllowed(code, slot, planningFlexibility)) {
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
  const genericPlaceholder = SUPPORTING_REQUIREMENT_PLACEHOLDERS.get(requirement.id);
  const hasUsableVerifiedOption = options.some(code => slots.some(slot => (
    academicYear(slot.academicYear) === scheduleYear
    && scheduleOfferings(schedule, slot, code).some(offering => (
      offering.verificationStatus === "verified" && authoritativeOffering(offering, slot, policyBundle)
    ))
  )));
  if (genericPlaceholder && !hasUsableVerifiedOption) {
    for (const slot of slots.filter(candidate => (
      academicYear(candidate.academicYear) === scheduleYear
      && !candidate.isSummer
      && ["Fall", "Winter"].includes(candidate.termKey)
    ))) {
      choices.push(buildCoursePlacement({
        requirement,
        code: genericPlaceholder,
        slot,
        title: requirement.label,
        source: "requirement-placeholder"
      }));
    }
  }
  return choices;
}

function planTerms(slots, assignments, publishedAcademicYear) {
  return slots.map(slot => {
    const courses = [
      ...(slot.fixedCourses || []),
      ...assignments.filter(item => item.slotId === slot.id)
      .map(({ slotId: _slotId, ...course }) => course)
    ].sort((left, right) => left.course.localeCompare(right.course) || String(left.section).localeCompare(String(right.section)));
    const publicationStatus = academicYear(slot.academicYear) !== academicYear(publishedAcademicYear)
      || courses.some(course => course.scheduleProvenance === SCHEDULE_PROVENANCE.PLANNING_PROJECTION)
      ? SCHEDULE_PROVENANCE.PLANNING_PROJECTION
      : SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE;
    return {
    slotId: slot.id,
    term: slot.label,
    displayTerm: slot.displayTerm || slot.termKey,
    academicYear: slot.academicYear,
    termKey: slot.termKey,
    scheduleTerm: slot.scheduleTerm,
    yearIndex: slot.yearIndex,
    absoluteStandingIndex: slot.absoluteStandingIndex,
    seniorStandingBasis: slot.seniorStandingBasis,
    isCurrentTerm: Boolean(slot.isCurrentTerm),
    inProgressPrerequisitesAvailable: slot.inProgressPrerequisitesAvailable,
    publicationStatus,
    isSummer: slot.isSummer,
    courses
    };
  }).filter(term => !term.isSummer || term.courses.length);
}

function planCourseMetrics(plan, student, targetDistribution) {
  const terms = plan.terms || [];
  const courses = terms.flatMap(term => term.courses || []);
  const approvals = courses.flatMap(course => course.approvalRequired || []);
  const conditions = courses.map(course => availabilityRisk(course, student.planCreationDate));
  const maxEco = Math.max(0, ...terms.map(term => term.courses.filter(course => isEconomics(course.course)).length));
  const capstoneTerm = terms.find(term => term.courses.some(course => course.course === "ECO 461"));
  const regularLoads = terms.filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey)).map(term => term.courses.length);
  const yearCounts = new Map();
  for (const term of terms) yearCounts.set(term.yearIndex, (yearCounts.get(term.yearIndex) || 0) + plannerTrackedTermLoad(term));
  const distributionDistance = (targetDistribution?.targetYearCounts || []).reduce((sum, target, yearIndex) => (
    sum + Math.abs(target - (yearCounts.get(yearIndex) || 0))
  ), 0) + termShapePenalty(plan, targetDistribution);
  return {
    capstoneYearIndex: Number.isInteger(Number(capstoneTerm?.yearIndex))
      ? Number(capstoneTerm.yearIndex)
      : Number.MAX_SAFE_INTEGER,
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
  const keys = ["summer", "unverified", "approvals", "conditions", "distributionDistance", "capstoneYearIndex", "maxEco", "loadSquares", "imbalance"];
  for (const key of keys) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

function annualCoverageSatisfied(assignments, slots, distribution) {
  return (distribution?.targetYearCounts || []).every((target, yearIndex) => (
    target === 0 || (slots.some(slot => (
      slot.yearIndex === yearIndex && (slot.fixedTrackedCourseCount || 0) > 0
    )) || assignments.some(item => slots.find(slot => slot.id === item.slotId)?.yearIndex === yearIndex))
  ));
}

function preferredAnnualDistributionSatisfied(assignments, slots, distribution) {
  const targets = distribution?.targetYearCounts;
  if (!Array.isArray(targets) || !targets.length) return true;
  return targets.every((target, yearIndex) => (
    assignments.filter(item => slots.find(slot => slot.id === item.slotId)?.yearIndex === yearIndex).length
      + slots.filter(slot => slot.yearIndex === yearIndex).reduce((sum, slot) => sum + Number(slot.fixedTrackedCourseCount || 0), 0)
      === target
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
      if (option.course === "ECO 321" && course.requirementId !== "finance"
        && !allocationAssignments.some(item => item.slotId === "finance" && item.code === "BUSN 323")) return false;
      if (is100LevelEconomics(option.course)) {
        const otherSelected100 = selected.filter(item => (
          item.course !== course
          && String(item.course.requirementId || "").startsWith("eco-elective")
          && is100LevelEconomics(item.course.course)
        )).length;
        if (existing100LevelElectives(mapping) + otherSelected100 >= 1) return false;
      }
      const termIndex = plan.terms.findIndex(item => item.slotId === term.slotId);
      const beforeTerm = completedBeforePlanningCodes(student);
      if (term.inProgressPrerequisitesAvailable !== false) {
        for (const code of studentCourseCodes(student, ["in_progress"])) beforeTerm.add(code);
      }
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

// Edit one placement, never replan the student's other choices. All destination
// fields are rebuilt from current evidence; submitted source/section fields are
// not carried into a different term. The caller validates the complete result.
export function applyEconomicsPlanEdit({ plan, edit, student, mapping, schedule, prerequisites, courseCatalog, policyBundle }) {
  if (!["move", "option"].includes(edit?.type)) throw new Error("Required courses cannot be removed without a validated replacement.");
  const result = structuredClone(plan);
  const from = result.terms.find(term => (term.slotId || term.term) === edit.fromTermId);
  const index = from?.courses.findIndex(course => (course.requirementId || `${course.course}-${course.source || "course"}`) === edit.courseId) ?? -1;
  const original = from?.courses[index];
  if (!original || original.fixedInProgress) throw new Error("That course cannot be edited in this plan.");
  const destination = edit.type === "move"
    ? result.terms.find(term => (term.slotId || term.term) === edit.toTermId) : from;
  if (!destination) throw new Error("Choose a destination term in the selected plan.");
  const alternative = edit.type === "option" ? original.alternativeOptions?.find(option => option.id === edit.optionId) : null;
  if (edit.type === "option" && !alternative) throw new Error("That elective option is no longer available.");
  const code = alternative?.course || original.course;
  const requirement = mapping.requirements.find(item => item.id === original.requirementId);
  if (!requirement) throw new Error("The course requirement could not be resolved. Regenerate the plan.");
  from.courses.splice(index, 1);
  const slot = { ...destination, id: destination.slotId || destination.term };
  const exactTerm = policyBundle.indexes.offeringByTerm[preliminaryTermId(slot)];
  let placement;
  if (exactTerm) {
    const offering = selectConflictFreeOffering(schedule, slot, code, destination.courses);
    if (!offering) throw new Error(`${code} has no verified, conflict-free section in ${destination.term}. Choose another term.`);
    placement = buildCoursePlacement({ requirement, code, slot, offering, source: slot.isSummer ? "summer-last-resort" : "verified-offering" });
  } else if (original.source === "requirement-placeholder" && !alternative) {
    placement = buildCoursePlacement({ requirement, code, slot, title: original.title, source: "requirement-placeholder" });
  } else {
    if (slot.isSummer) throw new Error("A summer move needs verified offering evidence.");
    const source = namedProjectionSource(code, slot, policyBundle) || "projected-offering";
    placement = buildCoursePlacement({ requirement, code, slot, title: alternative?.title || original.title, source });
    if (code === "ECO elective") placement.minimumLevel = original.minimumLevel;
    if (source === "historical-pattern") {
      placement.historicalOfferingEvidence = historicalOfferingProjectionEvidence(code, policyBundle);
      placement.historicalPriority = placement.historicalOfferingEvidence?.priority;
      placement.studentHistoricalOfferingMessage = placement.historicalOfferingEvidence?.factualMessage;
    }
  }
  destination.courses.splice(destination === from ? index : destination.courses.length, 0, placement);
  for (const term of result.terms) for (const course of term.courses) delete course.approvalRequired;
  const approvalAssessment = evaluatePlanPrerequisites({
    plan: result, student, prerequisites, requireRecordedApprovals: false, policyBundle
  });
  decorateApprovals(result, approvalAssessment.requiredApprovals);
  // Recompute offered replacements against the edited schedule and history.
  for (const term of result.terms) for (const course of term.courses) {
    delete course.alternativeOptions;
    delete course.selectedOptionId;
  }
  const slots = result.terms.map(term => ({ ...term, id: term.slotId || term.term }));
  const domains = new Map(mapping.requirements.map(requirement => [requirement.id, requirementDomains({
    requirement, requirements: mapping.requirements, slots,
    schedule: normalizeEconomicsSchedule(schedule), courseCatalog,
    courseTitles: new Map(courseCatalog.map(course => [course.code, course.title])),
    existingAssignments: mapping.assignments || [], policyBundle,
    planningFlexibility: loadPlanningFlexibilityPolicy()
  })]));
  addElectiveAlternatives(result, domains, student, mapping, prerequisites);
  return result;
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
  planVariant = null,
  allowConcurrentMath = false,
  requireAnnualCoverage = true,
  requireTargetDistribution = false,
  nodeLimit = TERM_SOLVER_NODE_LIMIT,
  solutionBudget = TERM_SOLVER_SOLUTION_BUDGET,
  excludedSolutionSignatures = [],
  requirementPriority = PLANNING_PRIORITY,
  prioritizeEarlyRequirements = false,
  searchStrategy = "normal",
  policyBundle = runtimePolicyBundle()
}) {
  const planningFlexibility = loadPlanningFlexibilityPolicy();
  const normalizedSchedule = normalizeEconomicsSchedule(schedule);
  const unresolvedIds = new Set((mapping?.projectedAfterInProgress?.optimistic?.unresolved
    || mapping?.optimistic?.unresolved
    || [])
    .map(item => item.requirementId));
  const requirements = (mapping?.requirements || []).filter(item => unresolvedIds.has(item.id));
  const slotById = new Map(slots.map(slot => [slot.id, slot]));
  const slotIndexById = new Map(slots.map((slot, index) => [slot.id, index]));
  const completedCodes = completedBeforePlanningCodes(student);
  const inProgressCodes = studentCourseCodes(student, ["in_progress"]);
  const selectedCodes = usedStudentCourseCodes(student);
  const courseTitles = new Map(courseCatalog.map(course => [course.code, course.title]));
  const existingAssignments = mapping?.assignments || [];
  const firstPlanningYear = Math.min(...slots.map(slot => Number(slot.yearIndex) || 0));
  const domains = new Map(requirements.map(requirement => [
    requirement.id,
    requirementDomains({
      requirement,
      requirements: mapping?.requirements || [],
      slots,
      schedule: normalizedSchedule,
      mapping,
      courseCatalog,
      courseTitles,
      existingAssignments,
      policyBundle,
      planningFlexibility
    })
      .sort((left, right) => {
        if (planVariant?.rankingPreferences?.foundationSequencingIsSoft && requirement.id === "cognate") {
          const leftMathRank = left.course === "MAT 113" ? 0 : left.course === "MAT 121" ? 1 : 2;
          const rightMathRank = right.course === "MAT 113" ? 0 : right.course === "MAT 121" ? 1 : 2;
          if (leftMathRank !== rightMathRank) return leftMathRank - rightMathRank;
        }
        if (requirement.id === "statistics") {
          const leftSlot = slotById.get(left.slotId);
          const rightSlot = slotById.get(right.slotId);
          const leftVerifiedFirstYear = left.source === "verified-offering" && leftSlot?.yearIndex === firstPlanningYear ? 0 : 1;
          const rightVerifiedFirstYear = right.source === "verified-offering" && rightSlot?.yearIndex === firstPlanningYear ? 0 : 1;
          const availabilityRank = option => option.availability?.status === "open" ? 0
            : option.availability?.status === "waitlisted" ? 1
              : option.availability?.status === "unknown" ? 2 : 3;
          const statisticsDifference = leftVerifiedFirstYear - rightVerifiedFirstYear
            || availabilityRank(left) - availabilityRank(right);
          if (statisticsDifference) return statisticsDifference;
        }
        return sourceRank(left) - sourceRank(right)
        || (slotIndexById.get(left.slotId) ?? Number.POSITIVE_INFINITY) - (slotIndexById.get(right.slotId) ?? Number.POSITIVE_INFINITY)
        || left.course.localeCompare(right.course)
        || String(left.section).localeCompare(String(right.section));
      })
  ]));
  const earliestCapstoneSlot = (domains.get("eco-461") || [])
    .map(choice => slotById.get(choice.slotId))
    .filter(Boolean)
    .sort((left, right) => left.yearIndex - right.yearIndex || (slotIndexById.get(left.id) || 0) - (slotIndexById.get(right.id) || 0))[0] || null;
  const totalCapacity = slots.reduce((sum, slot) => sum + Number(slot.remainingPlannerCapacity ?? Math.max(
    0,
    termCapacity(slot, policyBundle) - Number(slot.fixedCourseCount || 0)
  )), 0);
  const minimumEconomicsCourses = requirements.filter(requirement => (
    requirement.kind === "elective"
    || (requirement.options || []).every(code => isEconomics(code))
  )).length;
  const economicsCapacity = slots.reduce((sum, slot) => {
    if (slot.newCoursesAllowed === false) return sum;
    const totalRemaining = Number(slot.remainingPlannerCapacity ?? Math.max(0, termCapacity(slot, policyBundle) - Number(slot.fixedCourseCount || 0)));
    const economicsLimit = ["Fall", "Winter"].includes(slot.termKey) ? termCapacity(slot, policyBundle) : 1;
    return sum + Math.max(0, Math.min(totalRemaining, economicsLimit - Number(slot.fixedEconomicsCourseCount || 0)));
  }, 0);
  if (requirements.length > totalCapacity || minimumEconomicsCourses > economicsCapacity) {
    return {
      solution: null,
      solutions: [],
      metrics: null,
      domains,
      search: {
        complete: true,
        nodesVisited: 0,
        limit: nodeLimit,
        solutionLimit: Math.max(1, Number(solutionBudget) || TERM_SOLVER_SOLUTION_BUDGET),
        completionAttempts: 0,
        prerequisiteFailures: 0,
        deadEnds: 0,
        deadEndsByRequirement: {},
        prerequisiteFailureReasons: {},
        firstSolutionNode: null,
        validSolutionCount: 0,
        completeSchedulesExamined: 0,
        prerequisiteValidSchedules: 0,
        exactDuplicatesRemoved: 0,
        retainedSchedules: 0,
        orderingTrace: [],
        terminationReason: "COUNT_CAPACITY"
      },
      failure: "COUNT_CAPACITY"
    };
  }
  const orderedRequirements = [...requirements].sort((left, right) => (
    (requirementPriority.get(left.id) || 50) - (requirementPriority.get(right.id) || 50)
    || (domains.get(left.id)?.length || 0) - (domains.get(right.id)?.length || 0)
    || left.id.localeCompare(right.id)
  ));

  let nodesVisited = 0;
  let exhausted = false;
  let terminationReason = null;
  let firstSolutionNode = null;
  let completionAttempts = 0;
  let validSolutionCount = 0;
  let exactDuplicatesRemoved = 0;
  let prerequisiteFailures = 0;
  let deadEnds = 0;
  const deadEndsByRequirement = new Map();
  const prerequisiteFailureReasons = new Map();
  const solutions = [];
  const solutionSignatures = new Set();
  const excludedSignatures = new Set(excludedSolutionSignatures);
  const orderingTrace = [];
  const assigned = [];
  const usedCodes = new Set([...selectedCodes].map(code => canonicalScheduleCode(normalizedSchedule, code)));
  const termCourses = new Map(slots.map(slot => [slot.id, [...(slot.fixedCourses || [])]]));
  const memo = new Set();
  const starting100LevelCount = existing100LevelElectives(mapping);
  const searchStartedAt = typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
  function legal(choice, requirement) {
    const slot = slotById.get(choice.slotId);
    const inTerm = termCourses.get(choice.slotId);
    if (!slot || slot.newCoursesAllowed === false || inTerm.length >= termCapacity(slot, policyBundle)) return false;
    const capstoneStillPending = requirement.id !== "eco-461"
      && earliestCapstoneSlot?.id === choice.slotId
      && termCapacity(earliestCapstoneSlot, policyBundle) > 0
      && !assigned.some(item => item.requirementId === "eco-461");
    if (capstoneStillPending && inTerm.length >= termCapacity(earliestCapstoneSlot, policyBundle) - 1) return false;
    if (requireTargetDistribution && Array.isArray(distribution?.targetYearCounts)) {
      const target = distribution.targetYearCounts[slot.yearIndex] ?? 0;
      const assignedInYear = assigned.filter(item => (
        slotById.get(item.slotId)?.yearIndex === slot.yearIndex
      )).length + slots.filter(item => item.yearIndex === slot.yearIndex)
        .reduce((sum, item) => sum + Number(item.fixedTrackedCourseCount || 0), 0);
      const capstoneYearStillPending = requirement.id !== "eco-461"
        && earliestCapstoneSlot?.yearIndex === slot.yearIndex
        && termCapacity(earliestCapstoneSlot, policyBundle) > 0
        && !assigned.some(item => item.requirementId === "eco-461");
      const availableTarget = target - (capstoneYearStillPending ? 1 : 0);
      if (assignedInYear >= availableTarget) return false;
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
    if (["Fall", "Winter"].includes(slot.termKey) && ecoCount > termCapacity(slot, policyBundle)) return false;
    if (["ECO 213", "ECO 214"].includes(choice.course) && choice.source === "projected-offering") {
      const counterpart = choice.course === "ECO 213" ? "ECO 214" : "ECO 213";
      if (inTerm.some(course => course.course === counterpart && course.source === "projected-offering")) return false;
    }
    const allocationAssignments = [
      ...existingAssignments,
      ...assigned.map(item => ({ slotId: item.requirementId, code: item.course }))
    ];
    if (choice.course === "ECO 321" && requirement.id !== "finance") {
      const companionAssigned = allocationAssignments.some(item => item.slotId === "finance" && item.code === "BUSN 323");
      const companionPending = requirements.some(item => (
        item.id === "finance"
        && !assigned.some(assignment => assignment.requirementId === "finance")
        && (domains.get("finance") || []).some(option => option.course === "BUSN 323")
      ));
      if (!companionAssigned && !companionPending) return false;
    }
    if (requirement.kind === "elective") {
      const previousElective = [...assigned].reverse().find(item => String(item.requirementId || "").startsWith("eco-elective"));
      if (previousElective) {
        const previousKey = `${String(slotIndexById.get(previousElective.slotId) ?? -1).padStart(3, "0")}:${previousElective.course}:${previousElective.section || ""}`;
        const choiceKey = `${String(slotIndexById.get(choice.slotId) ?? -1).padStart(3, "0")}:${choice.course}:${choice.section || ""}`;
        if (choiceKey < previousKey) return false;
      }
    }
    if (choice.course !== "ECO elective") {
      const choiceSlotIndex = slotIndexById.get(choice.slotId) ?? -1;
      const beforeTerm = new Set(completedCodes);
      if (slot.inProgressPrerequisitesAvailable !== false) {
        for (const code of inProgressCodes) beforeTerm.add(code);
      }
      const sameTerm = new Set([choice.course]);
      for (const [termSlotId, courses] of termCourses) {
        const itemSlotIndex = slotIndexById.get(termSlotId) ?? -1;
        for (const item of courses) {
          if (itemSlotIndex < choiceSlotIndex) beforeTerm.add(item.course);
          if (termSlotId === choice.slotId) sameTerm.add(item.course);
        }
      }
      const prerequisiteAssessment = assessCoursePrerequisites({
        code: choice.course,
        term: slot,
        beforeTerm,
        sameTerm,
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
      if (requireAnnualCoverage && !annualCoverageSatisfied(assigned, slots, distribution)) return;
      if (requireTargetDistribution && !preferredAnnualDistributionSatisfied(assigned, slots, distribution)) return;
      const plan = { terms: planTerms(slots, assigned, normalizedSchedule.academicYear) };
      const prereq = evaluatePlanPrerequisites({ plan, student, prerequisites, context, requireRecordedApprovals: false });
      if (!prereq.valid) {
        prerequisiteFailures += 1;
        const reason = prereq.errors[0] || "unknown";
        prerequisiteFailureReasons.set(reason, (prerequisiteFailureReasons.get(reason) || 0) + 1);
        return;
      }
      if (!allowConcurrentMath && prereq.requiredApprovals.some(item => item.type === "instructor")) return;
      decorateApprovals(plan, prereq.requiredApprovals);
      const metrics = planCourseMetrics(plan, student, distribution);
      const signature = JSON.stringify(plan.terms.map(term => [term.slotId, term.courses.map(course => [course.requirementId, course.course, course.section])]));
      if (excludedSignatures.has(signature) || solutionSignatures.has(signature)) {
        exactDuplicatesRemoved += 1;
      } else {
        validSolutionCount += 1;
        solutionSignatures.add(signature);
        if (firstSolutionNode === null) firstSolutionNode = nodesVisited;
        const foundAtMs = (typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now()) - searchStartedAt;
        solutions.push({ plan, metrics, signature, prereq, foundAtNode: nodesVisited, foundAtMs });
      }
      if (validSolutionCount >= Math.max(1, Number(solutionBudget) || TERM_SOLVER_SOLUTION_BUDGET)) {
        exhausted = true;
        terminationReason = "SOLUTION_BUDGET";
      }
      return;
    }

    const assignedRequirementIds = new Set(assigned.map(item => item.requirementId));
    const pendingRequirements = orderedRequirements.filter(item => !assignedRequirementIds.has(item.id));
    const readyRequirements = pendingRequirements.map(requirement => ({
      requirement,
      legalChoices: (domains.get(requirement.id) || []).filter(choice => legal(choice, requirement))
    })).filter(item => item.legalChoices.length).sort((left, right) => {
      const leftSlotCount = new Set(left.legalChoices.map(choice => choice.slotId)).size;
      const rightSlotCount = new Set(right.legalChoices.map(choice => choice.slotId)).size;
      if (searchStrategy === "rescue") {
        return left.legalChoices.length - right.legalChoices.length
          || leftSlotCount - rightSlotCount
          || (requirementPriority.get(left.requirement.id) || 50) - (requirementPriority.get(right.requirement.id) || 50)
          || left.requirement.id.localeCompare(right.requirement.id);
      }
      return (requirementPriority.get(left.requirement.id) || 50) - (requirementPriority.get(right.requirement.id) || 50)
        || left.legalChoices.length - right.legalChoices.length
        || leftSlotCount - rightSlotCount
        || left.requirement.id.localeCompare(right.requirement.id);
    });
    if (!readyRequirements.length) {
      const blocked = pendingRequirements[0];
      deadEnds += 1;
      if (blocked) deadEndsByRequirement.set(blocked.id, (deadEndsByRequirement.get(blocked.id) || 0) + 1);
      return;
    }
    const requirement = readyRequirements[0].requirement;
    const choices = readyRequirements[0].legalChoices;
    if (orderingTrace.length < ORDERING_TRACE_LIMIT) {
      const eligibleTerms = new Set(choices.map(choice => choice.slotId));
      const eligibleSections = new Set(choices.map(choice => `${choice.course}:${choice.section || "UNSECTIONED"}:${choice.slotId}`));
      orderingTrace.push({
        depth: assigned.length,
        requirementId: requirement.id,
        dependencyPriority: requirementPriority.get(requirement.id) || 50,
        deadlineBound: requirement.id === "eco-461",
        fixedTerm: eligibleTerms.size === 1,
        legalPlacementCount: choices.length,
        eligibleTermCount: eligibleTerms.size,
        eligibleSectionCount: eligibleSections.size,
        sourceTypes: [...new Set(choices.map(choice => choice.source))].sort(),
        selectedOrderingRank: 1,
        candidateOrdering: readyRequirements.slice(0, 8).map((candidate, orderingIndex) => ({
          requirementId: candidate.requirement.id,
          dependencyPriority: requirementPriority.get(candidate.requirement.id) || 50,
          legalPlacementCount: candidate.legalChoices.length,
          eligibleTermCount: new Set(candidate.legalChoices.map(choice => choice.slotId)).size,
          orderingRank: orderingIndex + 1
        })),
        searchStrategy
      });
    }
    const stateKey = `${assigned.length}|${assigned.map(item => `${item.requirementId}:${item.course}:${item.section || ""}:${item.slotId}`).sort().join("|")}`;
    if (memo.has(stateKey)) return;
    memo.add(stateKey);
    const assignedYearCounts = new Map();
    for (const slot of slots) {
      assignedYearCounts.set(slot.yearIndex, (assignedYearCounts.get(slot.yearIndex) || 0) + Number(slot.fixedTrackedCourseCount || 0));
    }
    for (const item of assigned) {
      const yearIndex = slotById.get(item.slotId)?.yearIndex;
      assignedYearCounts.set(yearIndex, (assignedYearCounts.get(yearIndex) || 0) + 1);
    }
    const applyExploreTermShapeSearchOrder = distribution?.strategy === "explore-first";
    const choiceTermShapeTierRank = choice => {
      if (!applyExploreTermShapeSearchOrder) return 0;
      const slot = slotById.get(choice.slotId);
      if (slot?.yearIndex !== 0 || distribution?.targetYearCounts?.[0] !== 2) return 0;
      const model = distribution?.preferredTermShapeTiersByYear?.[slot?.yearIndex];
      if (!model) return 0;
      const loads = model.slotIds.map(slotId => (
        termCourses.get(slotId).filter(plannerTrackedCourse).length + (slotId === choice.slotId ? 1 : 0)
      ));
      return partialTermShapeTierRank(loads, model);
    };
    const orderedChoices = [...choices].sort((left, right) => {
      const leftSlot = slotById.get(left.slotId);
      const rightSlot = slotById.get(right.slotId);
      const preliminaryRank = choice => preliminaryEvidenceFor(policyBundle, preliminaryTermId(slotById.get(choice.slotId)), choice.course) ? 0 : 1;
      if (requirement.id === "eco-461") {
        return (leftSlot?.yearIndex || 0) - (rightSlot?.yearIndex || 0)
          || sourceRank(left) - sourceRank(right)
          || preliminaryRank(left) - preliminaryRank(right)
          || choices.indexOf(left) - choices.indexOf(right);
      }
      const leftYearOpen = (assignedYearCounts.get(leftSlot?.yearIndex) || 0) < (distribution?.targetYearCounts?.[leftSlot?.yearIndex] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const rightYearOpen = (assignedYearCounts.get(rightSlot?.yearIndex) || 0) < (distribution?.targetYearCounts?.[rightSlot?.yearIndex] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const leftTermOpen = termCourses.get(left.slotId).filter(plannerTrackedCourse).length < (distribution?.termTargetCeilings?.[left.slotId] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const rightTermOpen = termCourses.get(right.slotId).filter(plannerTrackedCourse).length < (distribution?.termTargetCeilings?.[right.slotId] ?? Number.POSITIVE_INFINITY) ? 0 : 1;
      const leftTermShapeTier = choiceTermShapeTierRank(left);
      const rightTermShapeTier = choiceTermShapeTierRank(right);
      const leftSummer = leftSlot?.isSummer ? 1 : 0;
      const rightSummer = rightSlot?.isSummer ? 1 : 0;
      const earlySequenceRequirement = prioritizeEarlyRequirements
        && (requirementPriority.get(requirement.id) || 50) <= 3;
      if (earlySequenceRequirement) {
        const pendingEarlyConflictPenalty = choice => orderedRequirements
          .filter(pending => pending.id !== requirement.id && !assignedRequirementIds.has(pending.id))
          .filter(pending => (requirementPriority.get(pending.id) || 50) <= 3)
          .reduce((penalty, pending) => {
            const sameTermOptions = (domains.get(pending.id) || []).filter(option => (
              option.slotId === choice.slotId && option.course !== choice.course
            ));
            return penalty + (sameTermOptions.length && sameTermOptions.every(option => meetingsConflict(choice, option)) ? 1 : 0);
          }, 0);
        return leftSummer - rightSummer
          || leftYearOpen - rightYearOpen
          || leftTermShapeTier - rightTermShapeTier
          || (applyExploreTermShapeSearchOrder ? leftTermOpen - rightTermOpen : 0)
          || (leftSlot?.yearIndex || 0) - (rightSlot?.yearIndex || 0)
          || sourceRank(left) - sourceRank(right)
          || preliminaryRank(left) - preliminaryRank(right)
          || pendingEarlyConflictPenalty(left) - pendingEarlyConflictPenalty(right)
          || choices.indexOf(left) - choices.indexOf(right);
      }
      return leftYearOpen - rightYearOpen
        || leftTermShapeTier - rightTermShapeTier
        || leftTermOpen - rightTermOpen
        || leftSummer - rightSummer
        || sourceRank(left) - sourceRank(right)
        || preliminaryRank(left) - preliminaryRank(right)
        || (searchStrategy === "rescue"
          ? choices.indexOf(right) - choices.indexOf(left)
          : choices.indexOf(left) - choices.indexOf(right));
    });
    let legalChoiceCount = 0;
    for (const choice of orderedChoices) {
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
  solutions.sort((left, right) => (
    compareMetrics(left.metrics, right.metrics)
    || left.signature.localeCompare(right.signature)
  ));
  for (const solution of solutions) {
    addElectiveAlternatives(solution.plan, domains, student, mapping, prerequisites);
  }
  const best = solutions[0] || null;
  return {
    solution: best?.plan || null,
    solutions,
    metrics: best?.metrics || null,
    domains,
    search: {
      complete: !exhausted,
      nodesVisited,
      limit: nodeLimit,
      solutionLimit: Math.max(1, Number(solutionBudget) || TERM_SOLVER_SOLUTION_BUDGET),
      completionAttempts,
      prerequisiteFailures,
      deadEnds,
      deadEndsByRequirement: Object.fromEntries(deadEndsByRequirement),
      prerequisiteFailureReasons: Object.fromEntries([...prerequisiteFailureReasons].slice(0, 10)),
      firstSolutionNode,
      validSolutionCount,
      completeSchedulesExamined: completionAttempts,
      prerequisiteValidSchedules: validSolutionCount,
      exactDuplicatesRemoved,
      retainedSchedules: solutions.length,
      orderingTrace,
      terminationReason,
      searchStrategy,
      incumbentPreserved: Boolean(best && exhausted)
    },
    failure: exhausted && !best ? "SEARCH_INCOMPLETE" : best ? null : "NO_COMPLETE_ASSIGNMENT"
  };
}
