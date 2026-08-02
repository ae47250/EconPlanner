import { normalizeStudentCourses } from "../requirements/normalize.js";
import { evaluateStudentPrerequisites, prerequisiteClosure } from "./prerequisiteEvaluator.js";

function activeCourseCodes(courses = []) {
  return new Set(
    courses
      .filter(course => ["completed", "in_progress", "transfer"].includes(course.status))
      .map(course => course.code)
      .filter(Boolean)
  );
}

function prerequisiteDepth(code, completedCodes, prerequisites, seen = new Set()) {
  if (completedCodes.has(code)) return 0;
  if (seen.has(code)) return 0;
  const rule = prerequisites?.[code];
  if (!rule) return 0;
  const nextSeen = new Set(seen).add(code);
  const allDepth = (rule.all || []).map(item => prerequisiteDepth(item, completedCodes, prerequisites, nextSeen));
  const anyDepth = (rule.any || []).map(group => Math.min(...group.map(item => prerequisiteDepth(item, completedCodes, prerequisites, nextSeen))));
  return 1 + Math.max(0, ...allDepth, ...anyDepth);
}

export function analyzeFeasibility({ student = {}, mapping, prerequisites = {} }) {
  const courses = normalizeStudentCourses(student.courses);
  const completedCodes = activeCourseCodes(courses);
  const prerequisiteReview = evaluateStudentPrerequisites(courses, prerequisites);
  const missingPrerequisites = prerequisiteReview.issues.map(issue => ({
    course: issue.course,
    missing: issue.options.join(" / ")
  }));

  const remainingCodes = (mapping?.projectedAfterInProgress?.optimistic?.unresolved || mapping?.optimistic?.unresolved || [])
    .flatMap(item => item.options || [])
    .filter(Boolean);
  const minimumRegularTerms = remainingCodes.length
    ? Math.max(...remainingCodes.map(code => Math.max(
        prerequisiteDepth(code, completedCodes, prerequisites),
        prerequisiteClosure(code, prerequisites).size ? 1 : 0
      )))
    : 0;

  const reasons = [...new Set(missingPrerequisites.map(item => `Missing prerequisite for ${item.course}: ${item.missing}`))];
  return {
    missingPrerequisites: [...new Set(missingPrerequisites.map(item => JSON.stringify(item)))].map(item => JSON.parse(item)),
    minimumRegularTerms,
    riskReasons: reasons
  };
}
