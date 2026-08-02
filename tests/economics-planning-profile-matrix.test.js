import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { buildEconomicsTermPlans, semanticPlanSignature } from "../lib/planning/economics.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/economics-planning-profile-matrix.json", import.meta.url), "utf8"));
const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));

function generate(standing, profile) {
  const student = {
    academicStanding: standing,
    planCreationDate: fixture.planCreationDate,
    courses: profile.courses.map(code => ({ code, status: "completed" }))
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return {
    mapping,
    result: buildEconomicsTermPlans({ student, mapping, schedule, prerequisites })
  };
}

test("the 51-profile audit matrix returns only complete, distinct, bounded-search plans", () => {
  const outcomes = [];
  for (const standing of fixture.standings) {
    for (const profile of fixture.profiles) {
      const { mapping, result } = generate(standing, profile);
      const id = `${standing[0].toUpperCase()}${profile.id}`;
      outcomes.push({ id, standing, profile, mapping, result });

      const limit = standing === "junior" ? 2 : 4;
      assert.ok(result.plans.length <= limit, `${id} exceeds the standing-specific display limit`);
      assert.equal(new Set(result.plans.map(semanticPlanSignature)).size, result.plans.length, `${id} has a semantic duplicate`);
      assert.ok(result.plans.every(plan => plan.validation.valid), `${id} displayed an invalid plan`);
      assert.ok(result.plans.every(plan => plan.feasibility.search.nodesVisited <= 250000), `${id} exceeded the deterministic search limit`);
      assert.ok(result.candidateOutcomes.filter(item => !item.displayed).every(item => item.suppressionReason), `${id} omitted a suppression reason`);
    }
  }

  assert.equal(outcomes.length, 51);
  assert.ok(outcomes.find(item => item.id === "FW5").result.plans.some(plan => plan.id === "plan-c2"));
  assert.ok(outcomes.find(item => item.id === "SW5").result.plans.some(plan => plan.id === "plan-c2"));

  const juniorP3 = outcomes.find(item => item.id === "JP3");
  const juniorP3Early = juniorP3.result.candidateOutcomes.find(item => item.id === "plan-c2");
  assert.equal(juniorP3Early.displayed, false);
  assert.ok(juniorP3Early.suppressionReason);
});
