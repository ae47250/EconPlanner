import { createHash } from "node:crypto";
import { canonicalJson } from "../policy/canonical-json.js";

const STATUS = Object.freeze({
  completed: "COMPLETED",
  transfer: "TRANSFER",
  in_progress: "IN_PROGRESS",
  planned: "PLANNED",
  uncertain: "UNCERTAIN",
  repeated: "REPEATED",
  failed: "FAILED",
  withdrawn: "WITHDRAWN"
});

function text(value) {
  return String(value || "").trim();
}

export const EVIDENCE_FACT_TYPE = Object.freeze({
  COMPLETED_COURSEWORK: "COMPLETED_COURSEWORK",
  IN_PROGRESS_COURSEWORK: "IN_PROGRESS_COURSEWORK",
  TRANSFER_COURSEWORK: "TRANSFER_COURSEWORK",
  COURSE_EQUIVALENCY: "COURSE_EQUIVALENCY",
  REQUIREMENT_CREDIT_EQUIVALENCY: "REQUIREMENT_CREDIT_EQUIVALENCY",
  PREREQUISITE_SATISFACTION: "PREREQUISITE_SATISFACTION",
  ADVISOR_REVIEW: "ADVISOR_REVIEW",
  DEPARTMENT_APPROVAL: "DEPARTMENT_APPROVAL",
  INSTRUCTOR_APPROVAL: "INSTRUCTOR_APPROVAL",
  WAIVER: "WAIVER",
  SUBSTITUTION: "SUBSTITUTION"
});

function factId(value) {
  const identity = { ...value, factId: undefined };
  return `evidence-fact-${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex").slice(0, 20)}`;
}

function normalizeEvidenceFact(fact = {}, defaults = {}) {
  const source = typeof fact.source === "object" && fact.source !== null
    ? fact.source
    : { sourceRef: text(fact.source || defaults.source) || null };
  const authority = typeof fact.authority === "object" && fact.authority !== null
    ? fact.authority
    : { name: text(fact.authority || defaults.authority) || null };
  const normalized = {
    factType: text(fact.factType || fact.type).toUpperCase() || "UNKNOWN",
    affectedCourse: text(fact.affectedCourse || fact.course || defaults.course).toUpperCase() || null,
    affectedRequirement: text(fact.affectedRequirement || fact.requirementId || defaults.requirementId) || null,
    source,
    authority,
    evidenceStatus: text(fact.evidenceStatus || fact.status || defaults.evidenceStatus).toUpperCase() || "REVIEW_REQUIRED",
    effectiveScope: fact.effectiveScope && typeof fact.effectiveScope === "object"
      ? fact.effectiveScope
      : { purpose: text(fact.effectiveScope || defaults.effectiveScope).toUpperCase() || "UNSPECIFIED" },
    applicableTerm: fact.applicableTerm || defaults.applicableTerm || null,
    applicableCatalogYear: fact.applicableCatalogYear || defaults.applicableCatalogYear || null,
    provenance: fact.provenance || defaults.provenance || null
  };
  return Object.freeze({ factId: text(fact.factId) || factId(normalized), ...normalized });
}

function courseEvidenceFacts(course) {
  const facts = [];
  const defaults = {
    course: course.course,
    source: course.source,
    applicableTerm: course.termKey,
    applicableCatalogYear: course.catalogYear
  };
  if (course.completionEvidence) facts.push(normalizeEvidenceFact({
    factType: course.status === "IN_PROGRESS" ? EVIDENCE_FACT_TYPE.IN_PROGRESS_COURSEWORK : EVIDENCE_FACT_TYPE.COMPLETED_COURSEWORK,
    source: course.completionEvidence,
    authority: course.evidenceAuthority,
    evidenceStatus: course.completionEvidenceStatus || "VERIFIED",
    effectiveScope: { purpose: "COURSE_COMPLETION" }
  }, defaults));
  if (course.transferEvidence) facts.push(normalizeEvidenceFact({
    factType: EVIDENCE_FACT_TYPE.TRANSFER_COURSEWORK,
    source: course.transferEvidence,
    authority: course.evidenceAuthority,
    evidenceStatus: course.transferEvidenceStatus || "REVIEW_REQUIRED",
    effectiveScope: { purpose: "TRANSFER_COURSE_HISTORY" }
  }, defaults));
  if (course.requirementCreditEvidence) facts.push(normalizeEvidenceFact({
    factType: EVIDENCE_FACT_TYPE.REQUIREMENT_CREDIT_EQUIVALENCY,
    source: course.requirementCreditEvidence,
    authority: course.evidenceAuthority,
    evidenceStatus: course.requirementCreditEvidenceStatus || "REVIEW_REQUIRED",
    effectiveScope: { purpose: "REQUIREMENT_CREDIT_ONLY" }
  }, defaults));
  if (course.prerequisiteSatisfactionEvidence) facts.push(normalizeEvidenceFact({
    factType: EVIDENCE_FACT_TYPE.PREREQUISITE_SATISFACTION,
    source: course.prerequisiteSatisfactionEvidence,
    authority: course.evidenceAuthority,
    evidenceStatus: course.prerequisiteSatisfactionEvidenceStatus || "REVIEW_REQUIRED",
    effectiveScope: { purpose: "PREREQUISITE_SATISFACTION_ONLY" }
  }, defaults));
  return facts;
}

export function normalizeStudentFacts(input = {}) {
  const courses = (Array.isArray(input.courses) ? input.courses : []).map((course, index) => ({
    factId: `course-fact-${index + 1}`,
    course: text(course.code || course.course).toUpperCase(),
    status: STATUS[text(course.status).toLowerCase()] || text(course.status).toUpperCase() || "UNKNOWN",
    source: text(course.source).toUpperCase() || "UNKNOWN",
    units: Number(course.units ?? 1),
    academicYear: text(course.academicYear) || null,
    termKey: text(course.termKey) || null,
    prerequisiteEvidence: Array.isArray(course.prerequisiteEvidence)
      ? course.prerequisiteEvidence.map(value => text(value).toUpperCase()).filter(Boolean).sort()
      : [],
    completionEvidence: text(course.completionEvidence) || null,
    completionEvidenceStatus: text(course.completionEvidenceStatus).toUpperCase() || null,
    requirementCreditEvidence: text(course.requirementCreditEvidence || course.equivalencyCode) || null,
    requirementCreditEvidenceStatus: text(course.requirementCreditEvidenceStatus).toUpperCase() || null,
    prerequisiteSatisfactionEvidence: text(course.prerequisiteSatisfactionEvidence) || null,
    prerequisiteSatisfactionEvidenceStatus: text(course.prerequisiteSatisfactionEvidenceStatus).toUpperCase() || null,
    transferEvidence: text(course.transferEvidence) || null,
    transferEvidenceStatus: text(course.transferEvidenceStatus).toUpperCase() || null,
    evidenceAuthority: course.evidenceAuthority || null,
    catalogYear: text(course.catalogYear) || null,
    advisorReviewStatus: text(course.advisorReviewStatus).toUpperCase() || "NOT_REVIEWED",
    futureSchedulingIntent: text(course.futureSchedulingIntent) || null
  })).filter(course => course.course);
  const submittedFacts = (Array.isArray(input.evidenceFacts) ? input.evidenceFacts : []).map(fact => normalizeEvidenceFact(fact));
  const nestedFacts = courses.flatMap((course, index) => [
    ...courseEvidenceFacts(course),
    ...((Array.isArray(input.courses?.[index]?.evidenceFacts) ? input.courses[index].evidenceFacts : [])
      .map(fact => normalizeEvidenceFact(fact, { course: course.course, source: course.source })))
  ]);
  const evidenceFacts = [...new Map([...submittedFacts, ...nestedFacts].map(fact => [fact.factId, fact])).values()]
    .sort((left, right) => left.factId.localeCompare(right.factId));
  return Object.freeze({
    schemaVersion: "1.0.0",
    academicStanding: text(input.academicStanding).toUpperCase() || null,
    planningPace: text(input.planningPace).toUpperCase() || "STANDARD",
    planCreationDate: text(input.planCreationDate) || null,
    transferStudent: Boolean(input.isTransferStudent),
    transferEntryAcademicYear: text(input.transferEntryAcademicYear) || null,
    transferExpectedGraduationYear: text(input.transferExpectedGraduationYear) || null,
    projectedSeniorStandingConfirmation: input.projectedSeniorStandingConfirmation || null,
    reservedCourseUnits: input.reservedCourseUnits || {},
    approvals: Array.isArray(input.approvalInstances) ? input.approvalInstances : [],
    courses,
    evidenceFacts
  });
}

export function studentFactsHash(facts) {
  return createHash("sha256").update(canonicalJson(facts), "utf8").digest("hex");
}

export function recordedCourseSets(facts) {
  const completed = new Set(facts.courses.filter(course => ["COMPLETED", "TRANSFER"].includes(course.status)).map(course => course.course));
  const inProgress = new Set(facts.courses.filter(course => course.status === "IN_PROGRESS").map(course => course.course));
  return { completed, inProgress, availableForFuture: new Set([...completed, ...inProgress]) };
}
