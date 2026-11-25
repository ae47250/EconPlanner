import test from "node:test";
import assert from "node:assert/strict";
import { takingNowNotOfferedCourses } from "../lib/planning/plan-presentation.js";
import { loadEconomicsPolicyCompatibility } from "../lib/policy/compat-normalized.js";
import { POST } from "../app/api/majors/map/route.js";

const schedule = loadEconomicsPolicyCompatibility().schedule;
const fall2026 = { startTerm: "Fall", currentAcademicYearStart: 2026 };
const taking = (...codes) => ({ courses: codes.map(code => ({ code, status: "in_progress" })) });

test("a taking-now course missing from a complete term schedule is flagged", () => {
  assert.deepEqual(takingNowNotOfferedCourses({ student: taking("ECO 214"), planningContext: fall2026, schedule }),
    [{ course: "ECO 214", term: "Fall 2026" }]);
});

test("offered courses, partial-coverage subjects, other years and May are not flagged", () => {
  assert.deepEqual(takingNowNotOfferedCourses({ student: taking("ECO 213"), planningContext: fall2026, schedule }), []);
  assert.deepEqual(takingNowNotOfferedCourses({ student: taking("MAT 217"), planningContext: fall2026, schedule }), []);
  assert.deepEqual(takingNowNotOfferedCourses({ student: taking("ECO 214"), planningContext: { startTerm: "Fall", currentAcademicYearStart: 2025 }, schedule }), []);
  assert.deepEqual(takingNowNotOfferedCourses({ student: taking("ECO 214"), planningContext: { startTerm: "Spring", currentAcademicYearStart: 2026 }, schedule }), []);
  assert.deepEqual(takingNowNotOfferedCourses({ student: { courses: [{ code: "ECO 214", status: "completed" }] }, planningContext: fall2026, schedule }), []);
  // A summer plan starts at Fall, but a summer "taking now" course is a summer course.
  assert.deepEqual(takingNowNotOfferedCourses({ student: taking("ECO 214"), planningContext: { ...fall2026, isSummer: true }, schedule }), []);
});

test("the planner still builds plans and adds a non-blocking advisor note", async () => {
  const student = { planCreationDate: "2026-09-10", academicStanding: "sophomore", courses: [
    ...["ECO 113", "ECO 114", "MAT 113"].map(code => ({ code, status: "completed", source: "manual_code" })),
    { code: "ECO 214", status: "in_progress", source: "manual_code" }] };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  const plans = (await response.json()).programs[0].economicsPlans;
  assert.ok(plans.length > 0);
  for (const plan of plans) {
    const note = plan.planConditions.find(item => item.id === "taking-now-not-offered-ECO 214");
    assert.equal(note?.message, "ECO 214 is not on the Fall 2026 schedule. If you are taking it at another school, your advisor will check whether it counts.");
    assert.equal(note.shortMessage, undefined);
    assert.equal(note.advisorPrompt, "Confirm where the student is taking ECO 214 in Fall 2026. It is not on the Hanover Fall 2026 schedule.");
  }
});
