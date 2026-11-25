export { DECISION_CLASSIFICATION, DECISION_STATUS, createDecision, decisionTraceId } from "./contracts.js";
export { EVIDENCE_FACT_TYPE, normalizeStudentFacts, recordedCourseSets, studentFactsHash } from "./student-facts.js";
export { auditStudentHistory } from "./student-history.js";
export { auditRequirements, evaluateRequirementAllocation } from "./requirements.js";
export { evaluatePermission, evaluatePrerequisites } from "./prerequisites.js";
export { canonicalTerm, canonicalTermId, evaluateCoursePlacement, evaluateOffering, evaluatePlanningHorizon, evaluateTermLoad } from "./placement.js";
export { evaluatePlan } from "./plan.js";
export { PLAN_DISPOSITION, READINESS_STATUS, canonicalAdvisorActions, classifyPlanReadiness } from "./readiness.js";
export { buildTbcTemporalWitness } from "./tbc-temporal.js";
