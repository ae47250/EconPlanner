import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runtimePolicyBundle, runtimeEconomicsSchedule } from "../lib/policy/compat-normalized.js";
import { evaluateTermLoad } from "../lib/decision-engine/placement.js";
import { buildDegreeDesignationInformation } from "../lib/planning/degree-designations.js";
import {
  buildPrerequisiteStatusNotices,
  evaluatePlanPrerequisites
} from "../lib/planning/prerequisiteEvaluator.js";
import { buildRequirementAllocation } from "../lib/planning/requirementAllocation.js";
import {
  compareEconomicsPlans
} from "../lib/planning/economics.js";
import { historicalOfferingProjectionEvidence } from "../lib/planning/termSolver.js";
import { normalizeMathematicsEquivalencyDecision } from "../lib/policy/equivalency-scope.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";

const bundle = runtimePolicyBundle();
const reviewedSchedule = JSON.parse(await readFile(new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url), "utf8"));

function courses(count, prefix = "ECO") {
  return Array.from({ length: count }, (_item, index) => ({ course: `${prefix} ${200 + index}`, units: 1 }));
}

test("normal and conditional College load remain separate authoritative states", () => {
  const base = { academicYear: "2026-2027", termKey: "Fall" };
  assert.equal(evaluateTermLoad({ ...base, courses: courses(4) }, {}, bundle, { traceId: "normal" }).status, "ALLOW");

  const missing = evaluateTermLoad({ ...base, courses: courses(5) }, {}, bundle, { traceId: "missing" });
  assert.equal(missing.status, "UNKNOWN");
  assert.equal(missing.reasonCode, "TERM_OVERLOAD_EVIDENCE_REQUIRED");

  const approved = evaluateTermLoad({
    ...base,
    courses: courses(5),
    termLoadEvidence: {
      advisorApproval: "APPROVED",
      academicProbationStatus: "NOT_ON_ACADEMIC_PROBATION",
      evidenceRef: "fixture://advisor-overload"
    }
  }, {}, bundle, { traceId: "approved" });
  assert.equal(approved.status, "CONDITIONAL");
  assert.equal(approved.reasonCode, "TERM_OVERLOAD_APPROVED");

  const probation = evaluateTermLoad({
    ...base,
    courses: courses(5),
    termLoadEvidence: { advisorApproval: "APPROVED", academicProbationStatus: "ON_ACADEMIC_PROBATION" }
  }, {}, bundle, { traceId: "probation" });
  assert.equal(probation.status, "BLOCK");
  assert.equal(probation.reasonCode, "TERM_OVERLOAD_NOT_ALLOWED_ON_ACADEMIC_PROBATION");

  assert.equal(evaluateTermLoad({ ...base, courses: courses(5).concat({ course: "MAT 113", units: 0.5 }) }, {}, bundle, { traceId: "too-high" }).reasonCode, "TERM_CAPACITY_EXCEEDED");
});

test("the exact 2026-2027 May schedule retains ECO, statistics, and supporting sections", () => {
  const may = runtimeEconomicsSchedule().terms.May;
  assert.deepEqual(may.map(course => `${course.course}-${course.section}`).sort(), reviewedSchedule.sections.filter(section => section.term === "May").map(section => `${section.course}-${section.section}`).sort());
});

function prerequisitePlan(prerequisiteTerm, dependentTerm) {
  return {
    terms: [
      ...(prerequisiteTerm ? [{ term: prerequisiteTerm, termKey: "Fall", academicYear: "2027-2028", courses: [{ course: "ECO 114" }] }] : []),
      { term: dependentTerm, termKey: "Winter", academicYear: "2027-2028", courses: [{ course: "ECO 222" }] }
    ]
  };
}

const eco222Prerequisites = { "ECO 222": { all: ["ECO 114"], any: [] } };

test("ECO 222 prerequisite notices distinguish completed, in-progress, planned-earlier, missing, and later", () => {
  const completedPlan = prerequisitePlan(null, "Winter 2028");
  assert.deepEqual(buildPrerequisiteStatusNotices({
    plan: completedPlan,
    student: { courses: [{ code: "ECO 114", status: "completed" }] },
    prerequisites: eco222Prerequisites
  }), []);

  const inProgress = buildPrerequisiteStatusNotices({
    plan: completedPlan,
    student: { courses: [{ code: "ECO 114", status: "in_progress" }] },
    prerequisites: eco222Prerequisites
  });
  assert.equal(inProgress[0].code, "PREREQUISITE_IN_PROGRESS_SUCCESS_PENDING");
  assert.match(inProgress[0].message, /ECO 114 is in progress/);

  const planned = prerequisitePlan("Fall 2027", "Winter 2028");
  const plannedNotice = buildPrerequisiteStatusNotices({ plan: planned, student: {}, prerequisites: eco222Prerequisites });
  assert.equal(plannedNotice[0].code, "PREREQUISITE_PLANNED_SUCCESS_PENDING");
  assert.equal(plannedNotice[0].prerequisiteTerm, "Fall 2027");

  const missing = evaluatePlanPrerequisites({ plan: completedPlan, student: {}, prerequisites: eco222Prerequisites });
  assert.equal(missing.valid, false);
  const later = {
    terms: [
      { term: "Fall 2027", termKey: "Fall", academicYear: "2027-2028", courses: [{ course: "ECO 222" }] },
      { term: "Winter 2028", termKey: "Winter", academicYear: "2027-2028", courses: [{ course: "ECO 114" }] }
    ]
  };
  assert.equal(evaluatePlanPrerequisites({ plan: later, student: {}, prerequisites: eco222Prerequisites }).valid, false);
});

test("CCR/ACE information is relevant-only, catalog-scoped, and informational", () => {
  const unavailable = buildDegreeDesignationInformation({
    student: { entryCatalogYear: "2024-2025", courses: [{ code: "ECO 113", status: "completed" }] },
    plan: {},
    planningContext: { entryCatalogYear: "2024-2025" }
  });
  assert.equal(unavailable.evidenceStatus, "UNAVAILABLE_FOR_APPLICABLE_GENERAL_DEGREE_CATALOG");
  assert.deepEqual(unavailable.items, []);

  const information = buildDegreeDesignationInformation({
    student: {
      courses: [
        { code: "ECO 113", status: "completed" },
        { code: "ECO 114", status: "in_progress" },
        { code: "ECO 260", status: "completed" }
      ]
    },
    plan: { terms: [{ courses: [{ course: "ECO 161" }, { course: "ECO 461" }] }] },
    planningContext: {
      entryCatalogYear: "2025-2026",
      catalogApplicability: { appliedMajorCatalogYear: "2025-2026" }
    }
  });
  assert.equal(information.evidenceStatus, "SUPPORTED");
  assert.deepEqual(information.items.map(item => item.code), ["HS", "W2"]);
  const hs = information.items.find(item => item.code === "HS");
  assert.deepEqual(hs.courses, { completed: ["ECO 113"], inProgress: ["ECO 114"], planned: ["ECO 161"] });
  assert.doesNotMatch(hs.message, /ECO 260/);
  assert.match(hs.message, /ECO 113, ECO 114, and ECO 161 can each count toward Historical and Social Perspectives \(HS\), but only one of them can count\./);
  assert.equal(hs.feasibilityImpact, "NONE");
  assert.equal(hs.readinessImpact, "NONE");
  assert.equal(information.items.find(item => item.code === "W2").detail, "ECO 461 also counts toward your Writing 2 (W2) requirement.");
});

test("2026-2027 Hanover Core separates completed, taking-now, and planned course information", () => {
  const information = buildDegreeDesignationInformation({
    student: {
      entryCatalogYear: "2026-2027",
      generalDegreeCatalogYear: "2026-2027",
      courses: [
        { code: "ECO 113", status: "completed" },
        { code: "ECO 114", status: "in_progress" }
      ]
    },
    plan: { terms: [{ courses: [{ course: "ECO 461" }] }] },
    planningContext: { entryCatalogYear: "2026-2027", catalogApplicability: { appliedMajorCatalogYear: "2025-2026" } }
  });
  assert.equal(information.curriculum, "HANOVER_CORE");
  assert.equal(information.informationalOnly, true);
  assert.deepEqual(information.items.map(item => item.code), ["HS", "W2"]);
  const hs = information.items.find(item => item.code === "HS");
  assert.deepEqual(hs.courses, { completed: ["ECO 113"], inProgress: ["ECO 114"], planned: [] });
  assert.match(hs.detail, /ECO 113 and ECO 114 can each count toward Historical and Social Perspectives \(HS\), but only one of them can count\./);
  assert.match(hs.detail, /Your other HS course must be from a different discipline/);
  const w2 = information.items.find(item => item.code === "W2");
  assert.deepEqual(w2.courses, { completed: [], inProgress: [], planned: ["ECO 461"] });
  assert.equal(w2.detail, "ECO 461 also counts toward your Writing 2 (W2) requirement.");
  assert.equal(w2.feasibilityImpact, "NONE");

  const conflicting = buildDegreeDesignationInformation({
    student: { entryCatalogYear: "2025-2026", generalDegreeCatalogYear: "2026-2027" },
    plan: {}, planningContext: { entryCatalogYear: "2025-2026" }
  });
  assert.equal(conflicting.evidenceStatus, "UNAVAILABLE_FOR_APPLICABLE_GENERAL_DEGREE_CATALOG");
  assert.deepEqual(conflicting.items, []);
});

test("two planned Economics courses share only one HS Knowledge designation", () => {
  const information = buildDegreeDesignationInformation({
    student: { entryCatalogYear: "2026-2027", generalDegreeCatalogYear: "2026-2027", courses: [] },
    plan: { terms: [{ courses: [{ course: "ECO 113" }, { course: "ECO 114" }] }] },
    planningContext: { entryCatalogYear: "2026-2027" }
  });
  const hs = information.items.find(item => item.code === "HS");
  assert.deepEqual(hs.courses, { completed: [], inProgress: [], planned: ["ECO 113", "ECO 114"] });
  assert.equal(hs.detail, "ECO 113 and ECO 114 can each count toward Historical and Social Perspectives (HS), but only one of them can count. Your other HS course must be from a different discipline.");
  assert.equal(hs.feasibilityImpact, "NONE");
});

test("W2 course wording follows catalog cohort while actual course status stays unchanged", () => {
  const expectedStatuses = {
    completed: { status: "SATISFIED", courses: { completed: ["ECO 461"], inProgress: [], planned: [] } },
    in_progress: { status: "IN_PROGRESS", courses: { completed: [], inProgress: ["ECO 461"], planned: [] } },
    planned: { status: "PLANNED", courses: { completed: [], inProgress: [], planned: ["ECO 461"] } }
  };
  for (const [catalogYear, expectedText] of [
    ["2025-2026", "ECO 461 also counts toward your Writing 2 (W2) requirement."],
    ["2026-2027", "ECO 461 also counts toward your Writing 2 (W2) requirement."]
  ]) {
    for (const [courseStatus, expected] of Object.entries(expectedStatuses)) {
      const student = {
        entryCatalogYear: catalogYear,
        generalDegreeCatalogYear: catalogYear,
        courses: courseStatus === "planned" ? [] : [{ code: "ECO 461", status: courseStatus }]
      };
      const plan = { terms: courseStatus === "planned" ? [{ courses: [{ course: "ECO 461" }] }] : [] };
      const information = buildDegreeDesignationInformation({
        student, plan, planningContext: { entryCatalogYear: catalogYear }
      });
      const w2 = information.items.find(item => item.code === "W2");
      assert.equal(w2.status, expected.status, `${catalogYear} ${courseStatus}`);
      assert.deepEqual(w2.courses, expected.courses, `${catalogYear} ${courseStatus}`);
      assert.equal(w2.detail, expectedText, `${catalogYear} ${courseStatus}`);
    }
  }
});

function rankingPlan(loads, course = { course: "ECO 260", source: "catalog-statement" }) {
  const keys = ["Fall", "Winter", "May"];
  return {
    terms: keys.map((termKey, termIndex) => ({
      termKey,
      yearIndex: 0,
      courses: Array.from({ length: loads[termIndex] }, (_item, index) => ({
        ...course,
        course: index === 0 ? course.course : `ECO ${270 + termIndex * 10 + index}`
      }))
    })),
    validation: { conditions: [] },
    feasibility: { requiredApprovals: [], enrollmentConditions: [] },
    distribution: { targetYearCounts: [loads.reduce((sum, value) => sum + value, 0)] }
  };
}

test("named evidence and May-positive four-course shapes rank ahead of generic 2/2/0", () => {
  const oneTwoOne = rankingPlan([1, 2, 1]);
  const twoOneOne = rankingPlan([2, 1, 1]);
  const twoTwoZero = rankingPlan([2, 2, 0]);
  assert.ok(compareEconomicsPlans(oneTwoOne, twoTwoZero) < 0);
  assert.ok(compareEconomicsPlans(twoOneOne, twoTwoZero) < 0);

  const named = rankingPlan([0, 0, 1]);
  const generic = rankingPlan([0, 0, 1], { course: "ECO elective", source: "requirement-placeholder" });
  assert.ok(compareEconomicsPlans(named, generic) < 0);
});

test("historical ranking stays neutral without approval and uses only the governed once-in-six threshold", () => {
  assert.equal(historicalOfferingProjectionEvidence("ECO 331", bundle), null);
  const fixture = structuredClone(bundle);
  fixture.provenance.historicalOfferingContract.method.veryLowPriorityRule = {
    minimumCompleteYears: 6,
    maximumYearsOffered: 1
  };
  fixture.indexes.historicalOfferingByCourse["ECO 331"] = {
    courseIdentity: "ECO 331",
    activationStatus: "ACTIVE_OWNER_APPROVED",
    ownerApproval: { approved: true, reviewer: "fixture", approvedOn: "2026-08-08" },
    observationPeriod: { fromAcademicYear: "2020-2021", throughAcademicYear: "2025-2026" },
    completeYears: ["2020-2021", "2021-2022", "2022-2023", "2023-2024", "2024-2025", "2025-2026"],
    yearsOffered: ["2022-2023"],
    annualOfferingRate: 1 / 6,
    mostRecentOffering: "Winter 2023",
    sourceRefs: ["fixture://history"]
  };
  const evidence = historicalOfferingProjectionEvidence("ECO 331", fixture);
  assert.equal(evidence.priority, "VERY_LOW");
  assert.match(evidence.factualMessage, /1 of 6 complete academic years/);
  assert.match(evidence.factualMessage, /Winter 2023/);
});

test("ECO 321 and BUSN 323 allocation is independent of completed-versus-planned chronology", () => {
  const requirements = [
    { id: "finance", kind: "choice", options: ["ECO 321", "BUSN 323"] },
    {
      id: "eco-elective-1",
      kind: "elective",
      subject: "ECO",
      excludedCourses: [],
      conditionalCourses: { "ECO 321": { slotId: "finance", assignedCode: "BUSN 323" } }
    }
  ];
  const first = buildRequirementAllocation({
    requirements,
    existingAssignments: [{ slotId: "eco-elective-1", code: "ECO 321", status: "completed" }],
    plan: { terms: [{ term: "Winter 2027", courses: [{ requirementId: "finance", course: "BUSN 323" }] }] }
  });
  const second = buildRequirementAllocation({
    requirements,
    existingAssignments: [{ slotId: "finance", code: "BUSN 323", status: "completed" }],
    plan: { terms: [{ term: "Winter 2027", courses: [{ requirementId: "eco-elective-1", course: "ECO 321" }] }] }
  });
  assert.equal(first.valid, false);
  assert.equal(second.valid, false);
  const expected = ["eco-elective-1:ECO 321", "finance:BUSN 323"];
  for (const allocation of [first, second]) {
    assert.deepEqual(allocation.assignments.map(item => `${item.slotId}:${item.code}`).sort(), expected);
  }
});

test("mathematics equivalency evidence cannot leak between cognate and prerequisite scopes", () => {
  const cognate = normalizeMathematicsEquivalencyDecision({
    authority: "Economics Department",
    source: "fixture://approved-decision",
    approvalDate: "2026-08-08",
    reviewer: "Fixture Reviewer",
    scope: "ECONOMICS_COGNATE"
  });
  assert.equal(cognate.valid, true);
  assert.equal(cognate.decision.affectedCourse, null);
  assert.equal(cognate.crossScopeInferencePermitted, false);

  const incompletePrerequisite = normalizeMathematicsEquivalencyDecision({
    authority: "Economics Department",
    source: "fixture://approved-decision",
    approvalDate: "2026-08-08",
    reviewer: "Fixture Reviewer",
    scope: "COURSE_PREREQUISITE"
  });
  assert.equal(incompletePrerequisite.valid, false);
  assert.match(incompletePrerequisite.errors.join(" "), /affectedCourse/);
  assert.match(incompletePrerequisite.errors.join(" "), /affectedRule/);

  const prerequisite = normalizeMathematicsEquivalencyDecision({
    authority: "Economics Department",
    source: "fixture://approved-decision",
    approvalDate: "2026-08-08",
    reviewer: "Fixture Reviewer",
    scope: "COURSE_PREREQUISITE",
    affectedCourse: "ECO 335",
    affectedRule: "PREREQ-ECO-335"
  });
  assert.equal(prerequisite.valid, true);
  assert.equal(prerequisite.decision.scope, "COURSE_PREREQUISITE");
});

test("HTML and PDF renderers preserve structured HS/W2 codes with accessible bold text", async () => {
  const degreeRequirementInformation = buildDegreeDesignationInformation({
    student: { courses: [{ code: "ECO 113", status: "completed" }] },
    plan: { terms: [{ courses: [{ course: "ECO 461" }] }] },
    planningContext: { entryCatalogYear: "2025-2026" }
  });
  const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
  const html = renderEconomicsHtml({
    student: { displayName: "CP5A Fixture", academicStanding: "Senior", planningPace: "standard" },
    preparedDate: "2026-08-08",
    planningHorizon: "2026-2027",
    inputSummary: "Fixture",
    remaining: { strict: 0, optimistic: 0, projected: 0 },
    selectedPlan: { planningContext: { remainingYears: 1 }, feasibilityStatus: "CONDITIONALLY_FEASIBLE" },
    terms: [{ term: "Winter 2027", termKey: "Winter", academicYear: "2026-2027", courses: [
      { code: "ECO 461", course: "ECO 461", displayLabel: "ECO 461", title: "Senior Seminar", requirementId: "eco-capstone" }
    ] }],
    requirements: [],
    unresolved: [],
    advisorChecks: [],
    studentNotices: [],
    degreeRequirementInformation,
    planNotes: [{ id: "ccr-ace", title: "CCR/ACE information", description: "Core Curriculum Requirements (CCRs) / Areas of Competency and Engagement (ACEs)",
      items: degreeRequirementInformation.items.map(item => ({ code: item.code, text: item.detail })) }]
  }, template);
  assert.match(html, /<strong>HS<\/strong>/);
  assert.match(html, /<strong>W2<\/strong>/);
  assert.match(html, /<strong>W2<\/strong> <strong>ECO 461<\/strong> also counts toward your Writing 2 \(W2\) requirement\./);
  assert.match(html, /<span class="course" data-course-code="ECO 461" data-requirement-id="eco-capstone">ECO 461<\/span>/);
  assert.match(html, /Core Curriculum Requirements \(CCRs\)/);
  const pdfRenderer = await readFile(new URL("../scripts/render-economics-pdf.py", import.meta.url), "utf8");
  assert.match(pdfRenderer, /<b>\{escape\(item\['code'\]/);
});
