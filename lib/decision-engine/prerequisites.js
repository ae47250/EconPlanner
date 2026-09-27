import { requirementOptions, REQUIREMENT_PLACEHOLDERS } from "../policy/requirement-choices.js";
import { createDecision } from "./contracts.js";
import { resolveReviewPolicyRecord } from "../policy/load-bundle.js";

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function prerequisiteClaimReviewRuleId(claim, prerequisiteRule) {
  const kind = lower(claim?.kind);
  const prerequisite = upper(claim?.prerequisite);
  const equivalencyOptions = new Set(
    (prerequisiteRule?.effect?.oneOfGroups || []).flat().map(upper)
  );
  if (kind === "equivalency"
    && prerequisiteRule?.effect?.equivalencyReviewRule
    && equivalencyOptions.has(prerequisite)) {
    return prerequisiteRule.effect?.equivalencyReviewRule;
  }
  return "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE";
}

function createPolicyReviewDecision({
  bundle,
  traceId,
  course,
  termId,
  objectPath,
  ruleIds,
  reasonCode,
  requiredEvidence,
  messageParams = {}
}) {
  const records = [...new Set(ruleIds)].map(ruleId => {
    const record = resolveReviewPolicyRecord(bundle, ruleId);
    if (!record) throw new Error(`Missing canonical review policy record ${ruleId}.`);
    return record;
  });
  return createDecision({
    bundle,
    traceId,
    status: "REVIEW_REQUIRED",
    classification: "REVIEW",
    ruleIds: records.map(record => record.ruleId),
    reasonCode,
    subject: { course, termId },
    objectPath,
    messageKeys: records[0]?.messageKeys || {},
    messageParams,
    sourceRefs: records.flatMap(record => record.sourceRefs || []),
    requiredEvidence,
    responsibleAuthority: "ACADEMIC_ADVISOR_OR_AUTHORIZED_DEPARTMENT",
    policyDisposition: {
      disposition: records[0].disposition,
      enforcement: records[0].enforcement,
      status: records[0].status,
      requiredDisposition: records[0].requiredDisposition
    },
    provenance: records.flatMap(record => record.provenance || [])
  });
}

function expectedApprovalType(rule) {
  return /instructor/i.test(rule.effect?.approvalAuthority || "") ? "instructor" : "department";
}

function expectedReason(rule) {
  if (rule.ruleId.startsWith("CONCURRENT-MATH")) return "concurrent_math";
  if (rule.ruleId === "CONCURRENT-INTERMEDIATE-ECO-461") return "concurrent_intermediate_with_capstone";
  return "department_permission";
}

function validDateRange(approval, evaluationDate) {
  if (!evaluationDate) return true;
  if (approval.effectiveDate && approval.effectiveDate > evaluationDate) return false;
  return !approval.expirationDate || approval.expirationDate >= evaluationDate;
}

function requirementPlaceholderSatisfies(options, courses, bundle) {
  const normalized = [...options].map(upper).sort().join("|");
  return Object.entries(REQUIREMENT_PLACEHOLDERS).some(([id, placeholder]) =>
    normalized === [...requirementOptions(bundle, id)].sort().join("|") && courses.has(placeholder));
}

function canonicalApprovalMatches(approval, rule, context) {
  const course = rule.condition.dependentCourse || rule.condition.course;
  return approval?.approvalId
    && approval.ruleId === rule.ruleId
    && approval.status === "APPROVED"
    && upper(approval.scope?.course) === upper(course)
    && (!context.termId || approval.scope?.termId === context.termId)
    && lower(approval.authority).includes(expectedApprovalType(rule))
    && approval.authorityBoundary === rule.authority.boundary
    && Boolean(approval.evidenceRef)
    && validDateRange(approval, context.evaluationDate);
}

function legacyApprovalMatches(approval, rule, context) {
  const course = rule.condition.dependentCourse || rule.condition.course;
  const prerequisite = context.prerequisite || null;
  const expectedType = expectedApprovalType(rule);
  const type = lower(approval?.type || approval?.authority);
  const authority = lower(approval?.authority);
  const source = lower(`${approval?.policySource || ""} ${approval?.sourceRef || ""}`);
  return !approval?.approvalId
    && upper(approval?.course) === upper(course)
    && (!prerequisite || upper(approval?.prerequisite) === upper(prerequisite))
    && type.includes(expectedType)
    && (!authority || authority.includes(expectedType))
    && (!context.termLabel || lower(approval?.term) === lower(context.termLabel))
    && lower(approval?.reason).includes(expectedReason(rule))
    && source.includes("department")
    && source.includes("polic");
}

export function evaluatePermission(rule, approvalInstances = [], context = {}) {
  const approved = approvalInstances.find(approval => canonicalApprovalMatches(approval, rule, context));
  if (approved) return Object.freeze({ status: "ALLOW", ruleId: rule.ruleId, reasonCode: "APPROVAL_INSTANCE_MATCH", approvalId: approved.approvalId });
  const required = approvalInstances.find(approval => approval?._attachedRequired && legacyApprovalMatches(approval, rule, context));
  if (required) return Object.freeze({ status: "CONDITIONAL", ruleId: rule.ruleId, reasonCode: "APPROVAL_REQUIRED_MATCH", approvalId: null });
  return Object.freeze({ status: "BLOCK", ruleId: rule.ruleId, reasonCode: "APPROVAL_MISSING_OR_SCOPE_MISMATCH", approvalId: null });
}

export function evaluatePrerequisites(course, term, facts, bundle, {
  traceId,
  objectPath = "$",
  availableCourses = new Set(),
  sameTermCourses = new Set(),
  approvalInstances = [],
  historical = false,
  uncertainTiming = false,
  evaluationDate = null
} = {}) {
  const code = upper(course?.course || course);
  const termId = term?.termId || null;
  const termLabel = term?.term || term?.label || null;
  const rule = bundle.rules.find(candidate => candidate.ruleType === "coursePrerequisite" && candidate.condition.course === code);
  if (!rule) return createDecision({ bundle, traceId, status: "ALLOW", classification: "HARD", ruleIds: [], reasonCode: "NO_DECLARED_PREREQUISITE", subject: { course: code, termId }, objectPath });

  const prerequisiteClaims = Array.isArray(course?.prerequisiteClaims)
    ? course.prerequisiteClaims
    : [];
  const attachedApprovals = Array.isArray(course?.approvalRequired)
    ? course.approvalRequired
    : course?.approvalRequired
      ? [course.approvalRequired]
      : [];
  const attached = attachedApprovals.map(approval => ({ ...approval, _attachedRequired: true }));
  const approvals = [...approvalInstances, ...attached];
  const unresolved = [];
  const unresolvedAlternatives = [];
  const permissionResults = [];

  const concurrentPermission = prerequisite => {
    const permissionRule = bundle.rules.find(candidate => candidate.ruleType === "permissionException"
      && candidate.condition.dependentCourse === code
      && (candidate.condition.concurrentOptions || []).includes(prerequisite));
    if (!permissionRule || !sameTermCourses.has(prerequisite)) return null;
    if (permissionRule.condition.requiresCompletedFromOptions) {
      const completed = permissionRule.condition.concurrentOptions.filter(option => availableCourses.has(option)).length;
      const concurrent = permissionRule.condition.concurrentOptions.filter(option => sameTermCourses.has(option) && !availableCourses.has(option)).length;
      if (completed < permissionRule.condition.requiresCompletedFromOptions || concurrent > permissionRule.condition.maxConcurrent) return null;
    }
    return evaluatePermission(permissionRule, approvals, { prerequisite, termId, termLabel, evaluationDate });
  };

  for (const prerequisite of rule.effect.allOf || []) {
    if (availableCourses.has(prerequisite)) continue;
    const permission = concurrentPermission(prerequisite);
    if (permission && permission.status !== "BLOCK") permissionResults.push(permission);
    else {
      unresolved.push(prerequisite);
      unresolvedAlternatives.push([prerequisite]);
    }
  }
  for (const group of rule.effect.oneOfGroups || []) {
    if (group.some(prerequisite => availableCourses.has(prerequisite))
      || requirementPlaceholderSatisfies(group, availableCourses, bundle)) continue;
    const permission = group.map(concurrentPermission).find(result => result && result.status !== "BLOCK");
    if (permission) permissionResults.push(permission);
    else {
      unresolved.push(...group);
      unresolvedAlternatives.push(requirementPlaceholderSatisfies(group, sameTermCourses, bundle) ? [...group, "REQUIREMENT_PLACEHOLDER"] : group);
    }
  }

  const requiredPermission = bundle.rules.find(candidate => candidate.ruleType === "permissionException"
    && candidate.condition.course === code
    && candidate.effect.required);
  if (requiredPermission) {
    const permission = evaluatePermission(requiredPermission, approvals, { termId, termLabel, evaluationDate });
    if (permission.status === "BLOCK") {
      unresolved.push("DEPARTMENT_PERMISSION");
      unresolvedAlternatives.push(["DEPARTMENT_PERMISSION"]);
    }
    else permissionResults.push(permission);
  }

  const unresolvedSet = new Set(unresolved);
  const timingOnlyUnresolved = uncertainTiming
    && unresolved.length > 0
    && unresolvedAlternatives.every(options => options.some(prerequisite => (
      prerequisite !== "DEPARTMENT_PERMISSION"
        && (prerequisite === "REQUIREMENT_PLACEHOLDER" || sameTermCourses.has(prerequisite))
    )));
  const historicalReview = historical && unresolved.length;
  if (historicalReview) {
    return createPolicyReviewDecision({
      bundle,
      traceId,
      course: code,
      termId,
      objectPath,
      ruleIds: ["REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE"],
      reasonCode: "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW",
      requiredEvidence: [...unresolvedSet],
      messageParams: { missing: [...new Set(unresolved)] }
    });
  }
  if (prerequisiteClaims.length) {
    return createPolicyReviewDecision({
      bundle,
      traceId,
      course: code,
      termId,
      objectPath,
      ruleIds: prerequisiteClaims.map(claim => prerequisiteClaimReviewRuleId(claim, rule)),
      reasonCode: "PREREQUISITE_CLAIM_SCOPE_REVIEW",
      requiredEvidence: ["DOCUMENTED_AUTHORITY_AND_SCOPE"],
      messageParams: {
        claims: prerequisiteClaims.map(claim => ({
          kind: lower(claim?.kind) || null,
          prerequisite: upper(claim?.prerequisite) || null
        }))
      }
    });
  }
  const conditional = !unresolved.length && permissionResults.some(result => result.status === "CONDITIONAL");
  const status = timingOnlyUnresolved
      ? "PRELIMINARY"
      : unresolved.length
        ? "BLOCK"
        : conditional
          ? "CONDITIONAL"
          : "ALLOW";
  const controllingRules = [rule.ruleId, ...permissionResults.map(result => result.ruleId), ...(requiredPermission ? [requiredPermission.ruleId] : [])];
  const reasonCode = timingOnlyUnresolved
      ? "PREREQUISITE_SEQUENCE_TERM_TO_BE_CONFIRMED"
    : unresolved.length
      ? "PREREQUISITE_NOT_SATISFIED"
      : conditional
        ? "PREREQUISITES_CONDITIONAL_ON_APPROVAL"
        : "PREREQUISITES_SATISFIED";
  return createDecision({
    bundle,
    traceId,
    status,
    classification: "HARD",
    ruleIds: controllingRules,
    reasonCode,
    subject: { course: code, termId },
    objectPath,
    messageKeys: rule?.messageKeys || {},
    messageParams: { missing: [...new Set(unresolved)] },
    sourceRefs: rule?.sourceRefs || [],
    requiredEvidence: [...unresolvedSet],
    requiredApproval: conditional || unresolved.includes("DEPARTMENT_PERMISSION")
      ? permissionResults[0]?.ruleId || requiredPermission?.ruleId || null
      : null
  });
}
