import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/majors/map/route.js";

const MOVE = new Set(["id", "label", "status", "message", "reasonCode", "reasonCodes", "reasonTerm", "reasonRecurringTerms",
  "reasonCourse", "requiredApprovals", "ruleId", "loadDecision", "dependentCanMoveLater"]);
const REPLACE = new Set([...MOVE, "toTermId", "course", "title", "minimumLevel"]);

test("plans sent to the browser carry only the move fields the screen reads", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: { academicStanding: "freshman", planCreationDate: "2026-09-01", courses: [] } }) }));
  assert.equal(response.status, 200);
  const program = (await response.json()).programs[0];
  const plans = [...program.economicsPlans, program.economicsPlan].filter(Boolean);
  let moveOptions = 0;
  for (const plan of plans) for (const term of plan.terms) for (const course of term.courses || []) {
    assert.equal("moveNoAlternativeNotice" in course, false);
    for (const option of course.moveDestinationOptions || []) {
      moveOptions += 1;
      for (const key of Object.keys(option)) assert.ok(MOVE.has(key), `unexpected move field ${key}`);
      if (option.loadDecision) assert.deepEqual(Object.keys(option.loadDecision).sort(), ["reasonCode", "status"]);
    }
    for (const option of course.replacementDestinationOptions || []) {
      for (const key of Object.keys(option)) assert.ok(REPLACE.has(key), `unexpected replacement field ${key}`);
    }
  }
  assert.ok(moveOptions > 0, "the reply still contains move options");
});
