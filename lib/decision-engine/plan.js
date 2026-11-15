import { extraCourseError } from "../planning/extra-courses.js";
import { termLoadMessage, termLoadTuitionAdvisories } from "../policy/term-load.js";
import { resolvePlanningContext } from "../planning/horizon.js";
import { aggregateDecisionStatus, createDecision, decisionTraceId } from "./contracts.js";
import { recordedCourseSets } from "./student-facts.js";
import { auditStudentHistory } from "./student-history.js";
import { canonicalAllocationCourse, evaluateRequirementAllocation } from "./requirements.js";
import { evaluatePrerequisites } from "./prerequisites.js";
import { canonicalTermId, evaluateCoursePlacement, evaluatePlanningHorizon, evaluateTermLoad, evaluateTermElectives } from "./placement.js";
import { classifyPlanReadiness } from "./readiness.js";
import { buildTbcTemporalWitness } from "./tbc-temporal.js";
import {planPublicationStatus} from "../planning/notices.js";

function evidenceStatus(status) {
  return ({ ALLOW: "VERIFIED", CONDITIONAL: "CONDITIONAL", PRELIMINARY: "PRELIMINARY", REVIEW_REQUIRED: "REVIEW_REQUIRED", BLOCK: "BLOCKED", UNKNOWN: "REVIEW_REQUIRED" })[status];
}

function requirementIds(context = {}) {
  return (context.requirements || context.mapping?.requirements || []).map(requirement => requirement.id).filter(Boolean);
}

function minutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function authoritativeSection(bundle, term, course) {
  const indexedTerm = bundle.indexes.offeringByTerm[canonicalTermId(term)];
  if (!indexedTerm) return null;
  return indexedTerm.sections.find(section => (
    (section.course === course.course || (section.crossListedAs || []).includes(course.course))
    && (!course.section || section.sectionId.endsWith(`-${String(course.section).toUpperCase()}`))
  )) || null;
}

function sectionsConflict(left, right) {
  const sharedDay = (left.meeting?.days || []).some(day => (right.meeting?.days || []).includes(day));
  const leftStart = minutes(left.meeting?.startTime);
  const leftEnd = minutes(left.meeting?.endTime);
  const rightStart = minutes(right.meeting?.startTime);
  const rightEnd = minutes(right.meeting?.endTime);
  return sharedDay
    && [leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)
    && leftStart < rightEnd
    && rightStart < leftEnd;
}

export function evaluatePlan(plan, facts, context = {}, bundle) {
  const startedAt = performance.now();
  const traceId = context.traceId || decisionTraceId({ facts, planId: plan?.id, bundle: bundle.contentHash });
  const history = auditStudentHistory({ ...facts, courses: facts.courses }, bundle, { traceId });
  const decisions = [...history.decisions];
  const temporalSemantics = buildTbcTemporalWitness(plan, facts, {
    ...context,
    ...(context.planningContext || {})
  }, bundle, { traceId });
  decisions.push(...temporalSemantics.decisions);
  const temporalPlacementById = new Map(temporalSemantics.placements.map(placement => [placement.courseId, placement]));
  const { completed, inProgress } = recordedCourseSets(facts);
  const available = new Set(completed);
  const recorded = new Set([...completed, ...inProgress].map(code => canonicalAllocationCourse(code, bundle)));
  const seenTermIds = new Set();
  const seenCourses = new Map();
  const declaredElectiveSlots = new Set();
  const seenRequirements = new Set((context.mapping?.assignments || []).map(item => item.slotId));
  const allocations = (context.mapping?.assignments || []).map(item => ({ slotId: item.slotId, code: item.code }));
  const completeAllocations = [...allocations, ...(plan.terms || []).flatMap(term => (term.courses || [])
    .filter(course => !course.extra && !course.fixedInProgress)
    .map(course => ({ slotId: course.requirementId, code: course.course })))];
  let level100Electives = allocations.filter(item => String(item.slotId).startsWith("eco-elective") && /^ECO 1\d\d$/i.test(item.code)).length;

  for (const [termIndex, term] of (plan?.terms || []).entries()) {
    // Completion timing comes from the dated planning context, never a submitted
    // term flag. Taking now work cannot unlock another current-term course.
    const datedContext = facts.planCreationDate ? resolvePlanningContext({planCreationDate: facts.planCreationDate}) : null;
    const targetYear = Number(String(term.academicYear || "").slice(0, 4));
    const targetTerm = ["FALL", "WINTER", "MAY"].indexOf(String(term.termKey || "").toUpperCase().replace("SPRING/MAY", "MAY").replace("SPRING", "MAY"));
    const afterCurrent = datedContext
      ? datedContext.isSummer || targetYear > datedContext.startYear
        || (targetYear === datedContext.startYear && targetTerm > datedContext.startTermIndex)
      : term.inProgressPrerequisitesAvailable !== false;
    if (afterCurrent && term.inProgressPrerequisitesAvailable !== false) for (const code of inProgress) available.add(code);
    const termPath = `$.terms[${termIndex}]`;
    const termId = canonicalTermId(term);
    if (termId && seenTermIds.has(termId)) {
      decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD",
        reasonCode: "DUPLICATE_TERM_IDENTITY", subject: { termId }, objectPath: termPath }));
    }
    if (termId) seenTermIds.add(termId);
    const placementContext = context.planningContext || context;
    const isTermTbc = String(term.termKey || term.canonicalTerm || "").toUpperCase() === "TBC";
    const authoritativeSlot = (context.authoritativeSlots || []).find(slot => slot.id === term.slotId);
    const authoritativeTerm = authoritativeSlot
      ? {
          ...term,
          reservedCourseUnits: authoritativeSlot.reservedCourseUnits || 0,
          termLoadEvidence: authoritativeSlot.termLoadEvidence || null
        }
      : term;
    decisions.push(evaluatePlanningHorizon(term, placementContext, bundle, { traceId, objectPath: termPath }));
    decisions.push(evaluateTermLoad(authoritativeTerm, placementContext, bundle, { traceId, objectPath: termPath }));
    decisions.push(evaluateTermElectives(authoritativeTerm, bundle, { traceId, objectPath: termPath }));
    const indexedCourses = (term.courses || []).map((course, courseIndex) => ({ course, courseIndex }));
    const orderedCourses = isTermTbc
      ? indexedCourses.sort((left, right) => {
          const year = String(term.academicYear || "").replace("/", "-");
          const leftId = `${year}|${String(left.course.course || "").toUpperCase()}|${left.course.requirementId || "UNASSIGNED"}`;
          const rightId = `${year}|${String(right.course.course || "").toUpperCase()}|${right.course.requirementId || "UNASSIGNED"}`;
          return Number(temporalPlacementById.get(leftId)?.assignedOrdinal || Number.MAX_SAFE_INTEGER)
            - Number(temporalPlacementById.get(rightId)?.assignedOrdinal || Number.MAX_SAFE_INTEGER)
            || leftId.localeCompare(rightId);
        })
      : indexedCourses;
    const sameTermCourses = new Set((term.courses || []).map(course => String(course.course || "").toUpperCase()));
    const authoritativeSections = [];
    for (const { course, courseIndex } of orderedCourses) {
      const path = `${termPath}.courses[${courseIndex}]`;
      const code = String(course.course || "").toUpperCase();
      const canonicalCode = canonicalAllocationCourse(code, bundle);
      // Taking now rows are fixed occupancy already represented by the
      // student's authoritative mapping assignments. They count toward term
      // load and same-term prerequisite context, but are not new allocations.
      if (course.fixedInProgress === true) {
        const selectedSection = authoritativeSlot ? authoritativeSlot.fixedCourses?.find(row => row.course === code)?.section : course.section;
        const section = selectedSection ? authoritativeSection(bundle, term, {...course,course:code,section:selectedSection}) : null;
        if (section) authoritativeSections.push({section,path});
        if (!section || !section.meeting?.days?.length || !section.meeting.startTime || !section.meeting.endTime) {
          decisions.push(createDecision({bundle,traceId,status:"REVIEW_REQUIRED",classification:"EVIDENCE",
            ruleIds:["SCHEDULE-AVAILABILITY-BEHAVIOR"],reasonCode:"IN_PROGRESS_SECTION_MEETINGS_REVIEW",
            subject:{course:code,termId},objectPath:path,requiredEvidence:["CURRENT_SECTION_AND_MEETINGS"],
            sourceRefs:section?.sourceRefs || []}));
        }
        continue;
      }
      const tbcYear = String(term.academicYear || "").replace("/", "-");
      const temporalId = `${tbcYear}|${code}|${course.requirementId || "UNASSIGNED"}`;
      const witnessedPlacement = temporalPlacementById.get(temporalId);
      if (isTermTbc && witnessedPlacement?.assignedOrdinal) {
        for (const placement of temporalSemantics.placements) {
          if (placement.placementWindow.academicYear !== tbcYear) continue;
          if (placement.assignedOrdinal < witnessedPlacement.assignedOrdinal) available.add(placement.course);
        }
      }
      if (course.extra === true) {
        const error = extraCourseError(course, bundle);
        if (error) decisions.push(createDecision({bundle,traceId,status:"BLOCK",classification:"HARD",ruleIds:[],reasonCode:"INVALID_EXTRA_COURSE",subject:{course:code},objectPath:path}));
      } else decisions.push(evaluateRequirementAllocation(course, course.requirementId, facts, bundle, {
        traceId, objectPath: path, assignments: completeAllocations, level100Electives,
        majorCatalogYear: context.planningContext?.catalogApplicability?.appliedMajorCatalogYear
      }));
      decisions.push(evaluateCoursePlacement(course, term, placementContext, bundle, { traceId, objectPath: path }));
      const section = authoritativeSection(bundle, term, { ...course, course: code });
      if (section) authoritativeSections.push({ section, path });
      if (!code.includes("PLACEHOLDER") && code !== "ECO ELECTIVE" && course.source !== "requirement-placeholder") {
        const concurrentCourses = isTermTbc
          ? new Set(temporalSemantics.placements.filter(candidate => (
            candidate.placementWindow.academicYear === tbcYear
            && candidate.assignedOrdinal
            && candidate.assignedOrdinal === witnessedPlacement?.assignedOrdinal
          )).map(candidate => candidate.course))
          : sameTermCourses;
        decisions.push(evaluatePrerequisites(course, { ...term, termId: canonicalTermId(term) }, facts, bundle, {
          traceId,
          objectPath: path,
          availableCourses: available,
          sameTermCourses: concurrentCourses,
          approvalInstances: facts.approvals,
          uncertainTiming: isTermTbc && !witnessedPlacement?.assignedOrdinal,
          evaluationDate: facts.planCreationDate
        }));
      }
      if (recorded.has(canonicalCode) && canonicalCode !== "ECO ELECTIVE") decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["ELECTIVE-NO-DOUBLE-COUNT"], reasonCode: "COURSE_ALREADY_RECORDED", subject: { course: canonicalCode }, objectPath: path }));
      if (seenCourses.has(canonicalCode) && canonicalCode !== "ECO ELECTIVE") decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["ELECTIVE-NO-DOUBLE-COUNT"], reasonCode: "COURSE_DUPLICATED", subject: { course: canonicalCode }, objectPath: path }));
      if (course.requirementId && seenRequirements.has(course.requirementId)) {
        const electiveSlot = declaredElectiveSlots.has(course.requirementId);
        const rule = bundle.indexes.byRuleId[electiveSlot ? "ELECTIVE-SLOT-UNIQUE-ASSIGNMENT" : "ELECTIVE-NO-DOUBLE-COUNT"];
        decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [rule.ruleId], reasonCode: electiveSlot ? rule.reasonCode : "REQUIREMENT_DUPLICATED", subject: { requirementId: course.requirementId }, objectPath: path, sourceRefs: rule.sourceRefs }));
      }
      seenCourses.set(canonicalCode, course.requirementId);
      if (course.requirementId) seenRequirements.add(course.requirementId);
      if (bundle.indexes.byRuleId["ELECTIVE-SLOT-UNIQUE-ASSIGNMENT"].scope.requirements.includes(course.requirementId)) declaredElectiveSlots.add(course.requirementId);
      if (course.extra !== true) allocations.push({ slotId: course.requirementId, code });
      if (String(course.requirementId).startsWith("eco-elective") && /^ECO 1\d\d$/.test(canonicalCode)) level100Electives += 1;
    }
    for (let left = 0; left < authoritativeSections.length; left += 1) {
      for (let right = left + 1; right < authoritativeSections.length; right += 1) {
        if (!sectionsConflict(authoritativeSections[left].section, authoritativeSections[right].section)) continue;
        decisions.push(createDecision({
          bundle,
          traceId,
          status: "BLOCK",
          classification: "HARD",
          ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"],
          reasonCode: "AUTHORITATIVE_MEETING_CONFLICT",
          subject: {
            termId: canonicalTermId(term),
            sections: [authoritativeSections[left].section.sectionId, authoritativeSections[right].section.sectionId]
          },
          objectPath: termPath,
          sourceRefs: [...authoritativeSections[left].section.sourceRefs, ...authoritativeSections[right].section.sourceRefs]
        }));
      }
    }
    for (const code of sameTermCourses) available.add(code);
  }

  for (const requirementId of requirementIds(context)) {
    if (!seenRequirements.has(requirementId)) decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [], reasonCode: "REQUIREMENT_UNSCHEDULED", subject: { requirementId }, objectPath: "$.unscheduled" }));
  }
  if ((plan?.unscheduled || []).length) decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [], reasonCode: "REQUIREMENTS_UNSCHEDULED", subject: { count: plan.unscheduled.length }, objectPath: "$.unscheduled" }));

  const finalStatus = aggregateDecisionStatus(decisions);
  const complete = !(plan?.unscheduled || []).length && requirementIds(context).every(requirementId => seenRequirements.has(requirementId));
  const academicallyValid = !["BLOCK", "UNKNOWN"].includes(finalStatus);
  const readiness = classifyPlanReadiness({
    completionStatus: complete ? "COMPLETE" : "PARTIAL",
    academicallyValid,
    decisions,
    catalogApplicability: context.planningContext?.catalogApplicability || context.catalogApplicability || null,
    searchIncomplete: plan?.search?.complete === false && !plan?.search?.solutionFound
  });
  const conditions = decisions.filter(decision => ["CONDITIONAL", "PRELIMINARY"].includes(decision.status)).map(decision => ({
    conditionId: decision.decisionId,
    type: decision.status,
    reasonCode: decision.reasonCode,
    ruleIds: decision.ruleIds,
    sourceRefs: decision.sourceRefs,
    affectedObject: decision.subject,
    message: termLoadMessage(decision, bundle) || null,
    messageParams: decision.messageParams
  })).sort((left, right) => left.conditionId.localeCompare(right.conditionId));
  return Object.freeze({
    traceId,
    status: finalStatus,
    completionStatus: complete ? "COMPLETE" : "PARTIAL",
    evidenceStatus: evidenceStatus(finalStatus),
    publicationStatus: planPublicationStatus(plan),
    academicallyValid,
    approvedForAuthority: ["ALLOW", "CONDITIONAL", "PRELIMINARY"].includes(finalStatus) && !readiness.advisorActionRequired,
    ...readiness,
    conditions,
    tuitionAdvisories: termLoadTuitionAdvisories((plan.terms || []).map(term => {
      const slot = context.authoritativeSlots?.find(slot => slot.id === term.slotId);
      return slot ? { ...term, reservedCourseUnits: slot.reservedCourseUnits || 0 } : term;
    }), bundle),
    temporalSemantics,
    catalogApplicability: context.planningContext?.catalogApplicability || context.catalogApplicability || null,
    evidenceFacts: facts.evidenceFacts || [],
    decisions,
    reviewFindings: decisions.filter(decision => decision.status === "REVIEW_REQUIRED"),
    policyBundleVersion: bundle.bundleVersion,
    policyBundleHash: bundle.contentHash,
    latencyMs: Math.round((performance.now() - startedAt) * 1000) / 1000
  });
}
