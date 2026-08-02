import test from "node:test";
import assert from "node:assert/strict";
import { expandRequirementExpression } from "../lib/requirements/dsl.js";
import { mapStudentToProgram } from "../lib/assignment/solve.js";

const program = { id: "dsl-example", name: "DSL example", sourceStatus: "APPROVED_LOCAL_SOURCE" };

test("DSL expands ALL_OF, ANY_OF, and CHOOSE_N deterministically", () => {
  const all = expandRequirementExpression({ type: "ALL_OF", children: [
    { type: "EXACT_COURSE", code: "ECO 113" },
    { type: "ANY_OF", children: [{ type: "EXACT_COURSE", code: "ECO 114" }, { type: "EXACT_COURSE", code: "ECO 213" }] }
  ]});
  const choose = expandRequirementExpression({ type: "CHOOSE_N", n: 2, children: [
    { type: "EXACT_COURSE", code: "ECO 221" },
    { type: "EXACT_COURSE", code: "ECO 222" },
    { type: "EXACT_COURSE", code: "ECO 234" }
  ]});

  assert.equal(all.length, 2);
  assert.equal(all[0].length, 2);
  assert.equal(choose.length, 3);
  assert.equal(choose[2][1].options[0], "ECO 234");
});

test("solver chooses the best ANY_OF branch without double counting", () => {
  const result = mapStudentToProgram(program, {
    id: "dsl-example",
    requirementTree: { type: "ALL_OF", children: [
      { type: "EXACT_COURSE", id: "base", code: "ECO 113", units: 1 },
      { type: "ANY_OF", children: [
        { type: "EXACT_COURSE", id: "macro", code: "ECO 114", units: 1 },
        { type: "EXACT_COURSE", id: "micro-again", code: "ECO 113", units: 1 }
      ] }
    ]}
  }, { courses: [{ code: "ECO 113", status: "completed" }, { code: "ECO 114", status: "completed" }] });

  assert.equal(result.strict.remainingUnits, 0);
  assert.deepEqual(result.strict.assignments.map(item => item.code), ["ECO 113", "ECO 114"]);
});
