import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/majors/map/route.js";

// A freshman asking to graduate in May 2028 cannot reach senior standing in any Winter term before
// then, so ECO 461 cannot fit. The rule proves this; the full plan search used to take over a minute.
test("an impossible early graduation target is answered from the rule, without the full search", async () => {
  const student = { planCreationDate: "2026-11-21", academicStanding: "freshman",
    customGraduationEnabled: true, customExpectedGraduationYear: 2028, courses: [] };
  const started = performance.now();
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  const elapsed = performance.now() - started;
  assert.equal(response.status, 200);
  const result = (await response.json()).programs[0].economicsPlanResult;
  assert.equal(result.category, "INFEASIBLE_PROVEN");
  assert.equal(result.reason, "CAPSTONE_SENIOR_STANDING_NO_ELIGIBLE_WINTER");
  assert.ok(elapsed < 20000, `took ${Math.round(elapsed)} ms`);
});
