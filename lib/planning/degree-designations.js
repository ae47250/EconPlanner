import { normalizeStudentCourses } from "../requirements/normalize.js";
import { loadPlanningFlexibilityPolicy } from "../catalog/policy-releases.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";

function designationPolicy() {
  return loadPlanningFlexibilityPolicy().policy.generalDegreeDesignationInformation;
}

function sorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function joinedCourses(courses) {
  if (courses.length < 2) return courses[0] || "";
  if (courses.length === 2) return `${courses[0]} and ${courses[1]}`;
  return `${courses.slice(0, -1).join(", ")}, and ${courses.at(-1)}`;
}

function relevantCourseStates(student = {}, plan = {}) {
  const completed = new Set();
  const inProgress = new Set();
  for (const course of normalizeStudentCourses(student.courses)) {
    if (["completed", "transfer"].includes(course.status)) completed.add(course.code);
    if (course.status === "in_progress") inProgress.add(course.code);
  }
  const planned = new Set((plan.terms || []).flatMap(term => (
    (term.courses || []).map(course => course.course || course.code)
  )).filter(code => !completed.has(code) && !inProgress.has(code)));
  return { completed, inProgress, planned };
}

function designation(code, status, courses, detail) {
  return {
    code,
    status,
    courses,
    detail,
    message: `${code} ${detail}`,
    requirementGroup: "Areas of Competency and Engagement (ACEs)",
    informationalOnly: true,
    feasibilityImpact: "NONE",
    readinessImpact: "NONE",
    advisorActionStatus: "INFORMATION_ONLY"
  };
}

function hsDesignation(states, policy) {
  const hsCourses = new Set(policy.designations.HS.courses);
  const completed = sorted([...states.completed].filter(code => hsCourses.has(code)));
  const inProgress = sorted([...states.inProgress].filter(code => hsCourses.has(code)));
  const planned = sorted([...states.planned].filter(code => hsCourses.has(code)));
  if (!completed.length && !inProgress.length && !planned.length) return null;

  const clauses = [];
  if (completed.length) clauses.push(`— partly satisfied by ${joinedCourses(completed)}`);
  if (inProgress.length) clauses.push(`— in progress through ${joinedCourses(inProgress)}`);
  if (planned.length) clauses.push(`— planned to be partly satisfied by ${joinedCourses(planned)}`);
  const detail = `${clauses.join("; ")}. ${runtimePolicyBundle().planningAdvice.display.hs}`;
  return designation(
    "HS",
    completed.length ? "PARTLY_SATISFIED" : inProgress.length ? "IN_PROGRESS_PARTIAL" : "PLANNED_PARTIAL",
    { completed, inProgress, planned },
    detail
  );
}

function w2Designation(states) {
  if (states.completed.has("ECO 461")) {
    return designation("W2", "SATISFIED", { completed: ["ECO 461"], inProgress: [], planned: [] }, "— satisfied through ECO 461.");
  }
  if (states.inProgress.has("ECO 461")) {
    return designation("W2", "IN_PROGRESS", { completed: [], inProgress: ["ECO 461"], planned: [] }, "— in progress through ECO 461.");
  }
  if (states.planned.has("ECO 461")) {
    return designation("W2", "PLANNED", { completed: [], inProgress: [], planned: ["ECO 461"] }, "— planned through ECO 461.");
  }
  return null;
}

export function buildDegreeDesignationInformation({ student = {}, plan = {}, planningContext = null } = {}) {
  const policy = designationPolicy();
  const generalDegreeCatalogYear = String(
    student.generalDegreeCatalogYear
      || student.entryCatalogYear
      || planningContext?.entryCatalogYear
      || ""
  ).trim() || null;
  const evidenceAvailable = new Set(policy.generalDegreeCatalogYearsWithEvidence).has(generalDegreeCatalogYear);
  if (!evidenceAvailable) {
    return {
      schemaVersion: "econplanner-degree-designations-v1",
      generalDegreeCatalogYear,
      economicsMajorCatalogYear: planningContext?.catalogApplicability?.appliedMajorCatalogYear || null,
      evidenceStatus: "UNAVAILABLE_FOR_APPLICABLE_GENERAL_DEGREE_CATALOG",
      informationalOnly: true,
      items: []
    };
  }

  const states = relevantCourseStates(student, plan);
  return {
    schemaVersion: "econplanner-degree-designations-v1",
    generalDegreeCatalogYear,
    economicsMajorCatalogYear: planningContext?.catalogApplicability?.appliedMajorCatalogYear || null,
    evidenceStatus: "SUPPORTED",
    terminology: policy.terminology,
    sourceRefs: policy.sourceRefs,
    informationalOnly: true,
    items: [hsDesignation(states, policy), w2Designation(states)].filter(Boolean)
  };
}
