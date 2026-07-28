function activeCourseCodes(courses = []) {
  return new Set(
    courses
      .filter(course => ["completed", "in_progress", "transfer"].includes(course.status))
      .map(course => course.code)
      .filter(Boolean)
  );
}

function hasAny(codes, options) {
  return options.some(code => codes.has(code));
}

function coursePrerequisiteMissing(code, completedCodes, prerequisites) {
  const rule = prerequisites?.[code];
  if (!rule) return [];
  const missing = rule.all.filter(required => !completedCodes.has(required));
  for (const group of rule.any || []) {
    if (!hasAny(completedCodes, group)) missing.push(group.join(" / "));
  }
  return missing;
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
  const courses = Array.isArray(student.courses) ? student.courses : [];
  const completedCodes = activeCourseCodes(courses);
  const options = mapping?.assignments || [];
  const missingPrerequisites = [];

  for (const assignment of options) {
    for (const missing of coursePrerequisiteMissing(assignment.code, completedCodes, prerequisites)) {
      missingPrerequisites.push({ course: assignment.code, missing });
    }
  }

  const remainingCodes = (mapping?.optimistic?.unresolved || [])
    .flatMap(item => item.options || [])
    .filter(Boolean);
  const minimumRegularTerms = remainingCodes.length
    ? Math.max(...remainingCodes.map(code => prerequisiteDepth(code, completedCodes, prerequisites)))
    : 0;

  const reasons = [...new Set(missingPrerequisites.map(item => `Missing prerequisite for ${item.course}: ${item.missing}`))];
  return {
    missingPrerequisites: [...new Set(missingPrerequisites.map(item => JSON.stringify(item)))].map(item => JSON.parse(item)),
    minimumRegularTerms,
    riskReasons: reasons
  };
}
