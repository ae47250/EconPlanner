// Owner request 2026-11-26: "Not possible" must not rest on a missing answer. When a course marked
// Completed has an unmarked prerequisite, the student is asked to mark it first.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { noPlanPresentation, noPlanStatusLabel } from "../lib/planning/no-plan-presentation.js";

const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const senior = codes => ({ displayName: "Fictional student", academicStanding: "senior", planCreationDate: "2026-11-22",
  courses: codes.map(code => ({ code, status: "completed" })) });
async function economics(student) {
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  return (await response.json()).programs.find(item => item.program?.id === "economics-base");
}

test("completed ECO 213 without its math course: ask to mark it, not 'Not possible'", async () => {
  const student = senior(["ECO 113", "ECO 114", "ECO 213", "MAT 217", "ECO 333", "ECO 234"]);
  const result = (await economics(student)).economicsPlanResult;
  assert.equal(result.reason, "UNMARKED_PREREQUISITE");
  assert.equal(noPlanStatusLabel(result), "Needs one more detail");
  const shown = noPlanPresentation(result.category, result.reason, result.evidence);
  assert.equal(shown.title, "Did you already take MAT 113 or MAT 121?");
  assert.equal(shown.message, "ECO 213 is marked completed, but MAT 113 or MAT 121 is not marked. Mark it, or your advisor will check. With your current answers, no plan fits. Once it is marked, a plan fits.");
  // The old "cannot all fit" reason is kept in the record but not shown next to the request to mark.
  assert.deepEqual(result.evidence.blockingReasons.map(item => item.code), ["UNMARKED_PREREQUISITE"]);
  assert.equal(result.evidence.provenReasonWithCurrentAnswers, "MAJOR_COURSE_CAPACITY_EXCEEDED");
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate), template);
  assert.match(html, /<h2>Needs one more detail<\/h2>/);
  assert.doesNotMatch(html, /<h2>Not possible<\/h2>/);

  // The prompt is right: once the math course is marked, a plan fits.
  const marked = await economics(senior([...student.courses.map(item => item.code), "MAT 121"]));
  assert.ok(marked.economicsPlans.length > 0);
});

test("no unmarked prerequisite: a plan that cannot fit is still 'Not possible'", async () => {
  const result = (await economics(senior(["ECO 113", "ECO 114", "MAT 121", "MAT 217"]))).economicsPlanResult;
  assert.equal(result.category, "INFEASIBLE_PROVEN");
  assert.equal(noPlanStatusLabel(result), "Not possible");
});

test("a course marked Taking now with an unmarked prerequisite gets the same question", async () => {
  const student = senior(["ECO 113", "ECO 114", "MAT 217", "ECO 333", "ECO 234"]);
  student.courses.push({ code: "ECO 213", status: "in_progress" });
  const result = (await economics(student)).economicsPlanResult;
  assert.equal(result.reason, "UNMARKED_PREREQUISITE");
  student.courses.push({ code: "MAT 121", status: "completed" });
  assert.ok((await economics(student)).economicsPlans.length > 0, "marking MAT 121 gives a plan");
});

test("when marking the missing course could not make the courses fit, the student keeps 'Not possible'", async () => {
  for (const codes of [["ECO 213"], ["ECO 113", "ECO 114", "ECO 213", "ECO 214"], ["ECO 113", "ECO 333"],
    // Another real blocker remains after marking (review 2026-11-26): statistics before ECO 461, and the elective count.
    ["ECO 113", "ECO 114", "ECO 213", "ECO 333", "ECO 234", "ECO 221"], ["ECO 461"]]) {
    const result = (await economics(senior(codes))).economicsPlanResult;
    assert.equal(result.category, "INFEASIBLE_PROVEN", codes.join(", "));
    assert.equal(noPlanStatusLabel(result), "Not possible", codes.join(", "));
  }
});
