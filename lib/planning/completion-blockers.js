import { buildPlanningSlots } from "./horizon.js";
import { canonicalTermId, courseTermEligibility, evaluateCoursePlacement, evaluateOffering } from "../decision-engine/placement.js";
import { canonicalAllocationCourse } from "../decision-engine/requirements.js";
import { mayAllocateCourseToRequirement } from "./requirementAllocation.js";
import { termLoadCapacity, termLoadEvidenceForSlot, policyMessage } from "../policy/term-load.js";
import { scheduleCoverageForCourse } from "../policy/schedule-coverage.js";
import { pluralize, studentTermLabel } from "./student-language.js";

function remainingOptions(mapping, student, bundle) {
  const unresolved = new Set((mapping?.projectedAfterInProgress?.optimistic?.unresolved || mapping?.optimistic?.unresolved || []).map(item => item.requirementId));
  const requirements = (mapping?.requirements || []).filter(item => unresolved.has(item.id));
  const used = new Set((student.courses || []).filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => canonicalAllocationCourse(course.code, bundle)));
  return Object.keys(bundle.indexes.coursesByCode).filter(code => !used.has(canonicalAllocationCourse(code, bundle))
    && (!mapping || requirements.some(requirement => mayAllocateCourseToRequirement({requirement, code, assignments: mapping.assignments || [], requirements, policyBundle: bundle}))));
}

export function hasCompleteScheduleCoverage(context, bundle, {mapping = null, student = {}} = {}) {
  if (!context || !bundle) return false;
  const slots = buildPlanningSlots(context).filter(slot => !slot.isSummer && slot.newCoursesAllowed !== false);
  const options = remainingOptions(mapping, student, bundle);
  return slots.length > 0 && options.length > 0 && slots.every(slot => options.every(code => (
    !courseTermEligibility({course: code}, slot, bundle).allowed
    || scheduleCoverageForCourse(bundle.indexes.offeringByTerm[canonicalTermId(slot)], canonicalAllocationCourse(code, bundle)).coverage === "COMPLETE"
  )));
}

// An exact required course is an independent blocker only when its sole
// catalog option is absent from every still-available term under scoped,
// complete evidence. Unknown offerings and overridable May exclusions do not
// count as proof without that term's complete course coverage.
export function independentlyProvenRequiredOffering(mapping, context, bundle, student = {}) {
  if (!mapping || !context || !bundle) return null;
  const slots = buildPlanningSlots(context).filter(slot => !slot.isSummer && slot.newCoursesAllowed !== false);
  if (!slots.length) return null;
  const unresolved = new Set((mapping.projectedAfterInProgress?.optimistic?.unresolved || mapping.optimistic?.unresolved || [])
    .map(item => item.requirementId));
  for (const requirement of mapping.requirements || []) {
    if (!unresolved.has(requirement.id) || requirement.kind !== "exact" || requirement.options?.length !== 1) continue;
    const course = canonicalAllocationCourse(requirement.options[0], bundle);
    const rule = bundle.rules.find(item => item.status === "ACTIVE" && item.ruleType === "requirementDefinition"
      && item.scope.requirements.includes(requirement.id) && item.effect.kind === "exact"
      && item.effect.options.length === 1 && canonicalAllocationCourse(item.effect.options[0], bundle) === course);
    if (!rule || (student.courses || []).some(item => canonicalAllocationCourse(item.code, bundle) === course
      && item.status !== "not_taken")) continue;
    const unresolvedAlternative = (student.courses || []).some(item =>
      item.equivalencyCode && canonicalAllocationCourse(item.equivalencyCode, bundle) === course)
      || (student.evidenceFacts || []).some(fact =>
        ["WAIVER", "SUBSTITUTION", "COURSE_EQUIVALENCY", "REQUIREMENT_CREDIT_EQUIVALENCY"].includes(fact.factType)
        && (fact.affectedRequirement === requirement.id
          || canonicalAllocationCourse(fact.affectedCourse, bundle) === course
          || (!fact.affectedRequirement && !fact.affectedCourse)));
    if (unresolvedAlternative) continue;
    const termEvidence = slots.map(slot => {
      const decision = evaluateOffering({ course, source: "verified-offering" }, slot, bundle.indexes.offeringByTerm, bundle);
      const coverage = scheduleCoverageForCourse(bundle.indexes.offeringByTerm[canonicalTermId(slot)], course);
      if (coverage.coverage !== "COMPLETE" || !coverage.sourceRefs?.length
        || !["NOT_OFFERED_IN_COMPLETE_SCHEDULE", "COURSE_NOT_SUPPORTED_IN_MAY"].includes(decision.reasonCode)) return null;
      return {
        term: slot.label, termId: canonicalTermId(slot), reasonCode: decision.reasonCode,
        ruleIds: decision.ruleIds, sourceRefs: [...new Set([...(decision.sourceRefs || []), ...coverage.sourceRefs])]
      };
    });
    if (termEvidence.some(item => !item)) continue;
    return {
      code: "REQUIRED_COURSE_NO_ELIGIBLE_OFFERING",
      course,
      requirementId: requirement.id,
      ruleIds: [...new Set([rule.ruleId, ...termEvidence.flatMap(term => term.ruleIds)])],
      sourceRefs: [...new Set(["OWNER-N1-INDEPENDENT-INFEASIBILITY-2026-11-23#N1",
        ...rule.sourceRefs, ...termEvidence.flatMap(term => term.sourceRefs)])],
      termEvidence,
      message: policyMessage(bundle, "infeasibility.requiredOffering", {
        course, target: studentTermLabel(context.expectedGraduationTerm)
      })
    };
  }
  return null;
}

// A normal-capacity search does not prove impossibility under a yet-unresolved
// overload. This records uncertainty only; the solver retains normal capacity.
export function pendingOverloadEvidence(context, bundle, student = {}, mapping = null) {
  if (!context || !bundle) return [];
  const options = remainingOptions(mapping, student, bundle);
  return buildPlanningSlots(context).filter(slot => !slot.isSummer && slot.newCoursesAllowed !== false).flatMap(slot => {
    const evidence = termLoadEvidenceForSlot(student, slot);
    const capacity = termLoadCapacity(bundle, {...slot, termLoadEvidence: evidence});
    if (capacity.overloadApproved || evidence?.advisorApproval === "NOT_APPROVED"
      || evidence?.academicProbationStatus === "ON_ACADEMIC_PROBATION"
      || capacity.conditionalMaximumCourseUnits <= capacity.normalCourseUnits) return [];
    const units = options.filter(code => courseTermEligibility({course: code}, slot, bundle).allowed)
      .map(code => Number(bundle.indexes.coursesByCode[code]?.units || 1));
    if (!units.length) return [];
    const minimumUnits = Math.min(...units);
    const reserved = Number(student.reservedCourseUnits?.[slot.id] ?? student.reservedCourseUnits?.[slot.label] ?? 0);
    if (Math.floor(Math.max(0, capacity.normalCourseUnits - reserved) / minimumUnits)
      === Math.floor(Math.max(0, capacity.conditionalMaximumCourseUnits - reserved) / minimumUnits)) return [];
    return [{termId: slot.id, term: slot.label, ruleIds: [capacity.rule.ruleId], sourceRefs: capacity.rule.sourceRefs}];
  });
}

// Explain a proven chronology obstruction, without treating missing offerings or
// an unfinished search as proof. Requirement meaning comes from the pinned rules.
export function statisticsTimingBlockers(mapping, context, bundle) {
  if (!mapping || !context || !bundle) return [];
  const unresolved = mapping.projectedAfterInProgress?.optimistic?.unresolved || mapping.optimistic?.unresolved || [];
  if (!["statistics", "eco-461"].every(id => unresolved.some(item => item.requirementId === id))) return [];
  const priorRule = bundle.indexes.byRuleId["PREREQ-ECO-461"];
  const termRule = bundle.indexes.byRuleId["CAPSTONE-WINTER-ONLY"];
  if (priorRule?.effect.statisticsMustBePrior !== true || !termRule) return [];
  const slots = buildPlanningSlots(context).filter(slot => slot.newCoursesAllowed !== false);
  const capstoneSlots = slots.filter(slot => termRule.effect.allowedCanonicalTerms.includes(slot.canonicalTerm));
  if (capstoneSlots.length !== 1 || slots.indexOf(capstoneSlots[0]) !== 0) return [];
  return [{
    code: "STATISTICS_BEFORE_CAPSTONE_NO_EARLIER_TERM",
    course: priorRule.condition.course,
    missingOptions: priorRule.effect.oneOfGroups[0],
    ruleIds: [priorRule.ruleId, termRule.ruleId],
    sourceRefs: [...new Set([...priorRule.sourceRefs, ...termRule.sourceRefs])],
    planningStart: slots[0].label,
    graduationTarget: context.expectedGraduationTerm,
    message: `${priorRule.condition.course} is offered only in Winter. To finish by ${studentTermLabel(context.expectedGraduationTerm)}, you must take it in ${capstoneSlots[0].label}. Statistics (${priorRule.effect.oneOfGroups[0].join(" or ")}) must be done first. Your answers do not show statistics completed. There is no earlier term left. Check your statistics answer or ask your advisor about a later graduation date.`
  }];
}

export function seniorStandingTimingBlockers(mapping, context, bundle) {
  if (!mapping || !context || !bundle) return [];
  const unresolved = mapping.projectedAfterInProgress?.optimistic?.unresolved || mapping.optimistic?.unresolved || [];
  if (!unresolved.some(item => item.requirementId === "eco-461")) return [];
  const winterRule = bundle.indexes.byRuleId["CAPSTONE-WINTER-ONLY"];
  const standingRule = bundle.indexes.byRuleId["CAPSTONE-SENIOR-STANDING"];
  if (!winterRule || !standingRule) return [];
  const winterSlots = buildPlanningSlots(context).filter(slot => slot.newCoursesAllowed !== false
    && winterRule.effect.allowedCanonicalTerms.includes(slot.canonicalTerm));
  if (!winterSlots.length || !winterSlots.every(slot => {
    const decision = evaluateCoursePlacement({ course: "ECO 461", residency: "hanover" }, slot, context, bundle);
    return decision.status === "BLOCK" && decision.ruleIds.includes(standingRule.ruleId);
  })) return [];
  return [{
    code: "CAPSTONE_SENIOR_STANDING_NO_ELIGIBLE_WINTER",
    course: "ECO 461",
    ruleIds: [standingRule.ruleId, winterRule.ruleId],
    sourceRefs: [...new Set([...standingRule.sourceRefs, ...winterRule.sourceRefs])],
    graduationTarget: context.expectedGraduationTerm,
    message: policyMessage(bundle, "infeasibility.capstone.seniorStanding")
  }];
}

function overlaps(left, right) {
  return left.meeting?.days?.some(day => right.meeting?.days?.includes(day))
    && left.meeting.startTime < right.meeting.endTime && right.meeting.startTime < left.meeting.endTime;
}

export function unpublishedElectiveNeed({ mapping, planningContext, policyBundle, student = {} } = {}) {
  if (!mapping || !planningContext || !policyBundle) return [];
  const pending = new Set((mapping.projectedAfterInProgress?.optimistic?.unresolved || mapping.optimistic?.unresolved || [])
    .map(item => item.requirementId));
  const electives = mapping.requirements.filter(item => pending.has(item.id) && item.kind === "elective");
  const slots = buildPlanningSlots(planningContext).filter(slot => !slot.isSummer && slot.newCoursesAllowed !== false);
  const rule = policyBundle.indexes.byRuleId["PLANNING-UNPUBLISHED-ELECTIVE-LIMIT"];
  let unpublished = false;
  const available = slots.reduce((total, slot) => {
    const units = Math.max(0, termLoadCapacity(policyBundle, slot).activeCourseUnits - Number(slot.reservedCourseUnits || 0));
    const exact = policyBundle.indexes.offeringByTerm[canonicalTermId(slot)];
    if (!exact) { unpublished = true; return total + Math.min(rule.effect.maximumElectives, Math.floor(units)); }
    const options = new Set(remainingOptions(mapping, student, policyBundle));
    const codes = new Set(exact.sections.filter(section => options.has(section.course)
      && electives.some(requirement => mayAllocateCourseToRequirement({ requirement, code: section.course,
        assignments: mapping.assignments || [], requirements: mapping.requirements, policyBundle }))).map(section => section.course));
    return total + Math.min(codes.size, Math.floor(units));
  }, 0);
  const missing = electives.length - available;
  if (!unpublished || missing <= 0) return [];
  return [{ code: "EXTRA_ELECTIVE_OFFERING_REVIEW_REQUIRED", remainingElectives: electives.length,
    standardElectiveCapacity: available, unmetElectives: missing,
    ruleIds: [rule.ruleId], sourceRefs: rule.sourceRefs,
    message: `${missing} additional Economics elective${missing === 1 ? " is" : "s are"} needed beyond the standard term limit to finish by ${planningContext.expectedGraduationTerm}. ${policyBundle.planningAdvice.display.adjunct}` }];
}

// This is an upper-bound proof: prerequisites cannot add another offered course.
// It is deliberately limited to a complete Winter/May horizon and a forced
// finance allocation. Other cases retain the solver's general explanation.
export function electiveCompletionBlockers({ mapping, planningContext, policyBundle, student = {} } = {}) {
  if (!mapping || !hasCompleteScheduleCoverage(planningContext, policyBundle, {mapping, student})) return [];
  const slots = buildPlanningSlots(planningContext).filter(slot => !slot.isSummer && slot.newCoursesAllowed !== false);
  if (slots.length !== 2 || slots[0].canonicalTerm !== "WINTER" || slots[1].canonicalTerm !== "MAY") return [];
  const unresolved = new Set((mapping.projectedAfterInProgress?.optimistic?.unresolved || mapping.optimistic?.unresolved || []).map(item => item.requirementId));
  const requirements = (mapping.requirements || []).filter(item => unresolved.has(item.id));
  const electives = requirements.filter(item => item.kind === "elective");
  if (electives.length !== 2) return [];
  const assignments = mapping.assignments || [];
  const identity = code => canonicalAllocationCourse(code, policyBundle);
  const used = new Set((student.courses || []).filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => identity(course.code)));
  const sections = slots.map(slot => policyBundle.indexes.offeringByTerm[canonicalTermId(slot)].sections);
  const finance = requirements.find(item => item.id === "finance");
  let financeAllocation = null;
  if (finance) {
    const options = [...new Set(sections.flat().filter(section => !used.has(identity(section.course)) && mayAllocateCourseToRequirement({ requirement: finance, code: section.course, assignments, requirements, policyBundle })).map(section => identity(section.course)))];
    if (options.length !== 1) return [];
    used.add(options[0]);
    financeAllocation = {
      requirementId: finance.id, course: options[0], ruleIds: ["REQ-FINANCE"],
      alternatives: finance.options.map(course => ({course, terms: slots.map(slot => {
        const decision = evaluateOffering({course, source: "verified-offering"}, slot, policyBundle.indexes.offeringByTerm, policyBundle);
        return {termId: canonicalTermId(slot), status: decision.status, reasonCode: decision.reasonCode, sourceRefs: decision.sourceRefs};
      })}))
    };
  }
  const eligible = sections.map(rows => rows.filter(section => !used.has(identity(section.course)) && electives.some(requirement => mayAllocateCourseToRequirement({ requirement, code: section.course, assignments, requirements, policyBundle }))));
  if (eligible[0].length || !eligible[1].length) return [];
  const spring = [...new Map(eligible[1].map(section => [identity(section.course), section])).values()].sort((a, b) => a.course.localeCompare(b.course));
  const capacity = termLoadCapacity(policyBundle, slots[1]);
  const minimumUnits = Math.min(...spring.map(section => section.units));
  if (spring.length < electives.length || !minimumUnits || !spring.every(section => section.units === minimumUnits) || electives.length * minimumUnits <= capacity.conditionalMaximumCourseUnits) return [];
  const conflicts = [];
  for (let left = 0; left < spring.length; left++) for (let right = left + 1; right < spring.length; right++) {
    if (overlaps(spring[left], spring[right])) conflicts.push({leftCourse: spring[left].course, rightCourse: spring[right].course});
  }
  const message = (financeAllocation ? `${policyMessage(policyBundle, "infeasibility.finance.forced", {financeCourse: financeAllocation.course})} ` : "") + policyMessage(policyBundle, "infeasibility.electives.spring", {
    remainingElectives: electives.length, winterTerm: studentTermLabel(slots[0].label), springTerm: studentTermLabel(slots[1].label),
    springOptions: spring.map(section => section.course).join(", "), courseUnits: minimumUnits,
    normalCourseUnits: capacity.normalCourseUnits, conditionalMaximumCourseUnits: capacity.conditionalMaximumCourseUnits
  }) + conflicts.map(conflict => ` ${policyMessage(policyBundle, "infeasibility.electives.conflict", conflict)}`).join("");
  return [{ code: "ELECTIVES_ONLY_IN_SPRING_EXCEED_APPROVED_CAPACITY", message,
    remainingElectives: electives.length, springOptions: spring.map(section => section.course), conflicts,
    financeAllocation, remainingWinterElectives: [],
    satisfiedElectives: assignments.filter(assignment => assignment.slotId.startsWith("eco-elective")).map(assignment => assignment.code),
    ruleIds: [capacity.rule.ruleId, "REQ-ECO-ELECTIVES", ...(financeAllocation?.ruleIds || [])],
    sourceRefs: [...new Set([...capacity.rule.sourceRefs, ...sections.flat().flatMap(section => section.sourceRefs),
      ...(financeAllocation?.alternatives || []).flatMap(option => option.terms.flatMap(term => term.sourceRefs || []))])]
  }];
}

// General elective shortfall (owner decision OD4, Nov 22, 2026: give the specific reason).
// For each remaining term, at most min(distinct eligible elective courses offered, room in
// the term) electives can be placed there. If even the sum of those maxima is below the
// number of electives still needed, no plan can exist, and the numbers can be stated.
function joinTermLabels(labels) {
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function electiveCapacityBlockers({ mapping, planningContext, policyBundle, student = {} } = {}) {
  if (!mapping || !planningContext || !policyBundle
    || !hasCompleteScheduleCoverage(planningContext, policyBundle, {mapping, student})) return [];
  const unresolved = new Set((mapping.projectedAfterInProgress?.optimistic?.unresolved || mapping.optimistic?.unresolved || []).map(item => item.requirementId));
  const requirements = (mapping.requirements || []).filter(item => unresolved.has(item.id));
  const electives = requirements.filter(item => item.kind === "elective");
  if (!electives.length) return [];
  const assignments = mapping.assignments || [];
  const identity = code => canonicalAllocationCourse(code, policyBundle);
  const used = new Set((student.courses || []).filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => identity(course.code)));
  const slots = buildPlanningSlots(planningContext).filter(slot => !slot.isSummer && slot.newCoursesAllowed !== false && !slot.studyAbroad && !slot.isStudyAbroad);
  let maximumElectives = 0;
  for (const slot of slots) {
    const sections = policyBundle.indexes.offeringByTerm[canonicalTermId(slot)]?.sections;
    if (!sections) return [];
    const eligible = new Set(sections.filter(section => !used.has(identity(section.course))
      && electives.some(requirement => mayAllocateCourseToRequirement({ requirement, code: section.course, assignments, requirements, policyBundle })))
      .map(section => identity(section.course)));
    const evidence = termLoadEvidenceForSlot(student, slot);
    const capacity = termLoadCapacity(policyBundle, { ...slot, termLoadEvidence: evidence });
    // Count the overload maximum unless an overload is ruled out, so the stated maximum stays
    // true even if the advisor approves an overload.
    const overloadRuledOut = evidence?.advisorApproval === "NOT_APPROVED" || evidence?.academicProbationStatus === "ON_ACADEMIC_PROBATION";
    const units = capacity.overloadApproved || !overloadRuledOut ? capacity.conditionalMaximumCourseUnits : capacity.normalCourseUnits;
    const reserved = Number(student.reservedCourseUnits?.[slot.id] ?? student.reservedCourseUnits?.[slot.label] ?? slot.reservedCourseUnits ?? 0);
    const room = Math.max(0, Math.floor(units - reserved));
    maximumElectives += Math.min(eligible.size, room);
  }
  if (maximumElectives >= electives.length) return [];
  return [{
    code: "ELECTIVE_CAPACITY_EXCEEDED",
    remainingElectives: electives.length,
    maximumElectives,
    message: policyMessage(policyBundle, "infeasibility.electives.capacity", {
      remainingElectives: electives.length, electiveNoun: pluralize(electives.length, "elective"),
      maximumElectives, terms: joinTermLabels(slots.map(slot => studentTermLabel(slot.label)))
    }),
    ruleIds: ["REQ-ECO-ELECTIVES"]
  }];
}
