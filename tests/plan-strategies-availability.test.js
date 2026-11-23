import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
  materialPlanDistance,
  semanticPlanSignature
} from "../lib/planning/economics.js";
import { buildEconomicsReport } from "../lib/reports/economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");

function bundle(student) {
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
}

function plannedCourses(plan) {
  return plan.terms.flatMap(term => term.courses.map(course => ({ term, course })));
}

test("default planning exposes only the applicable normal strategies", () => {
  const expected = new Map([
    ["freshman", ["balanced", "explore-first"]],
    ["sophomore", ["balanced", "explore-first"]],
    ["junior", ["balanced"]],
    ["senior", ["balanced"]]
  ]);
  for (const [standing, strategyIds] of expected) {
    const result = bundle({ academicStanding: standing, planCreationDate: "2026-07-30", courses: [] });
    assert.deepEqual(result.candidateOutcomes.map(outcome => outcome.id), strategyIds, standing);
    assert.ok(result.candidateOutcomes.every(outcome => outcome.id !== "one-year-early"), standing);
    assert.ok(result.plans.every(plan => plan.planningContext.planningPace === "standard"), standing);
  }
});

test("One Year Early keeps normal plans intact for eligible standings", () => {
  const horizons = new Map([
    ["freshman", ["Spring/May 2030", "Spring/May 2029"]],
    ["sophomore", ["Spring/May 2029", "Spring/May 2028"]],
    ["junior", ["Spring/May 2028", "Spring/May 2027"]]
  ]);
  for (const [standing, [normalHorizon, earlyHorizon]] of horizons) {
    const result = bundle({ academicStanding: standing, planningPace: "one_year_early", planCreationDate: "2026-07-30", courses: [] });
    const earlyOutcome = result.candidateOutcomes.find(outcome => outcome.id === "one-year-early");
    assert.ok(earlyOutcome, standing);
    assert.equal(result.context.expectedGraduationTerm, normalHorizon, standing);
    assert.equal(result.earlyGraduationContext.expectedGraduationTerm, earlyHorizon, standing);
    assert.ok(result.plans.filter(plan => plan.id !== "one-year-early").every(plan => (
      plan.planningContext.expectedGraduationTerm === normalHorizon
    )), standing);
    const earlyPlan = result.plans.find(plan => plan.id === "one-year-early");
    if (earlyPlan) assert.equal(earlyPlan.planningContext.expectedGraduationTerm, earlyHorizon, standing);
    assert.ok(["VERIFIED_FEASIBLE", "CONDITIONALLY_FEASIBLE", "PRELIMINARY_ONLY", "SEARCH_INCOMPLETE", "NOT_FEASIBLE"].includes(earlyOutcome.status));
  }
});

test("senior One Year Early requests return only standard-horizon strategies", () => {
  for (const standing of ["senior"]) {
    const result = bundle({
      academicStanding: standing,
      planningPace: "one_year_early",
      planCreationDate: "2026-07-30",
      courses: []
    });
    assert.equal(result.context.planningPace, "standard", standing);
    assert.equal(result.context.earlyComparisonRequested, false, standing);
    assert.equal(result.context.planningPaceNormalization.code, "ONE_YEAR_EARLY_NORMALIZED_TO_STANDARD", standing);
    assert.ok(result.candidateOutcomes.every(outcome => outcome.id !== "one-year-early"), standing);
    assert.ok(result.plans.every(plan => plan.planningContext.planningPace === "standard"), standing);
  }
});

test("Explore the Major is lighter at yearIndex zero while foundation sequencing remains soft", () => {
  const freshmanBundle = bundle({ academicStanding: "freshman", planCreationDate: "2026-07-30", courses: [] });
  const freshmanBalanced = freshmanBundle.plans.find(plan => plan.id === "balanced");
  const freshman = freshmanBundle.plans.find(plan => plan.id === "explore-first");
  assert.ok(freshman);
  const freshmanCourses = plannedCourses(freshman);
  const yearZeroLoad = plan => plannedCourses(plan).filter(({ term }) => term.yearIndex === 0).length;
  assert.ok(yearZeroLoad(freshman) < yearZeroLoad(freshmanBalanced));
  assert.equal(freshman.planningContext.expectedGraduationTerm, freshmanBalanced.planningContext.expectedGraduationTerm);
  assert.equal(materialPlanDistance(freshmanBalanced, freshman).materiallyDifferent, true);
  assert.ok(freshmanCourses.some(({ term, course }) => (
    term.yearIndex === 0
    && (["ECO 113", "ECO 114"].includes(course.course) || ["cognate", "statistics"].includes(course.requirementId))
  )));

  const sophomoreBundle = bundle({ academicStanding: "sophomore", planCreationDate: "2026-07-30", courses: [] });
  const sophomoreBalanced = sophomoreBundle.plans.find(plan => plan.id === "balanced");
  const sophomore = sophomoreBundle.plans.find(plan => plan.id === "explore-first");
  assert.ok(sophomore);
  assert.ok(yearZeroLoad(sophomore) < yearZeroLoad(sophomoreBalanced));

  const withHistory = bundle({
    academicStanding: "sophomore",
    planCreationDate: "2026-07-30",
    courses: [{ code: "ECO 113", status: "completed" }, { code: "ECO 213", status: "completed" }]
  }).plans.find(plan => plan.id === "explore-first");
  assert.ok(withHistory);
  assert.equal(plannedCourses(withHistory).some(({ course }) => course.course === "ECO 113"), false);
});

test("Explore the Major label propagates into report JSON and HTML", () => {
  const student = { academicStanding: "freshman", planCreationDate: "2026-07-30", courses: [] };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const planBundle = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const economicsPlan = planBundle.plans.find(plan => plan.id === "explore-first");
  const report = buildEconomicsReport({ student, mapping, schedule, economicsPlan, planBundle, preparedDate: "2026-08-09" });
  const html = renderEconomicsHtml(report, template);
  assert.equal(report.selectedPlan.label, "Explore the Major");
  assert.ok(report.candidateOutcomes.some(outcome => outcome.id === "explore-first" && outcome.label === "Explore the Major"));
  assert.match(html, /data-field="plan-strategy">Explore the Major</);
});

test("dated preliminary evidence stays visible in report JSON and HTML", () => {
  const student = { academicStanding: "freshman", planCreationDate: "2026-07-30", courses: [] };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const planBundle = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const economicsPlan = structuredClone(planBundle.plans[0]);
  const future = economicsPlan.terms.find(term => term.academicYear !== schedule.academicYear && term.courses.some(course => course.source === "projected-offering"));
  assert.ok(future);
  future.courses.find(course => course.source === "projected-offering").preliminaryScheduleEvidence = {
    releaseId: "FICTIONAL-TEST-RELEASE",
    issuedOn: "2026-11-01",
    sourceRefs: ["FICTIONAL-TEST-SCHEDULE#TERM"]
  };
  const report = buildEconomicsReport({ student, mapping, schedule, economicsPlan, planBundle, preparedDate: "2026-11-02" });
  assert.ok(report.terms.some(term => term.courses.some(course => course.preliminaryScheduleEvidence?.issuedOn === "2026-11-01")));
  assert.match(renderEconomicsHtml(report, template), /Preliminary schedule \(2026-11-01\)\. Course and term may change\./);
});

test("generic elective identity does not create a strategy difference, but risk changes do", () => {
  const base = {
    planningContext: { expectedGraduationTerm: "Spring/May 2028", planningPace: "standard" },
    feasibilityStatus: "VERIFIED_FEASIBLE",
    feasibility: { verification: { offerings: "verified" }, requiredApprovals: [], enrollmentConditions: [] },
    terms: [{
      slotId: "fall-2026",
      termKey: "Fall",
      yearIndex: 0,
      courses: [{
        course: "ECO 222",
        requirementId: "eco-elective-1",
        section: "A",
        source: "verified-offering",
        availability: { status: "open", seatsOpen: 4, capacity: 20 },
        meeting: { days: ["Mon"], startMinutes: 600, endMinutes: 660 }
      }]
    }]
  };
  const interchangeable = structuredClone(base);
  interchangeable.terms[0].courses[0].course = "ECO 260";
  interchangeable.terms[0].courses[0].section = "B";
  assert.equal(semanticPlanSignature(base), semanticPlanSignature(interchangeable));
  assert.equal(materialPlanDistance(base, interchangeable).materiallyDifferent, false);

  const riskChanged = structuredClone(interchangeable);
  riskChanged.terms[0].courses[0].availability.status = "full";
  assert.notEqual(semanticPlanSignature(base), semanticPlanSignature(riskChanged));
  assert.equal(materialPlanDistance(base, riskChanged).availability, 1);
});

test("report preserves recorded OPEN/FULL evidence while undated or unverified seats have no current-state claim", () => {
  const economicsPlan = {
    id: "balanced",
    label: "Balanced",
    planningContext: { planningPace: "standard", expectedGraduationTerm: "Spring/May 2027", remainingYears: 1 },
    feasibilityStatus: "CONDITIONALLY_FEASIBLE",
    terms: [{
      term: "Fall 2026",
      displayTerm: "Fall",
      termKey: "Fall",
      academicYear: "2026/2027",
      courses: [
        { course: "ECO 113", section: "A", title: "Microeconomics", source: "verified-offering", availability: { status: "open", seatsOpen: 4, capacity: 20 } },
        { course: "ECO 114", section: "B", title: "Macroeconomics", source: "verified-offering", availability: { status: "full", seatsOpen: 0, capacity: 20 } },
        { course: "ECO 161", section: "C", title: "Foundations", source: "verified-offering", availability: { status: "unknown", seatsOpen: null, capacity: null } }
      ]
    }],
    validation: { warnings: [] },
    advisorChecks: [],
    studentNotices: [],
    advisorNotifications: [],
    prerequisiteNotices: []
  };
  const report = buildEconomicsReport({
    student: { displayName: "Availability Fixture", academicStanding: "senior" },
    mapping: { requirements: [] },
    schedule: {
      academicYear: "2026-2027",
      availabilityAsOf: null,
      terms: {
        Fall: [
          { course: "ECO 113", section: "A", availability: { status: "open", seatsOpen: 4, capacity: 20 } },
          { course: "ECO 114", section: "B", availability: { status: "full", seatsOpen: 0, capacity: 20 } }
        ]
      }
    },
    economicsPlan
  });
  assert.equal(report.availabilityVerification.dateAvailable, false);
  assert.equal(report.terms[0].courses[0].availabilityDisplayEligible, true);
  assert.equal(report.terms[0].courses[1].availabilityDisplayEligible, true);
  assert.equal(report.terms[0].courses[2].availabilityDisplayEligible, false);
  const html = renderEconomicsHtml(report, template);
  assert.equal(report.terms[0].courses[0].availability.status, "open");
  assert.equal(report.terms[0].courses[1].availability.status, "full");
  assert.equal((html.match(/Seat availability not confirmed/g) || []).length, 1);
  assert.equal((html.match(/data-availability-state=/g) || []).length, 3);
  assert.doesNotMatch(html, /availability-(?:open|full)"/);
});
