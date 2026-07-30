import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanningSlots, resolvePlanningContext } from "../lib/planning/horizon.js";

test("Fall freshman planning excludes the running Fall and maps through Spring/May 2030", () => {
  const context = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-09-01"
  });
  const slots = buildPlanningSlots(context);

  assert.equal(context.remainingYears, 4);
  assert.equal(context.expectedGraduationTerm, "Spring/May 2030");
  assert.equal(slots[0].label, "Winter 2027");
  assert.equal(slots[0].displayTerm, "Winter");
  assert.equal(slots[0].academicYear, "2026/2027");
  assert.equal(context.entryCatalogYear, "2026-2027");
  assert.equal(context.declarationCatalogYear, null);
  assert.equal(slots.at(-1).label, "Spring/May 2030");
});

test("a February 1 plan excludes Winter and starts with Spring/May", () => {
  const context = resolvePlanningContext({
    academicStanding: "sophomore",
    planCreationDate: "2027-02-01"
  });
  const slots = buildPlanningSlots(context);

  assert.equal(context.startTerm, "Winter");
  assert.equal(slots[0].label, "Spring/May 2027");
  assert.ok(!slots.some(slot => slot.label === "Winter 2027"));
});

test("summer freshman standing requires an explicit upcoming-Fall answer", () => {
  const context = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-07-26"
  });

  assert.equal(context.requiresSummerClarification, true);
  assert.equal(
    context.question,
    "Will you be a freshman in Fall 2026, or were you a freshman during last May term?"
  );
});

test("Summer 2026 uses the official Spring-end and Fall-start boundaries", () => {
  const springEnd = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-05-22"
  });
  const summerStart = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-05-23"
  });
  const summerEnd = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-08-23"
  });
  const fallStart = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-08-24"
  });

  assert.equal(springEnd.requiresSummerClarification, false);
  assert.equal(springEnd.startTerm, "Spring");
  assert.equal(summerStart.requiresSummerClarification, true);
  assert.equal(summerEnd.requiresSummerClarification, true);
  assert.equal(fallStart.requiresSummerClarification, false);
  assert.equal(fallStart.startTerm, "Fall");
  assert.equal(fallStart.startYear, 2026);
});

test("summer planning requires clarification for every class standing", () => {
  for (const academicStanding of ["freshman", "sophomore", "junior", "senior"]) {
    const context = resolvePlanningContext({
      academicStanding,
      planCreationDate: "2026-07-26"
    });

    assert.equal(context.requiresSummerClarification, true);
    assert.match(context.question, new RegExp(academicStanding));
  }
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
  assert.equal(buildPlanningSlots(upcomingFall)[0].label, "Fall 2026");
  assert.equal(afterSpring.effectiveStanding, "senior");
  assert.equal(afterSpring.remainingYears, 1);
  assert.equal(afterSpring.expectedGraduationTerm, "Spring/May 2027");
});

test("catalog years use the standing and academic year containing the plan date", () => {
  const winterSophomore = resolvePlanningContext({
    academicStanding: "sophomore",
    planCreationDate: "2027-01-10"
  });
  const springJunior = resolvePlanningContext({
    academicStanding: "junior",
    planCreationDate: "2027-04-10"
  });

  assert.equal(winterSophomore.entryCatalogYear, "2025-2026");
  assert.equal(winterSophomore.declarationCatalogYear, "2026-2027");
  assert.equal(springJunior.entryCatalogYear, "2024-2025");
  assert.equal(springJunior.declarationCatalogYear, "2026-2027");
});

test("summer catalog years follow the explicit standing answer", () => {
  const upcomingFall = resolvePlanningContext({
    academicStanding: "sophomore",
    planCreationDate: "2026-07-26",
    summerStandingConfirmed: "yes"
  });
  const afterSpring = resolvePlanningContext({
    academicStanding: "sophomore",
    planCreationDate: "2026-07-26",
    summerStandingConfirmed: "no"
  });

  assert.equal(upcomingFall.entryCatalogYear, "2025-2026");
  assert.equal(upcomingFall.declarationCatalogYear, "2026-2027");
  assert.equal(afterSpring.entryCatalogYear, "2024-2025");
  assert.equal(afterSpring.declarationCatalogYear, "2025-2026");
});
