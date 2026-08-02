import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
  semanticPlanSignature,
  validateGeneratedPlan
} from "../lib/planning/economics.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));

const completed = codes => codes.map(code => ({ code, status: "completed" }));

function generate(student) {
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return {
    mapping,
    bundle: buildEconomicsTermPlans({ student, mapping, schedule, prerequisites })
  };
}

test("preliminary plans expose approvals independently from the overall status", () => {
  const student = {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: completed(["ECO 113", "ECO 114", "MAT 113", "ECO 213"])
  };
  const { bundle } = generate(student);
  const plan = bundle.plans[0];
  const departmentApproval = plan.feasibility.requiredApprovals.find(item => (
    item.course === "ECO 461" && item.prerequisite === "ECO 214"
  ));

  assert.equal(plan.feasibility.overallStatus, "PRELIMINARY_ONLY");
  assert.equal(departmentApproval.authority, "Economics Department");
  assert.match(departmentApproval.sourceRef, /Department_Confirmed_Planning_Policies/);
  assert.equal(plan.feasibility.search.limit, 250000);
  assert.ok(plan.feasibility.search.nodesVisited <= plan.feasibility.search.limit);
});

test("generated plans cover every remaining academic year and suppress semantic duplicates with reasons", () => {
  const student = { academicStanding: "freshman", planCreationDate: "2026-09-01", courses: [] };
  const { mapping, bundle } = generate(student);
  for (const plan of bundle.plans) {
    const years = [...new Set(plan.terms.filter(term => !term.isSummer).map(term => term.yearIndex))];
    if (mapping.strict.remainingUnits >= years.length) {
      assert.ok(years.every(yearIndex => plan.terms.some(term => (
        term.yearIndex === yearIndex && term.courses.length > 0
      ))));
    }
    assert.ok(plan.terms.every(term => term.courses.length <= (["Spring", "May"].includes(term.termKey) ? 1 : 4)));
  }
  const signatures = bundle.plans.map(semanticPlanSignature);
  assert.equal(new Set(signatures).size, signatures.length);
  assert.ok(bundle.candidateOutcomes.filter(item => !item.displayed).every(item => item.suppressionReason));
});

test("a selected elective alternative survives validation and exact report regeneration", async () => {
  const student = {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    entryCatalogYear: "2025-2026",
    courses: completed(["ECO 113", "ECO 114", "MAT 113", "ECO 214"])
  };
  const { mapping, bundle } = generate(student);
  const selectedPlan = structuredClone(bundle.plans[0]);
  const term = selectedPlan.terms.find(item => item.courses.some(course => course.alternativeOptions?.length > 1));
  const course = term.courses.find(item => item.alternativeOptions?.length > 1);
  const alternative = course.alternativeOptions.find(item => item.id !== course.selectedOptionId);
  Object.assign(course, alternative, {
    requirementId: course.requirementId,
    selectedOptionId: alternative.id,
    alternativeOptions: course.alternativeOptions
  });

  const validation = validateGeneratedPlan(selectedPlan, {
    student,
    mapping,
    schedule,
    prerequisites,
    context: bundle.context
  });
  assert.equal(validation.valid, true);

  const reportStudent = { ...student };
  delete reportStudent.planCreationDate;
  const report = await buildEconomicsReportFromStudent(reportStudent, "2026-07-30", selectedPlan);
  const reported = report.terms.flatMap(item => item.courses).find(item => item.requirementId === course.requirementId);
  assert.equal(reported.code, alternative.course);
  assert.equal(reported.selectedOptionId, alternative.id);
});
