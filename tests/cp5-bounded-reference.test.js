import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { termLoadEvidenceForSlot } from "../lib/policy/term-load.js";
import {
  PLAN_VARIANTS,
  buildEconomicsTermPlan,
  compareCp5ReferenceCandidates,
  exactPlanSignature,
  materializeCp5ReferenceCandidate,
  semanticPlanSignature
} from "../lib/planning/economics.js";
import { buildPlanningSlots, resolvePlanningContext } from "../lib/planning/horizon.js";
import { normalizeEconomicsSchedule } from "../lib/planning/scheduleProvider.js";
import { solveEconomicsTermPlan, TERM_SOLVER_SOLUTION_BUDGET } from "../lib/planning/termSolver.js";

const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const schedule = normalizeEconomicsSchedule(JSON.parse(await readFile(
  new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url),
  "utf8"
)));
const program = Object.freeze({ id: "economics", name: "Economics" });

function independentBoundedReference({ student, mapping, production }) {
  const context = resolvePlanningContext(student);
  const slots = buildPlanningSlots(context).map((slot, order) => ({
    ...slot,
    order,
    termLoadEvidence: termLoadEvidenceForSlot(student, slot),
    reservedCourseUnits: Number(student.reservedCourseUnits?.[slot.id] || 0)
  }));
  const planVariant = PLAN_VARIANTS.find(variant => variant.id === "balanced");
  const result = solveEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites,
    courseCatalog: [],
    slots,
    context,
    distribution: production.distribution,
    planVariant,
    planningMode: "standard",
    allowConcurrentMath: false,
    policyBundle: runtimePolicyBundle(),
    requireAnnualCoverage: true,
    requireTargetDistribution: true,
    nodeLimit: 25_000,
    solutionBudget: TERM_SOLVER_SOLUTION_BUDGET
  });

  const materialized = result.solutions.map(solution => materializeCp5ReferenceCandidate(production, solution, {
    student,
    mapping,
    schedule,
    prerequisites,
    context,
    policyBundle: runtimePolicyBundle()
  })).filter(candidate => candidate.validation.valid);
  const exact = new Map();
  for (const candidate of materialized) {
    const signature = exactPlanSignature(candidate);
    if (!exact.has(signature)) exact.set(signature, candidate);
  }
  const semantic = new Map();
  for (const candidate of exact.values()) {
    const signature = semanticPlanSignature(candidate);
    const incumbent = semantic.get(signature);
    if (!incumbent || compareCp5ReferenceCandidates(candidate, incumbent, { planVariant, student, prerequisites }) < 0) {
      semantic.set(signature, candidate);
    }
  }
  return {
    result,
    retained: [...semantic.values()]
      .sort((left, right) => compareCp5ReferenceCandidates(left, right, { planVariant, student, prerequisites }))
      .slice(0, 12)
  };
}

test("production top 12 matches an independently reconstructed 100-solution bounded reference", () => {
  const student = { academicStanding: "freshman", planCreationDate: "2026-09-01", courses: [] };
  const mapping = mapStudentToProgram(program, requirements, student);
  const planVariant = PLAN_VARIANTS.find(variant => variant.id === "balanced");
  const production = buildEconomicsTermPlan({ student, mapping, schedule, prerequisites, planVariant });
  const reference = independentBoundedReference({ student, mapping, production });

  assert.equal(reference.result.search.solutionLimit, 100);
  assert.equal(reference.result.search.validSolutionCount, 100);
  assert.equal(production._candidateReserve.length, 12);
  assert.deepEqual(
    production._candidateReserve.map(semanticPlanSignature),
    reference.retained.map(semanticPlanSignature)
  );
});

test("the production comparator has deterministic frozen safety parity", () => {
  const planVariant = PLAN_VARIANTS.find(variant => variant.id === "balanced");
  const common = {
    planningContext: { expectedGraduationTerm: "Spring/May 2030" },
    feasibilityStatus: "VERIFIED_FEASIBLE",
    feasibility: { verification: {}, requiredApprovals: [], enrollmentConditions: [] },
    validation: { conditions: [] },
    distribution: { targetYearCounts: [2, 2] }
  };
  const even = {
    ...common,
    terms: [
      { slotId: "fall-0", termKey: "Fall", yearIndex: 0, courses: [{ requirementId: "a", course: "ECO 113", source: "verified-offering" }] },
      { slotId: "winter-0", termKey: "Winter", yearIndex: 0, courses: [{ requirementId: "b", course: "ECO 114", source: "verified-offering" }] },
      { slotId: "fall-1", termKey: "Fall", yearIndex: 1, courses: [{ requirementId: "c", course: "ECO 213", source: "projected-offering" }] },
      { slotId: "winter-1", termKey: "Winter", yearIndex: 1, courses: [{ requirementId: "eco-461", course: "ECO 461", source: "projected-offering" }] }
    ]
  };
  const concentrated = structuredClone(even);
  concentrated.terms[1].courses.push(concentrated.terms[2].courses.pop());
  assert.ok(compareCp5ReferenceCandidates(even, concentrated, { planVariant, student: {}, prerequisites }) < 0);
  assert.equal(compareCp5ReferenceCandidates(even, structuredClone(even), { planVariant, student: {}, prerequisites }), 0);
});
