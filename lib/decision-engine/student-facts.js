import { createHash } from "node:crypto";
import { canonicalJson } from "../policy/canonical-json.js";

const STATUS = Object.freeze({
  completed: "COMPLETED",
  transfer: "TRANSFER",
  in_progress: "IN_PROGRESS",
  planned: "PLANNED"
});

function text(value) {
  return String(value || "").trim();
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
      : []
  })).filter(course => course.course);
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
    courses
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
