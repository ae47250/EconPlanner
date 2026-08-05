import { aggregateDecisionStatus, createDecision, decisionTraceId } from "./contracts.js";
import { recordedCourseSets } from "./student-facts.js";
import { auditStudentHistory } from "./student-history.js";
import { canonicalAllocationCourse, evaluateRequirementAllocation } from "./requirements.js";
import { evaluatePrerequisites } from "./prerequisites.js";
import { canonicalTermId, evaluateCoursePlacement, evaluatePlanningHorizon, evaluateTermLoad } from "./placement.js";

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
  const { completed, inProgress } = recordedCourseSets(facts);
  const available = new Set(completed);
  const recorded = new Set([...completed, ...inProgress].map(canonicalAllocationCourse));
  const seenCourses = new Map();
  const seenRequirements = new Set((context.mapping?.assignments || []).map(item => item.slotId));
  const allocations = (context.mapping?.assignments || []).map(item => ({ slotId: item.slotId, code: item.code }));
  let level100Electives = allocations.filter(item => String(item.slotId).startsWith("eco-elective") && /^ECO 1\d\d$/i.test(item.code)).length;

  for (const [termIndex, term] of (plan?.terms || []).entries()) {
    if (term.inProgressPrerequisitesAvailable !== false) {
      for (const code of inProgress) available.add(code);
    }
    const termPath = `$.terms[${termIndex}]`;
    const placementContext = context.planningContext || context;
    const isTermTbc = String(term.termKey || term.canonicalTerm || "").toUpperCase() === "TBC";
    const authoritativeSlot = (context.authoritativeSlots || []).find(slot => slot.id === term.slotId);
    const authoritativeTerm = authoritativeSlot
      ? { ...term, reservedCourseUnits: authoritativeSlot.reservedCourseUnits || 0 }
      : term;
    decisions.push(evaluatePlanningHorizon(term, placementContext, bundle, { traceId, objectPath: termPath }));
    decisions.push(evaluateTermLoad(authoritativeTerm, placementContext, bundle, { traceId, objectPath: termPath }));
    if (isTermTbc) {
      const projectedGroups = new Map();
      for (const course of term.courses || []) {
        const projectedTerm = course.projectedTerm || "TBC";
        projectedGroups.set(projectedTerm, [...(projectedGroups.get(projectedTerm) || []), course]);
      }
      for (const [projectedTerm, courses] of projectedGroups) {
        if (projectedTerm === "TBC") continue;
        const canonicalProjectedTerm = String(projectedTerm).toUpperCase();
        const academicYearStart = Number(String(term.academicYear || "").match(/\d{4}/)?.[0]);
        const projectedYear = ["WINTER", "MAY", "SPRING"].includes(canonicalProjectedTerm)
          ? academicYearStart + 1
          : academicYearStart;
        const projectedSlotId = Number.isFinite(projectedYear)
          ? `${canonicalProjectedTerm === "SPRING" || canonicalProjectedTerm === "MAY" ? "spring" : canonicalProjectedTerm.toLowerCase()}-${projectedYear}`
          : null;
        const projectedSlot = (context.authoritativeSlots || []).find(slot => slot.id === projectedSlotId);
        decisions.push(evaluateTermLoad(
          {
            ...term,
            termKey: projectedTerm,
            courses,
            reservedCourseUnits: projectedSlot?.reservedCourseUnits || 0
          },
          placementContext,
          bundle,
          { traceId, objectPath: termPath }
        ));
      }
    }
    const indexedCourses = (term.courses || []).map((course, courseIndex) => ({ course, courseIndex }));
    const orderedCourses = isTermTbc
      ? indexedCourses.sort((left, right) => Number(left.course.planningSequence ?? Number.MAX_SAFE_INTEGER)
        - Number(right.course.planningSequence ?? Number.MAX_SAFE_INTEGER))
      : indexedCourses;
    const sameTermCourses = new Set((term.courses || []).map(course => String(course.course || "").toUpperCase()));
    const authoritativeSections = [];
    let currentProjectedTerm = null;
    let pendingTbcCodes = [];
    for (const { course, courseIndex } of orderedCourses) {
      if (isTermTbc && currentProjectedTerm !== null && course.projectedTerm !== currentProjectedTerm) {
        for (const pendingCode of pendingTbcCodes) available.add(pendingCode);
        pendingTbcCodes = [];
      }
      if (isTermTbc) currentProjectedTerm = course.projectedTerm || `sequence-${course.planningSequence}`;
      const path = `${termPath}.courses[${courseIndex}]`;
      const code = String(course.course || "").toUpperCase();
      const canonicalCode = canonicalAllocationCourse(code);
      decisions.push(evaluateRequirementAllocation(course, course.requirementId, facts, bundle, { traceId, objectPath: path, assignments: allocations, level100Electives }));
      decisions.push(evaluateCoursePlacement(course, term, placementContext, bundle, { traceId, objectPath: path }));
      const section = authoritativeSection(bundle, term, { ...course, course: code });
      if (section) authoritativeSections.push({ section, path });
      if (!code.includes("PLACEHOLDER") && code !== "ECO ELECTIVE" && course.source !== "requirement-placeholder") {
        const prerequisiteClaims = Array.isArray(course.prerequisiteClaims) ? course.prerequisiteClaims : [];
        if (prerequisiteClaims.length) {
          const review = bundle.indexes.byRuleId["REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE"];
          decisions.push(createDecision({
            bundle,
            traceId,
            status: "REVIEW_REQUIRED",
            classification: "REVIEW",
            ruleIds: [review.ruleId],
            reasonCode: "PREREQUISITE_CLAIM_SCOPE_REVIEW",
            subject: { course: code, termId: canonicalTermId(term) },
            objectPath: path,
            messageKeys: review.messageKeys,
            sourceRefs: review.sourceRefs,
            requiredEvidence: prerequisiteClaims.map(claim => String(claim.kind || "claim").toUpperCase())
          }));
        } else {
          const concurrentCourses = isTermTbc
            ? new Set((term.courses || []).filter(candidate => (
              candidate !== course
              && course.projectedTerm
              && candidate.projectedTerm === course.projectedTerm
            )).map(candidate => String(candidate.course || "").toUpperCase()))
            : sameTermCourses;
          decisions.push(evaluatePrerequisites(course, { ...term, termId: canonicalTermId(term) }, facts, bundle, {
            traceId,
            objectPath: path,
            availableCourses: available,
            sameTermCourses: concurrentCourses,
            approvalInstances: facts.approvals,
            uncertainTiming: isTermTbc && !Number.isFinite(Number(course.planningSequence)),
            evaluationDate: facts.planCreationDate
          }));
        }
      }
      if (recorded.has(canonicalCode) && canonicalCode !== "ECO ELECTIVE") decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["ELECTIVE-NO-DOUBLE-COUNT"], reasonCode: "COURSE_ALREADY_RECORDED", subject: { course: canonicalCode }, objectPath: path }));
      if (seenCourses.has(canonicalCode) && canonicalCode !== "ECO ELECTIVE") decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["ELECTIVE-NO-DOUBLE-COUNT"], reasonCode: "COURSE_DUPLICATED", subject: { course: canonicalCode }, objectPath: path }));
      if (course.requirementId && seenRequirements.has(course.requirementId)) decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["ELECTIVE-NO-DOUBLE-COUNT"], reasonCode: "REQUIREMENT_DUPLICATED", subject: { requirementId: course.requirementId }, objectPath: path }));
      seenCourses.set(canonicalCode, course.requirementId);
      if (course.requirementId) seenRequirements.add(course.requirementId);
      allocations.push({ slotId: course.requirementId, code });
      if (String(course.requirementId).startsWith("eco-elective") && /^ECO 1\d\d$/.test(canonicalCode)) level100Electives += 1;
      if (isTermTbc) pendingTbcCodes.push(code);
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
    if (isTermTbc) {
      for (const pendingCode of pendingTbcCodes) available.add(pendingCode);
    } else {
      for (const code of sameTermCourses) available.add(code);
    }
  }

  for (const requirementId of requirementIds(context)) {
    if (!seenRequirements.has(requirementId)) decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [], reasonCode: "REQUIREMENT_UNSCHEDULED", subject: { requirementId }, objectPath: "$.unscheduled" }));
  }
  if ((plan?.unscheduled || []).length) decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [], reasonCode: "REQUIREMENTS_UNSCHEDULED", subject: { count: plan.unscheduled.length }, objectPath: "$.unscheduled" }));

  const finalStatus = aggregateDecisionStatus(decisions);
  const complete = !(plan?.unscheduled || []).length && requirementIds(context).every(requirementId => seenRequirements.has(requirementId));
  return Object.freeze({
    traceId,
    status: finalStatus,
    completionStatus: complete ? "COMPLETE" : "PARTIAL",
    evidenceStatus: evidenceStatus(finalStatus),
    academicallyValid: !["BLOCK", "UNKNOWN"].includes(finalStatus),
    approvedForAuthority: ["ALLOW", "CONDITIONAL", "PRELIMINARY"].includes(finalStatus),
    decisions,
    reviewFindings: decisions.filter(decision => decision.status === "REVIEW_REQUIRED"),
    policyBundleVersion: bundle.bundleVersion,
    policyBundleHash: bundle.contentHash,
    latencyMs: Math.round((performance.now() - startedAt) * 1000) / 1000
  });
}
