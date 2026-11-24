"use client";

import { buildPlanningSlots } from "../lib/planning/horizon.js";
import { economicsResultFromReport } from "../lib/planning/uiState.js";
import economicsCourseData from "../data/normalized/economics/courses.json";

const COURSE_CATALOG = economicsCourseData.courses || [];

const COURSE_PREREQUISITES = Object.fromEntries(COURSE_CATALOG
  .filter(course => (
    (course.prerequisites?.all || []).length
    || (course.prerequisites?.any || []).length
  ))
  .map(course => [course.code, course.prerequisites]));

function isTaken(course) {
  return course.status === "completed" || course.status === "transfer";
}

function courseTitle(code) {
  return COURSE_CATALOG.find(course => course.code === code)?.title || code;
}

function economicsResult(report) {
  return economicsResultFromReport(report);
}

function planCourseIdentity(course) {
  return course.requirementId || `${course.course}-${course.source || "course"}`;
}

function formatAcademicYear(value) {
  return value ? String(value).replace("-", "/") : "Academic year";
}

function planningSlotsLabel(slotId, planningContext) {
  return buildPlanningSlots(planningContext).find(slot => slot.id === slotId)?.label || slotId;
}

function compactPlanCourse(course) {
  if (course.course === "ECO elective" && course.minimumLevel >= 200) return "Economics elective (200 level or higher)";
  return course.section ? `${course.course}-${course.section}` : course.course;
}

function planReadinessLabel(plan) {
  const readiness = plan?.readinessStatus || plan?.validation?.readinessStatus || "";
  const disposition = plan?.planDisposition || plan?.validation?.planDisposition || "";
  if (readiness === "ADVISOR_ACTION_REQUIRED" || disposition.includes("ADVISOR_ACTION_REQUIRED")) {
    return "Needs advisor attention";
  }
  if (readiness === "READY_WITH_CONDITIONS" || disposition.includes("READY_WITH_CONDITIONS")) {
    return "Needs confirmation";
  }
  if (readiness === "STUDENT_READY" || disposition.includes("STUDENT_READY")) return "Ready to plan";
  return "Needs advisor attention";
}

export { COURSE_CATALOG, COURSE_PREREQUISITES, isTaken, courseTitle, economicsResult, planCourseIdentity, planningSlotsLabel, compactPlanCourse, planReadinessLabel, formatAcademicYear };
