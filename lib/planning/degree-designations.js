import { normalizeStudentCourses } from "../requirements/normalize.js";
import { loadPlanningFlexibilityPolicy } from "../catalog/policy-releases.js";

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

  const detail = hsDetail({ completed, inProgress, planned });
  return designation(
    "HS",
    completed.length ? "PARTLY_SATISFIED" : inProgress.length ? "IN_PROGRESS_PARTIAL" : "PLANNED_PARTIAL",
    { completed, inProgress, planned },
    detail
  );
}

function hsDetail({ completed, inProgress, planned }) {
  const courses = sorted([...completed, ...inProgress, ...planned]);
  if (!courses.length) return "";
  return courses.length > 1
    ? `${joinedCourses(courses)} can each count toward Historical and Social Perspectives (HS), but only one of them can count. Your other HS course must be from a different discipline.`
    : `${courses[0]} can count toward Historical and Social Perspectives (HS)${completed.length ? "" : " once completed"}. Your other HS course must be from a different discipline.`;
}

function w2Designation(states, { courseCode = "ECO 461" } = {}) {
  const status = states.completed.has(courseCode) ? "SATISFIED"
    : states.inProgress.has(courseCode) ? "IN_PROGRESS"
      : states.planned.has(courseCode) ? "PLANNED" : null;
  if (!status) return null;
  return designation("W2", status, {
    completed: status === "SATISFIED" ? [courseCode] : [],
    inProgress: status === "IN_PROGRESS" ? [courseCode] : [],
    planned: status === "PLANNED" ? [courseCode] : []
  }, `${courseCode} also counts toward your Writing 2 (W2) requirement.`);
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
  const confirmedOlderCore = ["2023-2024", "2024-2025"].includes(generalDegreeCatalogYear);
  const evidenceAvailable = (!cohortConflict || confirmedOlderCore)
    && (new Set(policy.generalDegreeCatalogYearsWithEvidence).has(generalDegreeCatalogYear) || confirmedOlderCore);
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
    const items = [];
    if (hsMentioned.length) items.push({ ...designation("HS", hs.completed.length ? "PARTLY_SATISFIED" : hs.inProgress.length ? "IN_PROGRESS_PARTIAL" : "PLANNED_PARTIAL", hs, hsDetail(hs)),
      requirementGroup: policy.hanoverCore.name });
    const w2 = w2Designation(states, { courseCode: w2Code });
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
