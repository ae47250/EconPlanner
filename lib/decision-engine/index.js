export { DECISION_CLASSIFICATION, DECISION_STATUS, createDecision, decisionTraceId } from "./contracts.js";
export { normalizeStudentFacts, recordedCourseSets, studentFactsHash } from "./student-facts.js";
export { auditStudentHistory } from "./student-history.js";
export { auditRequirements, evaluateRequirementAllocation } from "./requirements.js";
export { evaluatePermission, evaluatePrerequisites } from "./prerequisites.js";
export { canonicalTerm, canonicalTermId, evaluateCoursePlacement, evaluateOffering, evaluatePlanningHorizon, evaluateTermLoad } from "./placement.js";
export { evaluatePlan } from "./plan.js";

import { createDecision, decisionTraceId } from "./contracts.js";
import { evaluateRequirementAllocation } from "./requirements.js";

export function evaluateRecordedCourse(course, facts, bundle, { traceId = decisionTraceId({ course, facts }) } = {}) {
  const rule = bundle.indexes.byRuleId["HISTORY-COMPLETED-ADVANCED-PRESERVED"];
  const advanced = Number(String(course.course || "").match(/\d+/)?.[0] || 0) >= 200;
  const missingEvidence = advanced && ["COMPLETED", "TRANSFER"].includes(course.status) && !(course.prerequisiteEvidence || []).length;
  return createDecision({ bundle, traceId, status: missingEvidence ? "REVIEW_REQUIRED" : "ALLOW", classification: missingEvidence ? "REVIEW" : "EVIDENCE", ruleIds: missingEvidence ? [rule.ruleId] : [], reasonCode: missingEvidence ? "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW" : "RECORDED_COURSE_ACCEPTED", subject: { course: course.course, status: course.status }, sourceRefs: missingEvidence ? rule.sourceRefs : [] });
}

export function explainDecision(decision, audience, bundle) {
  const messageKey = decision.messageKeys?.[audience] || null;
  return { ...decision, audience, messageKey, message: messageKey ? bundle.messages[messageKey] || null : null };
}

export function getAllowedPlanEdits() {
  throw new Error("Server-derived plan edits are introduced in CP6, not CP3 shadow mode.");
}

export { evaluateRequirementAllocation as evaluateAllocation };
