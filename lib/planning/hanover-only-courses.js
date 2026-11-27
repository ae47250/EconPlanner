import economicsCourseData from "../../data/normalized/economics/courses.json" with { type: "json" };
import { isWinterTermDate, resolvePlanningContext } from "./horizon.js";

// Courses that must be taken at Hanover College (today: ECO 461).
export const HANOVER_ONLY_COURSE_CODES = new Set(economicsCourseData.courses
  .filter(course => course.studentSelectable === false).map(course => course.code));

function courseCode(course) {
  return String(course?.code || "").trim().toUpperCase().replace(/^([A-Z]{2,5})\s*-?\s*(\d{3})$/, "$1 $2");
}

// The one answer to "may this student mark a Hanover-only course with this status?", used by the server
// rule below and by the course form (app/page.js), so the two cannot disagree (owner request 2026-11-27).
export function hanoverOnlyStatusAllowed(student = {}, status) {
  let senior = false;
  let winterTerm = false;
  try {
    const context = resolvePlanningContext(student);
    senior = context.effectiveStanding === "senior";
    // Owner decision (Nov 25, 2026, update): a senior may also mark ECO 461 "taking now",
    // but only during a Winter term, the only term it is offered.
    winterTerm = !context.isSummer && Boolean(student.planCreationDate) && isWinterTermDate(student.planCreationDate);
  } catch { senior = false; }
  const value = String(status || "").toLowerCase();
  return senior && (value === "completed" || (value === "in_progress" && winterTerm));
}

// Owner decision (Nov 25, 2026, policy/provenance/owner-eco461-completed-2026-11-25.md):
// a Hanover-only course counts as recorded history only when the student's effective
// standing is senior and it is completed, or taken now during a Winter term. Every server path applies this one rule so the
// browser, the ChatGPT tools and direct API calls agree.
export function applyHanoverOnlyCourseRule(student = {}) {
  const courses = Array.isArray(student.courses) ? student.courses : [];
  if (!courses.some(course => HANOVER_ONLY_COURSE_CODES.has(courseCode(course)))) return student;
  const allowed = status => hanoverOnlyStatusAllowed(student, status);
  return {
    ...student,
    courses: courses.filter(course => !HANOVER_ONLY_COURSE_CODES.has(courseCode(course))
      || allowed(String(course?.status || "").toLowerCase()))
      .map(course => HANOVER_ONLY_COURSE_CODES.has(courseCode(course))
        ? { ...course, code: courseCode(course), status: String(course.status).toLowerCase(), source: "manual_code" } : course)
  };
}
