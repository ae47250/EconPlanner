import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/majors/map/route.js";

const done = ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 257", "ECO 321", "MAT 113", "ECO 333", "ECO 221", "ECO 222"];
async function firstPlan(courses) {
  const student = { planCreationDate: "2026-10-15", academicStanding: "senior",
    courses: courses.map(code => ({ code, status: "completed", source: "manual_code" })) };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  return (await response.json()).programs[0].economicsPlans[0];
}

test("a senior who completed ECO 461 is not scheduled for it again and gets an advisor note", async () => {
  const plan = await firstPlan([...done, "ECO 461"]);
  assert.ok(plan);
  assert.equal(plan.terms.some(term => (term.courses || []).some(course => course.course === "ECO 461")), false);
  const note = plan.planConditions.find(item => item.id === "hanover-only-completed-ECO 461");
  assert.equal(note?.message, "You marked ECO 461 as completed. Your advisor will confirm it.");
  assert.equal(note.advisorPrompt, "Confirm the student completed ECO 461 at Hanover College.");
});

test("without ECO 461 completed, it is scheduled and no note is added", async () => {
  const plan = await firstPlan(done);
  assert.ok(plan.terms.some(term => (term.courses || []).some(course => course.course === "ECO 461")));
  assert.equal(plan.planConditions.some(item => item.id === "hanover-only-completed-ECO 461"), false);
});

async function program(standing, courses) {
  const student = { planCreationDate: "2026-10-15", academicStanding: standing, courses };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  return (await response.json()).programs[0];
}

test("the server ignores ECO 461 marked completed by a non-senior, or marked taking now", async () => {
  const recorded = codes => codes.map(code => ({ code, status: "completed", source: "manual_code" }));
  for (const [standing, status, history] of [["junior", "completed", recorded(["ECO 113", "ECO 114"])], ["senior", "in_progress", recorded(done)]]) {
    const result = await program(standing, [...history, { code: "ECO 461", status, source: "manual_code" }]);
    const plan = result.economicsPlans[0];
    assert.ok(plan, `${standing} ${status}`);
    assert.ok(plan.terms.some(term => (term.courses || []).some(course => course.course === "ECO 461")), `${standing} ${status} keeps ECO 461 in the plan`);
    assert.equal(plan.planConditions.some(item => item.id === "hanover-only-completed-ECO 461"), false);
  }
});
