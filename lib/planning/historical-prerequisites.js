// Presentation of recorded history against canonical prerequisite rules. This
// never changes a course's credit or the planner's placement decision.
export function historicalPrerequisiteGaps(course, courses = [], rules = []) {
  const rule = rules.find(item => item.ruleType === "coursePrerequisite" && item.condition?.course === course);
  if (!rule) return [];
  const statuses = new Map(courses.map(item => [item.code, item.status]));
  const completed = code => ["completed", "transfer"].includes(statuses.get(code));
  const gap = options => ({
    course,
    label: options.join(" or "),
    options,
    takingNow: options.some(code => statuses.get(code) === "in_progress")
  });
  return [
    ...(rule.effect?.allOf || []).filter(code => !completed(code)).map(code => gap([code])),
    ...(rule.effect?.oneOfGroups || []).filter(group => !group.some(completed)).map(gap)
  ];
}

export function historicalPrerequisiteMessage(gap) {
  if (gap.takingNow) return `You marked ${gap.course} completed, but ${gap.label}, which comes before it, is marked Taking now. If that was a mistake, change one of them. If it is correct (for example, you are retaking ${gap.label}), keep both and your advisor will check it.`;
  return `You marked ${gap.course} completed, but ${gap.label}, which comes before it, is not marked completed. If you finished ${gap.label} or have transfer/AP credit for it, mark it. Otherwise your advisor will check it.`;
}

export function historicalPrerequisiteSummary(gaps) {
  if (!gaps.length) return "";
  return `${historicalPrerequisiteMessage(gaps[0])}${gaps.length > 1 ? ` and ${gaps.length - 1} more` : ""}`;
}

export function scheduledAfterCompletedMarker(code, courses = [], rules = []) {
  const completed = courses.filter(item => ["completed", "transfer"].includes(item.status));
  const dependent = completed.find(item => historicalPrerequisiteGaps(item.code, courses, rules)
    .some(gap => gap.options.includes(code)));
  return dependent ? `Scheduled after ${dependent.code}, which you marked completed. Check with your advisor.` : null;
}
