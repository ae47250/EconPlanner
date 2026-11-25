import economicsCourseData from "../../data/normalized/economics/courses.json" with { type: "json" };
import { resolvePlanningContext } from "./horizon.js";

// Courses that must be taken at Hanover College (today: ECO 461).
export const HANOVER_ONLY_COURSE_CODES = new Set(economicsCourseData.courses
  .filter(course => course.studentSelectable === false).map(course => course.code));

function courseCode(course) {
  return String(course?.code || "").trim().toUpperCase().replace(/^([A-Z]{2,5})\s*-?\s*(\d{3})$/, "$1 $2");
}

// Owner decision (Nov 25, 2026, policy/provenance/owner-eco461-completed-2026-11-25.md):
// a Hanover-only course counts as recorded history only when the student's effective
// standing is senior and it is completed, or taken now during a Winter term. Every server path applies this one rule so the
// browser, the ChatGPT tools and direct API calls agree.
export function applyHanoverOnlyCourseRule(student = {}) {
  const courses = Array.isArray(student.courses) ? student.courses : [];
  if (!courses.some(course => HANOVER_ONLY_COURSE_CODES.has(courseCode(course)))) return student;
  let senior = false;
  let winterTerm = false;
  try {
    const context = resolvePlanningContext(student);
    senior = context.effectiveStanding === "senior";
    // Owner decision (Nov 25, 2026, update): a senior may also mark ECO 461 "taking now",
    // but only during a Winter term, the only term it is offered.
    winterTerm = !context.isSummer && context.startTerm === "Winter";
  } catch { senior = false; }
  const allowed = status => senior && (status === "completed" || (status === "in_progress" && winterTerm));
  return {
    ...student,
    courses: courses.filter(course => !HANOVER_ONLY_COURSE_CODES.has(courseCode(course))
      || allowed(String(course?.status || "").toLowerCase()))
      .map(course => HANOVER_ONLY_COURSE_CODES.has(courseCode(course))
        ? { ...course, code: courseCode(course), status: String(course.status).toLowerCase(), source: "manual_code" } : course)
  };
}
