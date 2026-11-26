import { displayMessage, STATISTICS_COURSES } from "./student-language.js";

// Presentation of recorded history against canonical prerequisite rules. This
// never changes a course's credit or the planner's placement decision.
const COMPLETED = ["completed", "transfer"];

// A same-term pairing that policy already allows with an approval (for example
// MAT 113 with ECO 213) keeps its own approval message instead of a warning.
function approvedSameTerm(course, code, rules) {
  return rules.some(rule => rule.ruleType === "permissionException" && rule.effect?.allowConcurrency
    && rule.condition?.dependentCourse === course && (rule.condition?.concurrentOptions || []).includes(code));
}

export function historicalPrerequisiteGaps(course, courses = [], rules = []) {
  const rule = rules.find(item => item.ruleType === "coursePrerequisite" && item.condition?.course === course);
  if (!rule) return [];
  const statuses = new Map(courses.map(item => [item.code, item.status]));
  const dependentStatus = statuses.get(course);
  const dependentInProgress = dependentStatus === "in_progress";
  const met = code => COMPLETED.includes(statuses.get(code))
    || (dependentInProgress && statuses.get(code) === "in_progress" && approvedSameTerm(course, code, rules));
  const gap = options => {
    const takingNow = options.some(code => statuses.get(code) === "in_progress");
    return {
      course,
      label: options.join(" or "),
      options,
      takingNow,
      dependentInProgress,
      kind: !takingNow ? "missing" : dependentInProgress ? "concurrent" : "takingNow"
    };
  };
  return [
    ...(rule.effect?.allOf || []).filter(code => !met(code)).map(code => gap([code])),
    ...(rule.effect?.oneOfGroups || []).filter(group => !group.some(met)).map(gap)
  ];
}

function gapName(gap) {
  const options = [...gap.options].sort();
  return options.length === STATISTICS_COURSES.length && [...STATISTICS_COURSES].sort().every((code, index) => code === options[index])
    ? "a statistics course" : gap.label;
}

function listNames(names) {
  return names.length < 2 ? names[0] || "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// One message per course, naming every unmet prerequisite.
export function historicalPrerequisiteCourseMessage(course, courses = [], rules = [], messages) {
  const gaps = historicalPrerequisiteGaps(course, courses, rules);
  const part = (kind, key, param) => {
    const matching = gaps.filter(gap => gap.kind === kind);
    // In a list, "either" keeps a choice ("MAT 113 or MAT 121") apart from the other items.
    const names = matching.map(gap => matching.length > 1 && gap.options.length > 1 && gapName(gap) === gap.label ? `either ${gap.label}` : gapName(gap));
    return names.length ? displayMessage(messages, `${key}${names.length > 1 ? "Many" : "One"}`, { course, [param]: listNames(names) }) : "";
  };
  const dependentInProgress = gaps[0]?.dependentInProgress;
  return (dependentInProgress
    ? [part("missing", "history.takingNowNeeds", "missing"), part("concurrent", "history.bothTakingNow", "prerequisites")]
    : [part("missing", "history.completedMissing", "missing"), part("takingNow", "history.completedPrerequisiteTakingNow", "prerequisites")])
    .filter(Boolean).join(" ");
}

export function scheduledAfterCompletedMarker(code, courses = [], rules = [], messages) {
  const completed = courses.filter(item => ["completed", "transfer"].includes(item.status));
  const dependent = completed.find(item => historicalPrerequisiteGaps(item.code, courses, rules)
    .some(gap => gap.options.includes(code)));
  return dependent ? displayMessage(messages, "history.scheduledPrerequisite", { course: dependent.code }) : null;
}
