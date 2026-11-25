import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/majors/map/route.js";

const completed = codes => codes.map(code => ({ code, status: "completed", source: "manual_code" }));
const core = ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 257", "ECO 321", "MAT 113"];

async function planResult(extra) {
  const student = { planCreationDate: "2026-10-15", academicStanding: "senior", courses: completed([...core, ...extra]) };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  return (await response.json()).programs[0];
}

test("a senior short of elective room is told how many electives are needed and how many can fit", async () => {
  const program = await planResult(["ECO 161"]);
  assert.equal(program.economicsPlans.length, 0);
  assert.equal(program.economicsPlanResult.category, "INFEASIBLE_PROVEN");
  const blocker = program.economicsPlanResult.evidence.blockingReasons.find(item => item.code === "ELECTIVE_CAPACITY_EXCEEDED");
  assert.equal(blocker?.message, "You need 3 more Economics electives, but at most 2 can fit in the terms left by May 2027. Choose a later graduation year or talk with your advisor.");
});

test("no elective shortfall is reported when a plan exists", async () => {
  const program = await planResult(["ECO 333"]);
  assert.ok(program.economicsPlans.length > 0);
  assert.equal(program.economicsPlanResult.evidence.blockingReasons.some(item => item.code === "ELECTIVE_CAPACITY_EXCEEDED"), false);
});
