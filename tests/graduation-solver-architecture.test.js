import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
  PLAN_VARIANTS,
  semanticPlanSignature,
  validateGeneratedPlan
} from "../lib/planning/economics.js";
import { solveEconomicsTermPlan } from "../lib/planning/termSolver.js";
import { buildPlanningSlots, resolvePlanningContext } from "../lib/planning/horizon.js";
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

function planningSlots(student) {
  return buildPlanningSlots(resolvePlanningContext(student)).map((slot, order) => ({
    ...slot,
    order,
    reservedCourseUnits: 0
  }));
}

function verifiedSupportingOffering(course, section, status, meeting) {
  return {
    course,
    section,
    title: `${course} test section`,
    units: 1,
    instructor: "Department",
    availability: { status, seatsOpen: status === "open" ? 4 : 0, capacity: 20, asOf: "2026-07-28" },
    meeting,
    verificationStatus: "verified",
    provenance: { sourceType: "test", verifiedOn: "2026-07-28" }
  };
}

test("the solver retains deterministic, prerequisite-valid complete schedules", () => {
  const student = { academicStanding: "freshman", planCreationDate: "2026-09-01", courses: [] };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const slots = planningSlots(student);
  const solved = solveEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites,
    slots,
    context: resolvePlanningContext(student),
    distribution: { targetYearCounts: [3, 3, 3, 3], targetTermCounts: {} },
    requireTargetDistribution: true,
    solutionBudget: 3
  });

  assert.equal(solved.solutions.length, 3);
  assert.deepEqual(solved.solution, solved.solutions[0].plan);
  assert.equal(solved.search.terminationReason, "SOLUTION_BUDGET");
  assert.equal(solved.search.complete, false);
  assert.equal(new Set(solved.solutions.map(item => item.signature)).size, solved.solutions.length);
  assert.ok(solved.search.orderingTrace.length > 0);
  assert.ok(solved.search.orderingTrace.length <= 24);
  for (const decision of solved.search.orderingTrace) {
    assert.equal(decision.selectedOrderingRank, 1);
    assert.equal(decision.requirementId, decision.candidateOrdering[0].requirementId);
    assert.equal(decision.dependencyPriority, Math.min(...decision.candidateOrdering.map(candidate => candidate.dependencyPriority)));
  }

  const rescue = solveEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites,
    slots,
    context: resolvePlanningContext(student),
    distribution: { targetYearCounts: [3, 3, 3, 3], targetTermCounts: {} },
    requireTargetDistribution: false,
    solutionBudget: 1,
    searchStrategy: "rescue"
  });
  for (const decision of rescue.search.orderingTrace) {
    assert.equal(decision.legalPlacementCount, Math.min(...decision.candidateOrdering.map(candidate => candidate.legalPlacementCount)));
  }

  const continued = solveEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites,
    slots,
    context: resolvePlanningContext(student),
    distribution: { targetYearCounts: [3, 3, 3, 3], targetTermCounts: {} },
    requireTargetDistribution: true,
    solutionBudget: 3,
    excludedSolutionSignatures: solved.solutions.map(item => item.signature)
  });
  assert.equal(continued.solutions.length, 3);
  assert.equal(
    continued.solutions.some(item => solved.solutions.some(previous => previous.signature === item.signature)),
    false
  );
});

test("Explore First gives sophomores the introductory, intermediate, and statistics sequence before electives", () => {
  const supportingSchedule = structuredClone(schedule);
  supportingSchedule.terms.Fall.push(
    verifiedSupportingOffering("MAT 217", "A", "waitlisted", {
      days: ["Mon", "Wed"], startTime: "2:20 PM", endTime: "3:30 PM", startDate: "2026-08-24", endDate: "2026-12-11"
    }),
    verifiedSupportingOffering("PSY 217", "B", "open", {
      days: ["Tue", "Thu"], startTime: "2:20 PM", endTime: "3:30 PM", startDate: "2026-08-24", endDate: "2026-12-11"
    })
  );
  const student = {
    academicStanding: "sophomore",
    planCreationDate: "2026-07-30",
    courses: completed(["ECO 113", "MAT 113"])
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const bundle = buildEconomicsTermPlans({ student, mapping, schedule: supportingSchedule, prerequisites });
  const plan = bundle.plans.find(item => item.id === "plan-3");
  const firstYear = plan.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses);

  assert.ok(firstYear.some(course => course.course === "ECO 114"));
  assert.ok(firstYear.some(course => course.course === "ECO 213"));
  assert.ok(firstYear.some(course => ["ECO 257", "MAT 217", "PSY 217", "Statistics requirement"].includes(course.course)));
  assert.ok(!firstYear.some(course => String(course.requirementId).startsWith("eco-elective")));

  const mirrorStudent = {
    ...student,
    courses: completed(["ECO 114", "MAT 113"])
  };
  const mirrorMapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, mirrorStudent);
  const mirror = buildEconomicsTermPlans({ student: mirrorStudent, mapping: mirrorMapping, schedule: supportingSchedule, prerequisites })
    .plans.find(item => item.id === "plan-3");
  const mirrorFirstYear = mirror.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses);
  assert.ok(mirrorFirstYear.some(course => course.course === "ECO 113"));
  assert.ok(mirrorFirstYear.some(course => course.course === "ECO 214"));
  assert.ok(mirrorFirstYear.some(course => ["ECO 257", "MAT 217", "PSY 217", "Statistics requirement"].includes(course.course)));
});

test("Plan C is not considered for junior or senior students", () => {
  for (const academicStanding of ["junior", "senior"]) {
    const student = { academicStanding, planCreationDate: "2026-07-30", courses: [] };
    const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
    const bundle = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
    assert.ok(!bundle.candidateOutcomes.some(item => item.id === PLAN_VARIANTS[2].id));
  }
});

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
    assert.ok(plan.terms.every(term => {
      if (term.termKey !== "TBC") return term.courses.length <= (["Spring", "May"].includes(term.termKey) ? 1 : 4);
      const projectedCounts = term.courses.reduce((counts, course) => {
        const projectedTerm = course.projectedTerm || "TBC";
        counts[projectedTerm] = (counts[projectedTerm] || 0) + 1;
        return counts;
      }, {});
      return Object.entries(projectedCounts).every(([projectedTerm, count]) => (
        count <= (["Spring", "May"].includes(projectedTerm) ? 1 : 4)
      ));
    }));
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
