import test from "node:test";
import assert from "node:assert/strict";
import { noPlanPresentation } from "../lib/planning/no-plan-presentation.js";

const prerequisites = { "ECO 214": { all: ["ECO 114"] } };
const prerequisiteEvidence = {
  searchAttempts: [{ complete: true, solutionFound: false, emptyDomains: ["eco-114"] }],
  planningGaps: [
    { course: "ECO 114", requirementId: "eco-114" },
    { course: "ECO 214", requirementId: "eco-214" }
  ]
};

test("count-capacity proof controls the explanation despite prerequisite-shaped gaps", () => {
  const presentation = noPlanPresentation("INFEASIBLE_PROVEN", "COUNT_CAPACITY", prerequisiteEvidence, prerequisites);
  assert.match(presentation.title, /Your remaining classes do not fit before this graduation target\./);
  assert.doesNotMatch(presentation.title, /prerequisite|ECO 114/);
});

test("a matched prerequisite empty domain retains its specific explanation for proven infeasibility", () => {
  const presentation = noPlanPresentation("INFEASIBLE_PROVEN", "EMPTY_DOMAIN", prerequisiteEvidence, prerequisites);
  assert.match(presentation.title, /ECO 114 is a prerequisite for ECO 214 and could not be placed first/);
  assert.match(presentation.message, /course history and graduation target/);
});

test("unsupported prerequisite gaps do not override unknown or incomplete-search outcomes", () => {
  const incomplete = noPlanPresentation("SEARCH_INCOMPLETE", "SEARCH_INCOMPLETE", prerequisiteEvidence, prerequisites);
  assert.match(incomplete.message, /does not mean a plan is impossible/);
  assert.match(noPlanPresentation("NEEDS_ADVISOR_ATTENTION", "UNEXPLAINED", prerequisiteEvidence, prerequisites).title, /advisor attention/);
  assert.match(noPlanPresentation("NEEDS_ADVISOR_ATTENTION", "MISSING_OFFERING").message, /does not establish that major completion is impossible/);
});

test("blocked input keeps its direct next step", () => {
  assert.equal(noPlanPresentation("INPUT_BLOCKED", "INVALID_INPUT").action, "Review my answers");
});
