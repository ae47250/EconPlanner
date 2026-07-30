const COURSE_CODE_PATTERN = /\b([A-Z]{2,5})\s*-?\s*(\d{3})\b/i;

export const EVIDENCE_STATUSES = Object.freeze({
  VERIFIED: "VERIFIED",
  PROVISIONAL: "PROVISIONAL",
  INFERRED: "INFERRED",
  CONFLICTING: "CONFLICTING",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  DUPLICATE_OR_UNUSED: "DUPLICATE_OR_UNUSED"
});

export const COURSE_STATUSES = Object.freeze([
  "completed",
  "in_progress",
  "transfer",
  "repeated",
  "failed",
  "withdrawn",
  "uncertain"
]);

const COURSE_CODE_ALIASES = Object.freeze({
  "PHI 234": "ECO 234"
});

const TITLE_ALIASES = [
  ["ECO 113", ["principles of microeconomics"]],
  ["ECO 114", ["principles of macroeconomics"]],
  ["ECO 161", ["foundations of economics"]],
  ["ECO 213", ["intermediate microeconomics"]],
  ["ECO 214", ["intermediate macroeconomics"]],
  ["ECO 221", ["environmental economics"]],
  ["ECO 222", ["economics of the european union"]],
  ["ECO 234", ["rational choices"]],
  ["ECO 257", ["quantitative methods"]],
  ["ECO 321", ["money & financial markets", "money and financial markets"]],
  ["ECO 331", ["labor economics"]],
  ["ECO 333", ["international trade & finance", "international trade and finance"]],
  ["ECO 461", ["senior seminar - econometrics", "senior seminar: econometrics", "econometrics"]],
  ["ECO 471", ["senior thesis"]]
];

export function normalizeCourseCode(value) {
  const text = String(value || "").toUpperCase().trim();
  const match = text.match(COURSE_CODE_PATTERN);
  if (!match) return "";
  const normalized = `${match[1]} ${match[2]}`;
  return COURSE_CODE_ALIASES[normalized] || normalized;
}

export function inferCourseCodeFromTitle(value) {
  const text = String(value || "").toLowerCase();
  const matches = TITLE_ALIASES.filter(([, aliases]) => aliases.some(alias => text.includes(alias)));
  return matches.length === 1 ? matches[0][0] : "";
}

export function normalizeStudentCourse(course = {}, index = 0) {
  const rawCode = normalizeCourseCode(course.code || course.equivalencyCode);
  const inferredCode = rawCode || inferCourseCodeFromTitle(course.title);
  const status = COURSE_STATUSES.includes(course.status) ? course.status : "uncertain";
  const numericUnits = Number(course.units);

  return {
    id: String(course.id || `course-${index + 1}`),
    code: inferredCode,
    title: String(course.title || "").trim(),
    status,
    grade: String(course.grade || "").trim(),
    units: Number.isFinite(numericUnits) && numericUnits > 0 ? numericUnits : 1,
    source: String(course.source || (rawCode ? "manual_code" : "title_only")),
    notes: String(course.notes || "").trim()
  };
}

export function normalizeStudentCourses(courses = []) {
  return (Array.isArray(courses) ? courses : []).map(normalizeStudentCourse).filter(course => {
    return course.code || course.title || course.notes;
  });
}

export function isActiveCourse(course) {
  return ["completed", "in_progress", "transfer", "uncertain"].includes(course.status);
}

export function isInProgressCourse(course) {
  return course.status === "in_progress";
}

export function isCompletedForCurrent(course) {
  return course.status === "completed";
}

export function isProvisionalCourse(course) {
  return course.status === "transfer" || course.status === "uncertain" || /provisional|equivalency/i.test(course.source);
}

export function isLevel100(code) {
  return /^\w+ 1\d\d$/.test(code);
}
