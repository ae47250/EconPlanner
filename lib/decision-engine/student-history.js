import { createDecision, decisionTraceId } from "./contracts.js";
import { evaluatePrerequisites } from "./prerequisites.js";
import { normalizeStudentFacts, recordedCourseSets } from "./student-facts.js";
import { resolveReviewPolicyRecord } from "../policy/load-bundle.js";

const REVIEW_EVIDENCE = /transfer|equivalen|substitution|waiver|provisional|uncertain|\bap\b|ap[_ -]/i;

function sourceRefsForFact(fact) {
  return [fact.source?.sourceRef, fact.source?.url, fact.source?.id].filter(Boolean);
}

function explicitFactNeedsReview(fact) {
  const hasSource = sourceRefsForFact(fact).length > 0;
  const hasAuthority = Boolean(fact.authority?.name || fact.authority?.owner || fact.authority?.id);
  return !hasSource || !hasAuthority || !["VERIFIED", "APPROVED"].includes(fact.evidenceStatus);
}

function isOrdinaryCanonicalHanoverCourse(course, bundle) {
  return ["COMPLETED", "IN_PROGRESS"].includes(course.status)
    && Boolean(bundle.indexes?.coursesByCode?.[course.course])
    && !REVIEW_EVIDENCE.test(course.source);
}

function reviewDecision(bundle, traceId, course, ruleId, reasonCode, index, options = {}) {
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
    subject: { course: course.course, status: course.status, ...(options.subject || {}) },
    objectPath: options.objectPath || `$.courses[${index}]`,
    messageKeys: rule?.messageKeys || {},
    sourceRefs: [...new Set([...(rule?.sourceRefs || []), ...(options.sourceRefs || [])])],
    requiredEvidence: options.requiredEvidence || ["DOCUMENTED_AUTHORITY_AND_SCOPE"],
    responsibleAuthority: options.responsibleAuthority || "ACADEMIC_ADVISOR_OR_AUTHORIZED_DEPARTMENT",
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
    const expectedFactTypes = course.status === "COMPLETED"
      ? ["COMPLETED_COURSEWORK"]
      : course.status === "IN_PROGRESS"
        ? ["IN_PROGRESS_COURSEWORK"]
        : course.status === "TRANSFER"
          ? ["TRANSFER_COURSEWORK", "COURSE_EQUIVALENCY"]
          : [];
    const hasAuthoritativeFact = facts.evidenceFacts.some(fact => (
      fact.affectedCourse === course.course
      && expectedFactTypes.includes(fact.factType)
      && ["VERIFIED", "APPROVED"].includes(fact.evidenceStatus)
      && !explicitFactNeedsReview(fact)
    ));
    const ordinaryCanonicalHanoverCourse = isOrdinaryCanonicalHanoverCourse(course, bundle);
    if (expectedFactTypes.length && !hasAuthoritativeFact && !ordinaryCanonicalHanoverCourse) {
      decisions.push(reviewDecision(
        bundle,
        traceId,
        course,
        "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
        "COURSE_HISTORY_EVIDENCE_FACT_REQUIRED",
        index,
        {
          requiredEvidence: expectedFactTypes,
          responsibleAuthority: course.status === "TRANSFER" ? "REGISTRAR_OR_AUTHORIZED_DEPARTMENT" : "REGISTRAR"
        }
      ));
    }
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
    if (!ordinaryCanonicalHanoverCourse && (course.status === "UNCERTAIN" || REVIEW_EVIDENCE.test(`${course.status} ${course.source}`))) {
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

  for (const [index, fact] of facts.evidenceFacts.entries()) {
    if (!explicitFactNeedsReview(fact)) continue;
    decisions.push(reviewDecision(
      bundle,
      traceId,
      { course: fact.affectedCourse, status: fact.evidenceStatus },
      "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
      "EXPLICIT_EVIDENCE_FACT_REVIEW",
      index,
      {
        objectPath: `$.evidenceFacts[${index}]`,
        subject: { evidenceFactId: fact.factId, factType: fact.factType, requirementId: fact.affectedRequirement },
        sourceRefs: sourceRefsForFact(fact),
        requiredEvidence: ["AUTHORITATIVE_SOURCE", "AUTHORITY", "EFFECTIVE_SCOPE"],
        responsibleAuthority: fact.authority?.name || fact.authority?.owner || "ACADEMIC_ADVISOR_OR_AUTHORIZED_DEPARTMENT"
      }
    ));
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
