import { createDecision, decisionTraceId } from "./contracts.js";
import { evaluatePrerequisites } from "./prerequisites.js";
import { normalizeStudentFacts, recordedCourseSets } from "./student-facts.js";
import { resolveReviewPolicyRecord } from "../policy/load-bundle.js";

const REVIEW_EVIDENCE = /transfer|equivalen|substitution|waiver|provisional|uncertain|\bap\b|ap[_ -]/i;

function reviewDecision(bundle, traceId, course, ruleId, reasonCode, index) {
  const activeRule = bundle.indexes.byRuleId[ruleId];
  const reviewRecord = activeRule ? null : resolveReviewPolicyRecord(bundle, ruleId);
  const rule = activeRule || reviewRecord;
  return createDecision({
    bundle,
    traceId,
    status: "REVIEW_REQUIRED",
    classification: "REVIEW",
    ruleIds: rule ? [rule.ruleId] : [],
    reasonCode,
    subject: { course: course.course, status: course.status },
    objectPath: `$.courses[${index}]`,
    messageKeys: rule?.messageKeys || {},
    sourceRefs: rule?.sourceRefs || [],
    requiredEvidence: ["DOCUMENTED_AUTHORITY_AND_SCOPE"],
    policyDisposition: reviewRecord ? {
      disposition: reviewRecord.disposition,
      enforcement: reviewRecord.enforcement,
      status: reviewRecord.status,
      requiredDisposition: reviewRecord.requiredDisposition
    } : null,
    provenance: reviewRecord?.provenance || []
  });
}

export function auditStudentHistory(input = {}, bundle, { traceId = decisionTraceId({ input, bundle: bundle.contentHash }) } = {}) {
  const facts = normalizeStudentFacts(input);
  const decisions = [];
  const { completed } = recordedCourseSets(facts);

  for (const [index, course] of facts.courses.entries()) {
    if (["COMPLETED", "TRANSFER"].includes(course.status)) {
      const prerequisite = evaluatePrerequisites(course, {}, facts, bundle, {
        traceId,
        objectPath: `$.courses[${index}]`,
        availableCourses: new Set([...completed].filter(code => code !== course.course)),
        sameTermCourses: new Set(),
        approvalInstances: facts.approvals,
        historical: true
      });
      if (prerequisite.status === "REVIEW_REQUIRED") decisions.push(prerequisite);
    }
    if (course.status === "UNCERTAIN" || REVIEW_EVIDENCE.test(`${course.status} ${course.source}`)) {
      decisions.push(reviewDecision(
        bundle,
        traceId,
        course,
        "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
        "COURSE_EVIDENCE_SCOPE_REVIEW",
        index
      ));
    }
  }

  return Object.freeze({
    facts,
    retainedCourses: facts.courses,
    decisions,
    reviewFindings: decisions.filter(decision => decision.status === "REVIEW_REQUIRED"),
    blockingFindings: decisions.filter(decision => decision.status === "BLOCK"),
    valid: !decisions.some(decision => decision.status === "BLOCK")
  });
}
