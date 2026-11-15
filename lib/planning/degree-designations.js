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

function w2Designation(states, { courseCode = "ECO 461", skills = false } = {}) {
  const status = states.completed.has(courseCode) ? "SATISFIED"
    : states.inProgress.has(courseCode) ? "IN_PROGRESS"
      : states.planned.has(courseCode) ? "PLANNED" : null;
  if (!status) return null;
  return designation("W2", status, {
    completed: status === "SATISFIED" ? [courseCode] : [],
    inProgress: status === "IN_PROGRESS" ? [courseCode] : [],
    planned: status === "PLANNED" ? [courseCode] : []
  }, `${courseCode} also counts toward your Writing 2 (W2)${skills ? " Skills" : ""} requirement.`);
}

export function buildDegreeDesignationInformation({ student = {}, plan = {}, planningContext = null } = {}) {
  const policy = designationPolicy();
  const generalDegreeCatalogYear = String(
    student.generalDegreeCatalogYear
      || student.entryCatalogYear
      || planningContext?.entryCatalogYear
      || ""
  ).trim() || null;
  const cohortConflict = Boolean(student.generalDegreeCatalogYear && student.entryCatalogYear
    && student.generalDegreeCatalogYear !== student.entryCatalogYear);
  const evidenceAvailable = !cohortConflict && new Set(policy.generalDegreeCatalogYearsWithEvidence).has(generalDegreeCatalogYear);
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
  if (generalDegreeCatalogYear === policy.hanoverCore?.catalogYear) {
    const hsCourses = policy.hanoverCore.hsCourses;
    const hs = Object.fromEntries(["completed", "inProgress", "planned"].map(status =>
      [status, sorted([...states[status]].filter(code => hsCourses.includes(code)))]));
    const hsMentioned = [...hs.completed, ...hs.inProgress, ...hs.planned];
    const w2Code = policy.hanoverCore.w2Courses[0];
    const hsClauses = [];
    if (hs.completed.length) {
      hsClauses.push(hs.completed.length === 1
        ? `${hs.completed[0]} is completed and may count toward one of your two Historical and Social Perspectives (HS) Knowledge courses.`
        : `${joinedCourses(hs.completed)} are completed; one may count toward one of your two Historical and Social Perspectives (HS) Knowledge courses.`);
    }
    if (hs.inProgress.length) hsClauses.push(`${joinedCourses(hs.inProgress)} ${hs.inProgress.length === 1 ? "is" : "are"} taking now and may count when completed.`);
    if (hs.planned.length) hsClauses.push(`${joinedCourses(hs.planned)} ${hs.planned.length === 1 ? "is" : "are"} planned and may count when completed.`);
    const hsText = hsMentioned.length > 1
      ? `${[...hs.completed.map(code => `${code} is completed`), ...hs.inProgress.map(code => `${code} is taking now`), ...hs.planned.map(code => `${code} is planned`)].join("; ")}. Only one of these Economics courses may count toward one of your two Historical and Social Perspectives (HS) Knowledge courses. Your other HS course must be from a different discipline.`
      : `${hsClauses.join(" ")} Your other HS course must be from a different discipline.`;
    const items = [];
    if (hsMentioned.length) items.push({ ...designation("HS", hs.completed.length ? "PARTLY_SATISFIED" : hs.inProgress.length ? "IN_PROGRESS_PARTIAL" : "PLANNED_PARTIAL", hs, hsText),
      requirementGroup: policy.hanoverCore.name });
    const w2 = w2Designation(states, { courseCode: w2Code, skills: true });
    if (w2) items.push({ ...w2, requirementGroup: policy.hanoverCore.name });
    return { schemaVersion: "econplanner-degree-designations-v1", generalDegreeCatalogYear,
      economicsMajorCatalogYear: planningContext?.catalogApplicability?.appliedMajorCatalogYear || null,
      evidenceStatus: "SUPPORTED", curriculum: "HANOVER_CORE", terminology: { core: policy.hanoverCore.name },
      sourceRefs: policy.hanoverCore.sourceRefs, informationalOnly: true, items };
  }
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
