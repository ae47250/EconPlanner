import {
  evaluateStudentPrerequisites
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
  const reviewFindings = (result.reviewFindings || []).filter(finding => finding.subject?.course === course);
  return { valid: issues.length === 0, status: issues.length ? "BLOCK" : reviewFindings.length ? "REVIEW_REQUIRED" : "ALLOW", issues, reviewFindings, conditionalApprovals };
}

export function validateStudentPrerequisites(courses = [], prerequisites = {}, options = {}) {
  return evaluateStudentPrerequisites(courses, prerequisites, options);
}
