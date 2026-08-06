import { createHash } from "node:crypto";
import { canonicalJson } from "../policy/canonical-json.js";

export const READINESS_STATUS = Object.freeze({
  STUDENT_READY: "STUDENT_READY",
  READY_WITH_CONDITIONS: "READY_WITH_CONDITIONS",
  ADVISOR_ACTION_REQUIRED: "ADVISOR_ACTION_REQUIRED",
  NOT_READY: "NOT_READY"
});

export const PLAN_DISPOSITION = Object.freeze({
  COMPLETE_STUDENT_READY: "COMPLETE_STUDENT_READY",
  COMPLETE_READY_WITH_CONDITIONS: "COMPLETE_READY_WITH_CONDITIONS",
  COMPLETE_ADVISOR_ACTION_REQUIRED: "COMPLETE_ADVISOR_ACTION_REQUIRED",
  PARTIAL: "PARTIAL",
  BLOCKED: "BLOCKED"
});

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").slice(0, 20)}`;
}

function actionFromDecision(decision) {
  const affectedObject = {
    course: decision.subject?.course || null,
    requirementId: decision.subject?.requirementId || null,
    allocationId: decision.subject?.allocationId || null,
    catalogDecision: decision.subject?.catalogDecision || null,
    objectPath: decision.objectPath || "$"
  };
  const identity = {
    reasonCode: decision.reasonCode,
    ruleIds: decision.ruleIds || [],
    sourceRefs: decision.sourceRefs || [],
    affectedObject
  };
  return {
    actionId: stableId("advisor-action", identity),
    reasonCode: decision.reasonCode,
    controllingRuleId: [...(decision.ruleIds || [])].sort()[0] || null,
    controllingRuleIds: [...new Set(decision.ruleIds || [])].sort(),
    sourceRefs: [...new Set(decision.sourceRefs || [])].sort(),
    responsibleAuthority: decision.responsibleAuthority || decision.requiredApproval || "ACADEMIC_ADVISOR_OR_AUTHORIZED_DEPARTMENT",
    evidenceRequired: [...new Set(decision.requiredEvidence || [])].sort(),
    affectedObject,
    currentDisposition: "UNRESOLVED_REVIEW"
  };
}

function catalogAction(catalogApplicability) {
  if (!catalogApplicability?.advisorAction) return null;
  const supplied = catalogApplicability.advisorAction;
  const identity = {
    reasonCode: supplied.reasonCode || "CATALOG_APPLICABILITY_REVIEW",
    candidateCatalogYears: catalogApplicability.candidateCatalogYears || [],
    sourceRefs: catalogApplicability.sourceRefs || []
  };
  return {
    actionId: supplied.actionId || stableId("advisor-action", identity),
    reasonCode: supplied.reasonCode || "CATALOG_APPLICABILITY_REVIEW",
    controllingRuleId: supplied.controllingRuleId || "CATALOG-APPLICABILITY-DECLARATION-YEAR",
    controllingRuleIds: [...new Set(supplied.controllingRuleIds || [supplied.controllingRuleId || "CATALOG-APPLICABILITY-DECLARATION-YEAR"])].sort(),
    sourceRefs: [...new Set(supplied.sourceRefs || catalogApplicability.sourceRefs || [])].sort(),
    responsibleAuthority: supplied.responsibleAuthority || "ACADEMIC_ADVISOR_OR_REGISTRAR",
    evidenceRequired: [...new Set(supplied.evidenceRequired || ["MAJOR_DECLARATION_CATALOG_YEAR"])].sort(),
    affectedObject: supplied.affectedObject || { catalogDecision: "GOVERNING_MAJOR_CATALOG_YEAR" },
    currentDisposition: supplied.currentDisposition || "UNRESOLVED_REVIEW"
  };
}

export function canonicalAdvisorActions(decisions = [], catalogApplicability = null) {
  const actions = decisions
    .filter(decision => decision?.status === "REVIEW_REQUIRED")
    .map(actionFromDecision);
  const catalog = catalogAction(catalogApplicability);
  if (catalog) actions.push(catalog);
  return [...new Map(actions.map(action => [action.actionId, action])).values()]
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
}

export function classifyPlanReadiness({
  completionStatus,
  academicallyValid,
  decisions = [],
  catalogApplicability = null,
  searchIncomplete = false
} = {}) {
  const advisorActions = canonicalAdvisorActions(decisions, catalogApplicability);
  const complete = completionStatus === "COMPLETE";
  const blocked = !academicallyValid || decisions.some(decision => ["BLOCK", "UNKNOWN"].includes(decision.status));
  let readinessStatus;
  let planDisposition;

  if (!complete || blocked || searchIncomplete) {
    readinessStatus = READINESS_STATUS.NOT_READY;
    planDisposition = blocked ? PLAN_DISPOSITION.BLOCKED : PLAN_DISPOSITION.PARTIAL;
  } else if (advisorActions.length) {
    readinessStatus = READINESS_STATUS.ADVISOR_ACTION_REQUIRED;
    planDisposition = PLAN_DISPOSITION.COMPLETE_ADVISOR_ACTION_REQUIRED;
  } else if (decisions.some(decision => ["CONDITIONAL", "PRELIMINARY"].includes(decision.status))) {
    readinessStatus = READINESS_STATUS.READY_WITH_CONDITIONS;
    planDisposition = PLAN_DISPOSITION.COMPLETE_READY_WITH_CONDITIONS;
  } else {
    readinessStatus = READINESS_STATUS.STUDENT_READY;
    planDisposition = PLAN_DISPOSITION.COMPLETE_STUDENT_READY;
  }

  return Object.freeze({
    readinessStatus,
    planDisposition,
    advisorActionRequired: advisorActions.length > 0,
    advisorActions
  });
}
