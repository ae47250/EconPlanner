// Presentation of recorded history against canonical prerequisite rules. This
// never changes a course's credit or the planner's placement decision.
export function historicalPrerequisiteGaps(course, courses = [], rules = []) {
  const rule = rules.find(item => item.ruleType === "coursePrerequisite" && item.condition?.course === course);
  if (!rule) return [];
  const statuses = new Map(courses.map(item => [item.code, item.status]));
  const dependentStatus = statuses.get(course);
  const completed = code => ["completed", "transfer"].includes(statuses.get(code))
    || (dependentStatus === "in_progress" && statuses.get(code) === "in_progress");
  const gap = options => ({
    course,
    label: options.join(" or "),
    options,
    takingNow: options.some(code => statuses.get(code) === "in_progress"),
    dependentInProgress: dependentStatus === "in_progress"
  });
  return [
    ...(rule.effect?.allOf || []).filter(code => !completed(code)).map(code => gap([code])),
    ...(rule.effect?.oneOfGroups || []).filter(group => !group.some(completed)).map(gap)
  ];
}

export function historicalPrerequisiteMessage(gap) {
  if (gap.dependentInProgress) {
    return `You are taking ${gap.course}, but ${gap.label} is not marked done or Taking now. If you finished ${gap.label}, mark it. Otherwise, show your PDF to your advisor.`;
  }
  if (gap.takingNow) return `You marked ${gap.course} completed, but ${gap.label} is marked Taking now. ${gap.label} normally comes first. If this is correct, show your PDF to your advisor.`;
  return `You marked ${gap.course} completed, but ${gap.label} is not marked done. If you finished ${gap.label} or have transfer/AP credit, mark it. Otherwise, show your PDF to your advisor.`;
}

export function historicalPrerequisiteSummary(gaps) {
  if (!gaps.length) return "";
  const additional = gaps.slice(1).map(gap => `${gap.label} ${gap.takingNow ? "is marked Taking now" : "is not marked completed"}.`);
  return `${historicalPrerequisiteMessage(gaps[0])}${additional.length ? ` Also: ${additional.join(" ")}` : ""}`;
}

export function scheduledAfterCompletedMarker(code, courses = [], rules = []) {
  const completed = courses.filter(item => ["completed", "transfer"].includes(item.status));
  const dependent = completed.find(item => historicalPrerequisiteGaps(item.code, courses, rules)
    .some(gap => gap.options.includes(code)));
  return dependent ? `Scheduled after ${dependent.code}, which you marked completed. Check with your advisor.` : null;
}
