import { createHash } from "node:crypto";

const TERM_RANK = new Map([
  ["Fall", 0],
  ["Winter", 1],
  ["Spring/May", 2],
  ["Summer", 3]
]);

function text(value, { upper = false } = {}) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return upper ? normalized.toUpperCase() : normalized;
}

export function parseExternalAcademicYear(value) {
  const match = text(value)?.match(/^(\d{4})[/-](\d{4})$/);
  if (!match) return { valid: false, startYear: null, endYear: null, canonical: null };
  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  if (startYear < 1900 || endYear !== startYear + 1) {
    return { valid: false, startYear, endYear, canonical: null };
  }
  return {
    valid: true,
    startYear,
    endYear,
    canonical: `${startYear}-${endYear}`
  };
}

export function canonicalExternalTermKey(value) {
  const normalized = text(value)?.toLowerCase();
  if (normalized === "fall") return "Fall";
  if (normalized === "winter") return "Winter";
  if (["spring", "may", "spring/may"].includes(normalized)) return "Spring/May";
  if (normalized === "summer") return "Summer";
  if (["tbc", "term to be confirmed", "academic year tbc"].includes(normalized)) return "TBC";
  return null;
}

export function externalTermPosition(academicYear, termKey) {
  const parsedYear = parseExternalAcademicYear(academicYear);
  const canonicalTerm = canonicalExternalTermKey(termKey);
  if (parsedYear.valid && canonicalTerm === "TBC") return parsedYear.startYear * TERM_RANK.size;
  if (!parsedYear.valid || !TERM_RANK.has(canonicalTerm)) return null;
  return parsedYear.startYear * TERM_RANK.size + TERM_RANK.get(canonicalTerm);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, canonicalize(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function meaningfulApproval(approval) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return null;
  return {
    type: text(approval.type),
    course: text(approval.course, { upper: true }),
    prerequisite: text(approval.prerequisite, { upper: true }),
    reason: text(approval.reason),
    term: text(approval.term),
    sourceRef: text(approval.sourceRef)
  };
}

function sortedMeaningfulItems(items, mapper) {
  return (Array.isArray(items) ? items : [])
    .map(mapper)
    .filter(Boolean)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function meaningfulCourse(course) {
  if (!course || typeof course !== "object" || Array.isArray(course)) return null;
  const meeting = course.meeting && typeof course.meeting === "object" && !Array.isArray(course.meeting)
    ? course.meeting
    : {};
  return {
    course: text(course.course, { upper: true }),
    requirementId: text(course.requirementId),
    extra: course.extra === true,
    section: text(course.section, { upper: true }),
    selectedOptionId: text(course.selectedOptionId),
    source: text(course.source),
    offeringStatus: text(course.offeringStatus),
    verificationStatus: text(course.verificationStatus),
    availabilityStatus: text(course.availability?.status),
    meeting: {
      days: [...new Set((Array.isArray(meeting.days) ? meeting.days : []).map(day => text(day)).filter(Boolean))].sort(),
      startTime: text(meeting.startTime),
      endTime: text(meeting.endTime),
      startDate: text(meeting.startDate),
      endDate: text(meeting.endDate)
    },
    approvals: sortedMeaningfulItems(course.approvalRequired, meaningfulApproval)
  };
}

function meaningfulTerm(term) {
  if (!term || typeof term !== "object" || Array.isArray(term)) return null;
  const parsedYear = parseExternalAcademicYear(term.academicYear);
  const termKey = canonicalExternalTermKey(term.termKey || term.scheduleTerm || term.term);
  return {
    academicYear: parsedYear.valid ? parsedYear.canonical : text(term.academicYear),
    termKey: termKey || text(term.termKey || term.scheduleTerm || term.term),
    courses: sortedMeaningfulItems(term.courses, meaningfulCourse)
  };
}

function meaningfulTermSort(left, right) {
  const leftPosition = externalTermPosition(left.academicYear, left.termKey);
  const rightPosition = externalTermPosition(right.academicYear, right.termKey);
  if (leftPosition !== null && rightPosition !== null && leftPosition !== rightPosition) {
    return leftPosition - rightPosition;
  }
  if (leftPosition !== null && rightPosition === null) return -1;
  if (leftPosition === null && rightPosition !== null) return 1;
  return stableJson(left).localeCompare(stableJson(right));
}

function meaningfulCondition(condition) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return null;
  return {
    type: text(condition.type),
    course: text(condition.course, { upper: true }),
    term: text(condition.term),
    reason: text(condition.reason),
    status: text(condition.status)
  };
}

export function createExternalPlanSemanticSignature(plan, expectedContext = {}) {
  const safePlan = plan && typeof plan === "object" && !Array.isArray(plan) ? plan : {};
  const safeContext = expectedContext && typeof expectedContext === "object" && !Array.isArray(expectedContext)
    ? expectedContext
    : {};
  const terms = (Array.isArray(safePlan.terms) ? safePlan.terms : [])
    .map(meaningfulTerm)
    .filter(Boolean)
    .sort(meaningfulTermSort);
  const payload = {
    signatureVersion: 1,
    graduationHorizon: {
      startYear: Number.isInteger(safeContext.startYear) ? safeContext.startYear : null,
      remainingYears: Number.isInteger(safeContext.remainingYears) ? safeContext.remainingYears : null,
      expectedGraduationYear: Number.isInteger(safeContext.expectedGraduationYear)
        ? safeContext.expectedGraduationYear
        : null,
      expectedGraduationTerm: text(safeContext.expectedGraduationTerm)
    },
    feasibilityStatus: text(safePlan.feasibilityStatus || safePlan.feasibility?.overallStatus),
    requiredApprovals: sortedMeaningfulItems(
      safePlan.feasibility?.requiredApprovals || safePlan.requiredApprovals,
      meaningfulApproval
    ),
    enrollmentConditions: sortedMeaningfulItems(
      safePlan.feasibility?.enrollmentConditions || safePlan.enrollmentConditions,
      meaningfulCondition
    ),
    terms
  };
  const digest = createHash("sha256").update(stableJson(payload)).digest("hex");
  return `econ-plan-semantic-v1:${digest}`;
}
