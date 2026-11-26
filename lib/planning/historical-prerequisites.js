import { displayMessage, STATISTICS_COURSES } from "./student-language.js";

// Presentation of recorded history against canonical prerequisite rules. This
// never changes a course's credit or the planner's placement decision.
const COMPLETED = ["completed", "transfer"];

// A same-term pairing that policy already allows with an approval (for example
// MAT 113 with ECO 213) keeps its own approval message instead of a warning.
// The planner's own limit: e.g. ECO 461 with ECO 213 or ECO 214 needs the other
// one completed (so only one can be Taking now).
function approvedSameTerm(course, code, rules, statuses) {
  return rules.some(rule => {
    const condition = rule.condition || {};
    const options = condition.concurrentOptions || [];
    if (rule.ruleType !== "permissionException" || !rule.effect?.allowConcurrency
      || condition.dependentCourse !== course || !options.includes(code)) return false;
    if (condition.requiresCompletedFromOptions
      && options.filter(option => COMPLETED.includes(statuses.get(option))).length < condition.requiresCompletedFromOptions) return false;
    return true;
  });
}

// Whether policy would let this missing prerequisite be taken in the same term
// as the course (with approval), given what is already completed.
function mayBeTakingNow(course, gap, rules, statuses) {
  return rules.some(rule => {
    const condition = rule.condition || {};
    const options = condition.concurrentOptions || [];
    if (rule.ruleType !== "permissionException" || !rule.effect?.allowConcurrency
      || condition.dependentCourse !== course || !gap.options.every(code => options.includes(code))) return false;
    return !condition.requiresCompletedFromOptions
      || options.filter(option => COMPLETED.includes(statuses.get(option))).length >= condition.requiresCompletedFromOptions;
  });
}

export function historicalPrerequisiteGaps(course, courses = [], rules = []) {
  const rule = rules.find(item => item.ruleType === "coursePrerequisite" && item.condition?.course === course);
  if (!rule) return [];
  const statuses = new Map(courses.map(item => [item.code, item.status]));
  const dependentStatus = statuses.get(course);
  const dependentInProgress = dependentStatus === "in_progress";
  const met = code => COMPLETED.includes(statuses.get(code))
    || (dependentInProgress && statuses.get(code) === "in_progress" && approvedSameTerm(course, code, rules, statuses));
  const gap = options => {
    const inProgress = options.filter(code => statuses.get(code) === "in_progress");
    const takingNow = inProgress.length > 0;
    return {
      course,
      // A Taking now note names only the course actually marked Taking now.
      label: (takingNow ? inProgress : options).join(" or "),
      options: takingNow ? inProgress : options,
      takingNow,
      dependentInProgress,
      kind: !takingNow ? "missing" : dependentInProgress ? "concurrent" : "takingNow",
      mayBeTakingNow: !takingNow && mayBeTakingNow(course, { options }, rules, statuses)
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
  // Owner decision 2026-11-26: suggest "Taking now" only where policy allows the
  // same term; otherwise the suggestion would trigger the both-Taking-now warning.
  const needs = () => {
    const missing = gaps.filter(gap => gap.kind === "missing");
    if (!missing.length) return "";
    const flexible = missing.filter(gap => gap.mayBeTakingNow);
    const completedOnly = missing.filter(gap => !gap.mayBeTakingNow);
    if (!completedOnly.length) return part("missing", "history.takingNowNeeds", "missing");
    if (!flexible.length) return part("missing", "history.takingNowNeedsCompleted", "missing");
    const all = part("missing", "history.takingNowNeedsCompleted", "missing").match(/needs (.+) first\./)[1];
    const flexibleName = flexible.every(gap => gap.options.every(code => code.startsWith("MAT ")))
      ? displayMessage(messages, "history.mathCourse") : listNames(flexible.map(gapName));
    return displayMessage(messages, "history.takingNowNeedsMixed", {
      course, missing: all, completedOnly: listNames(completedOnly.map(gapName)), flexible: flexibleName });
  };
  const names = kind => {
    const matching = gaps.filter(gap => gap.kind === kind);
    return matching.map(gap => matching.length > 1 && gap.options.length > 1 && gapName(gap) === gap.label ? `either ${gap.label}` : gapName(gap));
  };
  // Owner decision 2026-11-26: when both kinds apply, one sentence instead of two.
  if (dependentInProgress) {
    const needsSentence = needs();
    const concurrent = names("concurrent");
    if (!needsSentence || !concurrent.length) return [needsSentence, part("concurrent", "history.bothTakingNow", "prerequisites")].filter(Boolean).join(" ");
    return `${needsSentence.replace(/, or your advisor will check\.$/, ".")} ${displayMessage(messages,
      `history.bothTakingNowAfterNeeds${concurrent.length > 1 ? "Many" : "One"}`, { course, prerequisites: listNames(concurrent) })}`;
  }
  const missing = names("missing");
  const takingNow = names("takingNow");
  if (missing.length && takingNow.length) {
    return displayMessage(messages, "history.completedMixed", {
      course, missing: listNames(missing), missingVerb: missing.length > 1 ? "are" : "is",
      prerequisites: listNames(takingNow), takingVerb: takingNow.length > 1 ? "are" : "is" });
  }
  return [part("missing", "history.completedMissing", "missing"), part("takingNow", "history.completedPrerequisiteTakingNow", "prerequisites")]
    .filter(Boolean).join(" ");
}

export function scheduledAfterCompletedMarker(code, courses = [], rules = [], messages) {
  const completed = courses.filter(item => ["completed", "transfer"].includes(item.status));
  const dependent = completed.find(item => historicalPrerequisiteGaps(item.code, courses, rules)
    .some(gap => gap.options.includes(code)));
  return dependent ? displayMessage(messages, "history.scheduledPrerequisite", { prerequisite: code, course: dependent.code }) : null;
}
