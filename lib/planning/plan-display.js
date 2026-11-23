import { normalizeStudentCourses } from "../requirements/normalize.js";

export function feasibilityMeaning(status) {
  return ({
    VERIFIED_FEASIBLE: "The course placements are confirmed. Check that seats are open before you register.",
    CONDITIONALLY_FEASIBLE: "Check seats and future schedules before you register.",
    PRELIMINARY_ONLY: "Some future classes are based on preliminary schedules and may change.",
    SEARCH_INCOMPLETE: "The planner has not found a complete schedule yet.",
    NOT_FEASIBLE: "This plan has a requirement that still needs attention."
  })[status] || "Check this plan with your advisor.";
}

export function planTermsWithCurrentCourses(plan = {}, studentCourses = [], courseCatalog = []) {
  const terms = plan.terms || [];
  const current = normalizeStudentCourses(studentCourses).filter(course => course.status === "in_progress");
  const context = plan.planningContext || {};
  const year = Number(context.currentAcademicYearStart);
  const season = context.startTerm;
  if (!current.length || !Number.isInteger(year) || !["Fall", "Winter", "May"].includes(season)) return terms;
  const termYear = year + (season === "Fall" ? 0 : 1);
  const slotId = `${season === "May" ? "spring" : season.toLowerCase()}-${termYear}`;
  const titleByCode = new Map(courseCatalog.map(course => [course.code, course.title]));
  const entered = current.map(course => ({ course: course.code, title: titleByCode.get(course.code) || course.title || course.code,
    fixedInProgress: true, displayOnlyCurrent: true, source: "student-record", planningMarkers: [] }));
  const existing = terms.find(term => term.slotId === slotId);
  if (existing) return terms.map(term => term !== existing ? term : { ...term,
    courses: [...(term.courses || []), ...entered.filter(course => !(term.courses || []).some(item => item.course === course.course))] });
  const label = `${season === "May" ? "Spring/May" : season} ${termYear}`;
  return [{ slotId, term: label, displayTerm: label, termKey: season, academicYear: `${year}/${year + 1}`,
    publicationStatus: "STUDENT_CURRENT_TERM", courses: entered }, ...terms];
}
