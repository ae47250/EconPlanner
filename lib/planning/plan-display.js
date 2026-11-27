import { normalizeStudentCourses } from "../requirements/normalize.js";
import { displayMessage, takingNowWithMathNeedsApproval } from "./student-language.js";
import { planNeedsPetition } from "../catalog/planning-requirements-note.js";

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
    fixedInProgress: true, displayOnlyCurrent: true, source: "student-record",
    planningMarkers: takingNowWithMathNeedsApproval(course.code, current) ? ["Approval required"] : [] }));
  const existing = terms.find(term => term.slotId === slotId);
  if (existing) return terms.map(term => term !== existing ? term : { ...term,
    courses: [...(term.courses || []), ...entered.filter(course => !(term.courses || []).some(item => item.course === course.course))] });
  const label = `${season === "May" ? "Spring/May" : season} ${termYear}`;
  return [{ slotId, term: label, displayTerm: label, termKey: season, academicYear: `${year}/${year + 1}`,
    publicationStatus: "STUDENT_CURRENT_TERM", courses: entered }, ...terms];
}

// The plan meets every rule apart from a possible catalog petition (same lookup as planReadinessLabel).
export function planIsStudentReady(plan) {
  const readiness = plan?.readinessStatus || plan?.validation?.readinessStatus || "";
  const disposition = plan?.planDisposition || plan?.validation?.planDisposition || "";
  if (readiness === "ADVISOR_ACTION_REQUIRED" || disposition.includes("ADVISOR_ACTION_REQUIRED")) return false;
  if (readiness === "READY_WITH_CONDITIONS" || disposition.includes("READY_WITH_CONDITIONS")) return false;
  return readiness === "STUDENT_READY" || disposition.includes("STUDENT_READY");
}

// One plan status for the screen and the PDF (owner request 2026-11-26: they read the same rule).
// A plan that meets the current rules but needs a catalog petition is not "Ready to plan".
export function planReadinessLabel(plan) {
  const readiness = plan?.readinessStatus || plan?.validation?.readinessStatus || "";
  const disposition = plan?.planDisposition || plan?.validation?.planDisposition || "";
  if (readiness === "ADVISOR_ACTION_REQUIRED" || disposition.includes("ADVISOR_ACTION_REQUIRED")) {
    return "Needs advisor attention";
  }
  if (readiness === "READY_WITH_CONDITIONS" || disposition.includes("READY_WITH_CONDITIONS")) {
    return "Needs confirmation";
  }
  if (readiness === "STUDENT_READY" || disposition.includes("STUDENT_READY")) {
    return planNeedsPetition(plan) ? "Needs confirmation" : "Ready to plan";
  }
  return "Needs advisor attention";
}

// "Graduating one year early" is said only when a one-year-early plan was offered (screen and PDF).
export function oneYearEarlyPlanOffered(plans = []) {
  return (plans || []).some(plan => plan?.id === "one-year-early");
}

// The sentence under a plan's status, chosen from the status itself (owner request 2026-11-27).
// Before, every plan got the schedule sentence, so "Needs confirmation" never said what to confirm.
export function planStatusExplanation(plan, messages) {
  const label = planReadinessLabel(plan);
  const conditions = plan?.planConditions || [];
  if (label === "Ready to plan") {
    // Without a schedule finding, use the ordinary "check seats" sentence rather than "check with your advisor".
    const known = ["VERIFIED_FEASIBLE", "CONDITIONALLY_FEASIBLE", "PRELIMINARY_ONLY"].includes(plan?.feasibilityStatus);
    const schedule = feasibilityMeaning(known ? plan.feasibilityStatus : "CONDITIONALLY_FEASIBLE");
    return displayMessage(messages, "planStatus.ready", { schedule });
  }
  // The reason itself is listed in the notes (and in the screen summary's "Why:" line), so it is not repeated here.
  if (label === "Needs advisor attention") {
    const advisor = displayMessage(messages, "planStatus.advisor");
    return planNeedsPetition(plan) ? `${advisor} ${displayMessage(messages, "planStatus.paperwork")}` : advisor;
  }
  if (planIsStudentReady(plan) && planNeedsPetition(plan)) return displayMessage(messages, "planStatus.petition");
  const items = [
    conditions.some(item => item.kind === "approval") && displayMessage(messages, "planStatus.confirmApproval"),
    conditions.some(item => item.kind === "standing") && displayMessage(messages, "planStatus.confirmStanding"),
    plan?.feasibilityStatus === "PRELIMINARY_ONLY" && displayMessage(messages, "planStatus.confirmSchedule")
  ].filter(Boolean);
  const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0];
  const sentence = items.length ? displayMessage(messages, "planStatus.confirm", { items: list }) : displayMessage(messages, "planStatus.checkNotes");
  // A petition on top of other conditions: say so in the same place.
  return planNeedsPetition(plan) ? `${sentence} ${displayMessage(messages, "planStatus.paperwork")}` : sentence;
}

// One line per course for the "previously offered" list. The screen and the PDF both list these lines,
// so their offering wording cannot drift (owner decision 2026-11-27).
export function courseOfferingLines(courses = [], courseLabel = course => course.course || course.code) {
  return [...new Map(courses.filter(course => course.offeringInformation?.label)
    .map(course => [courseLabel(course), course.offeringInformation.label])).entries()];
}
