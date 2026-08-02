import {
  evaluateStudentPrerequisites,
  selectedCourseStatus
} from "./prerequisiteEvaluator.js";

export function validateCoursePrerequisites({
  course,
  targetStatus,
  courses = [],
  prerequisites = {}
}) {
  const nextCourses = (courses || []).filter(item => item?.code !== course);
  nextCourses.push({ code: course, status: targetStatus });
  const result = evaluateStudentPrerequisites(nextCourses, prerequisites);
  const issues = result.issues.filter(issue => issue.course === course);
  const conditionalApprovals = result.conditionalApprovals.filter(approval => approval.course === course);
  return { valid: issues.length === 0, issues, conditionalApprovals };
}

export function validateStudentPrerequisites(courses = [], prerequisites = {}) {
  return evaluateStudentPrerequisites(courses, prerequisites);
}

export function selectedStatus(courses = [], code) {
  return selectedCourseStatus(courses, code);
}
