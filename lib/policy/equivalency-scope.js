import { loadPlanningFlexibilityPolicy } from "../catalog/policy-releases.js";

function text(value) {
  return String(value || "").trim();
}

export function normalizeMathematicsEquivalencyDecision(input = {}, { policy = null } = {}) {
  const contract = policy || loadPlanningFlexibilityPolicy().policy.mathematicsEquivalencyEvidenceContract;
  const scope = text(input.scope).toUpperCase();
  const decision = {
    authority: text(input.authority) || null,
    source: text(input.source) || null,
    approvalDate: text(input.approvalDate) || null,
    reviewer: text(input.reviewer) || null,
    scope: scope || null,
    affectedCourse: text(input.affectedCourse).toUpperCase() || null,
    affectedRule: text(input.affectedRule) || null
  };
  const errors = [];
  for (const field of contract.requiredEvidenceFields) {
    if (!decision[field]) errors.push(`Mathematics equivalency evidence is missing ${field}.`);
  }
  if (scope && !contract.approvedScopes.includes(scope)) {
    errors.push(`Mathematics equivalency scope ${scope} is not supported.`);
  }
  if (["COURSE_PREREQUISITE", "BOTH"].includes(scope)) {
    for (const field of contract.coursePrerequisiteScopeRequires) {
      if (!decision[field]) errors.push(`Mathematics equivalency scope ${scope} is missing ${field}.`);
    }
  }
  return {
    valid: errors.length === 0,
    decision,
    errors,
    crossScopeInferencePermitted: false,
    disposition: errors.length ? contract.unapprovedDisposition : "APPROVED_WITH_EXACT_SCOPE"
  };
}
