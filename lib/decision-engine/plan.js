import { aggregateDecisionStatus, createDecision, decisionTraceId } from "./contracts.js";
import { recordedCourseSets } from "./student-facts.js";
import { evaluateRequirementAllocation } from "./requirements.js";
import { evaluatePrerequisites } from "./prerequisites.js";
import { canonicalTermId, evaluateCoursePlacement, evaluateTermLoad } from "./placement.js";

function evidenceStatus(status) {
  return ({ ALLOW: "VERIFIED", CONDITIONAL: "CONDITIONAL", PRELIMINARY: "PRELIMINARY", REVIEW_REQUIRED: "REVIEW_REQUIRED", BLOCK: "BLOCKED", UNKNOWN: "REVIEW_REQUIRED" })[status];
}

export function evaluatePlan(plan, facts, context, bundle) {
  const startedAt = performance.now();
  const traceId = context?.traceId || decisionTraceId({ facts, planId: plan?.id, bundle: bundle.contentHash });
  const decisions = [];
  const { availableForFuture } = recordedCourseSets(facts);
  const available = new Set(availableForFuture);
  const seenCourses = new Set();
  const seenRequirements = new Set();

  for (const [termIndex, term] of (plan?.terms || []).entries()) {
    const termPath = `$.terms[${termIndex}]`;
    decisions.push(evaluateTermLoad(term, context, bundle, { traceId, objectPath: termPath }));
    const sameTermCourses = new Set((term.courses || []).flatMap(course => course.source === "requirement-placeholder" && Array.isArray(course.options)
      ? course.options.map(option => String(option).toUpperCase())
      : [String(course.course || "").toUpperCase()]));
    for (const [courseIndex, course] of (term.courses || []).entries()) {
      const path = `${termPath}.courses[${courseIndex}]`;
      const code = String(course.course || "").toUpperCase();
      decisions.push(evaluateRequirementAllocation(course, course.requirementId, facts, bundle, { traceId, objectPath: path }));
      decisions.push(evaluateCoursePlacement(course, term, context, bundle, { traceId, objectPath: path }));
      if (!code.includes("PLACEHOLDER") && code !== "ECO ELECTIVE" && !String(course.source || "").includes("placeholder")) {
        decisions.push(evaluatePrerequisites(course, { ...term, termId: canonicalTermId(term) }, facts, bundle, { traceId, objectPath: path, availableCourses: available, sameTermCourses, approvalInstances: facts.approvals }));
      }
      if (seenCourses.has(code) && code !== "ECO ELECTIVE") decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["ELECTIVE-NO-DOUBLE-COUNT"], reasonCode: "COURSE_DUPLICATED", subject: { course: code }, objectPath: path }));
      if (seenRequirements.has(course.requirementId)) decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: ["ELECTIVE-NO-DOUBLE-COUNT"], reasonCode: "REQUIREMENT_DUPLICATED", subject: { requirementId: course.requirementId }, objectPath: path }));
      seenCourses.add(code);
      seenRequirements.add(course.requirementId);
    }
    for (const code of sameTermCourses) available.add(code);
  }
  if ((plan?.unscheduled || []).length) decisions.push(createDecision({ bundle, traceId, status: "BLOCK", classification: "HARD", ruleIds: [], reasonCode: "REQUIREMENTS_UNSCHEDULED", subject: { count: plan.unscheduled.length }, objectPath: "$.unscheduled" }));

  const finalStatus = aggregateDecisionStatus(decisions);
  const completionStatus = (plan?.unscheduled || []).length || decisions.some(decision => decision.status === "BLOCK") ? "PARTIAL" : "COMPLETE";
  return Object.freeze({
    traceId,
    status: finalStatus,
    completionStatus,
    evidenceStatus: evidenceStatus(finalStatus),
    academicallyValid: !["BLOCK", "UNKNOWN"].includes(finalStatus),
    approvedForAuthority: ["ALLOW", "CONDITIONAL", "PRELIMINARY"].includes(finalStatus),
    decisions,
    policyBundleVersion: bundle.bundleVersion,
    policyBundleHash: bundle.contentHash,
    latencyMs: Math.round((performance.now() - startedAt) * 1000) / 1000
  });
}
