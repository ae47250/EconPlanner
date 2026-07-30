import economicsCourseData from "../../data/normalized/economics/courses.json" with { type: "json" };

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

const CANONICAL_COURSES = Object.freeze(economicsCourseData.courses || []);
const COURSE_BY_CODE = new Map(CANONICAL_COURSES.map(course => [course.code, course]));
const COURSE_CODE_ALIASES = new Map(CANONICAL_COURSES.flatMap(course => (
  (course.aliases || []).map(alias => [alias, course.code])
)));
const TITLE_ALIASES = CANONICAL_COURSES.map(course => [
  course.code,
  [course.title, ...(course.titleAliases || [])].map(value => String(value).toLowerCase())
]);
const STATUS_PRIORITY = Object.freeze({
  completed: 7,
  transfer: 6,
  in_progress: 5,
  uncertain: 4,
  repeated: 3,
  failed: 2,
  withdrawn: 1
});

export function normalizeCourseCode(value) {
  const text = String(value || "").toUpperCase().trim();
  const match = text.match(COURSE_CODE_PATTERN);
  if (!match) return "";
  const normalized = `${match[1]} ${match[2]}`;
  return COURSE_CODE_ALIASES.get(normalized) || normalized;
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
  const canonicalCourse = COURSE_BY_CODE.get(inferredCode);

  return {
    id: String(course.id || `course-${index + 1}`),
    code: inferredCode,
    title: String(course.title || canonicalCourse?.title || "").trim(),
    status,
    grade: String(course.grade || "").trim(),
    units: Number.isFinite(numericUnits) && numericUnits > 0 ? numericUnits : Number(canonicalCourse?.units || 1),
    source: String(course.source || (rawCode ? "manual_code" : "title_only")),
    notes: String(course.notes || "").trim()
  };
}

export function normalizeStudentCourses(courses = []) {
  const normalized = (Array.isArray(courses) ? courses : []).map(normalizeStudentCourse).filter(course => {
    return course.code || course.title || course.notes;
  });
  const byCanonicalCourse = new Map();

  for (const course of normalized) {
    const key = course.code || `unmatched:${course.id}`;
    const existing = byCanonicalCourse.get(key);
    if (!existing) {
      byCanonicalCourse.set(key, course);
      continue;
    }

    const currentPriority = STATUS_PRIORITY[course.status] || 0;
    const existingPriority = STATUS_PRIORITY[existing.status] || 0;
    const selected = currentPriority > existingPriority ? course : existing;
    byCanonicalCourse.set(key, {
      ...selected,
      id: existing.id,
      units: Math.max(existing.units || 0, course.units || 0),
      notes: [existing.notes, course.notes].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).join("; ")
    });
  }

  return [...byCanonicalCourse.values()];
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

export function canonicalEconomicsCourses() {
  return CANONICAL_COURSES.map(course => structuredClone(course));
}
