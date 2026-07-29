import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanningSlots, resolvePlanningContext } from "../lib/planning/horizon.js";

test("Fall freshman planning maps four academic years through Spring/May 2030", () => {
  const context = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-09-01"
  });
  const slots = buildPlanningSlots(context);

  assert.equal(context.remainingYears, 4);
  assert.equal(context.expectedGraduationTerm, "Spring/May 2030");
  assert.equal(slots[0].label, "Fall 2026");
  assert.equal(slots.at(-1).label, "Spring/May 2030");
});

test("summer freshman standing requires an explicit upcoming-Fall answer", () => {
  const context = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-07-26"
  });

  assert.equal(context.requiresSummerClarification, true);
  assert.equal(
    context.question,
    "Do you mean you will be a freshman in Fall 2026, or that you were a freshman during the 2025\u201326 academic year?"
  );
});

test("summer answer yes keeps the standing and answer no advances it", () => {
  const upcomingFall = resolvePlanningContext({
    academicStanding: "junior",
    planCreationDate: "2026-07-26",
    summerStandingConfirmed: "yes"
  });
  const afterSpring = resolvePlanningContext({
    academicStanding: "junior",
    planCreationDate: "2026-07-26",
    summerStandingConfirmed: "no"
  });

  assert.equal(upcomingFall.effectiveStanding, "junior");
  assert.equal(upcomingFall.remainingYears, 2);
  assert.equal(upcomingFall.expectedGraduationTerm, "Spring/May 2028");
  assert.equal(afterSpring.effectiveStanding, "senior");
  assert.equal(afterSpring.remainingYears, 1);
  assert.equal(afterSpring.expectedGraduationTerm, "Spring/May 2027");
});
