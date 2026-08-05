import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanningSlots,
  PLANNING_PACES,
  PROJECTED_SENIOR_STANDING_CONFIRMATION_STATUS,
  resolvePlanningContext,
  transferPlanningOptions
} from "../lib/planning/horizon.js";

function seniorConfirmation(academicYear) {
  return {
    status: PROJECTED_SENIOR_STANDING_CONFIRMATION_STATUS,
    academicYear
  };
}

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

test("summer standing always means the upcoming Fall", () => {
  const context = resolvePlanningContext({
    academicStanding: "junior",
    planCreationDate: "2026-07-26"
  });

  assert.equal(context.requiresSummerClarification, false);
  assert.equal(context.standingBasis, "upcoming_fall");
  assert.equal(context.effectiveStanding, "junior");
  assert.equal(context.remainingYears, 2);
  assert.equal(context.expectedGraduationTerm, "Spring/May 2028");
  assert.equal(buildPlanningSlots(context)[0].label, "Fall 2026");
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

  assert.equal(springEnd.isSummer, false);
  assert.equal(springEnd.startTerm, "Spring");
  assert.equal(summerStart.isSummer, true);
  assert.equal(summerEnd.isSummer, true);
  assert.equal(fallStart.isSummer, false);
  assert.equal(fallStart.startTerm, "Fall");
  assert.equal(fallStart.startYear, 2026);
});

test("a published Spring/May end starts summer even before the next Fall calendar is available", () => {
  const springEnd = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2027-05-28"
  });
  const followingDay = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2027-05-29"
  });

  assert.equal(springEnd.isSummer, false);
  assert.equal(followingDay.isSummer, true);
  assert.equal(followingDay.standingBasis, "upcoming_fall");
});

test("summer planning accepts every class standing without clarification", () => {
  for (const academicStanding of ["freshman", "sophomore", "junior", "senior"]) {
    const context = resolvePlanningContext({
      academicStanding,
      planCreationDate: "2026-07-26"
    });

    assert.equal(context.requiresSummerClarification, false);
    assert.equal(context.effectiveStanding, academicStanding);
  }
});

test("legacy summer answers are ignored", () => {
  const context = resolvePlanningContext({
    academicStanding: "junior",
    planCreationDate: "2026-07-26",
    summerStandingConfirmed: "no"
  });

  assert.equal(context.effectiveStanding, "junior");
  assert.equal(context.remainingYears, 2);
  assert.equal(context.summerStandingConfirmed, null);
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

test("summer catalog years use the upcoming-Fall standing", () => {
  const context = resolvePlanningContext({
    academicStanding: "sophomore",
    planCreationDate: "2026-07-26"
  });

  assert.equal(context.entryCatalogYear, "2025-2026");
  assert.equal(context.declarationCatalogYear, "2026-2027");
});

test("transfer planning offers four standard graduation years and a fifth-year option", () => {
  const base = resolvePlanningContext({ planCreationDate: "2027-01-10" });
  const options = transferPlanningOptions(base);

  assert.deepEqual(options.graduationYears, [2027, 2028, 2029, 2030]);
  assert.equal(options.otherGraduationYear, 2031);
  assert.deepEqual(options.entryAcademicYears, [
    "2026-2027",
    "2025-2026",
    "2024-2025",
    "2023-2024",
    "2022-2023"
  ]);
});

test("transfer graduation year derives one- through five-year horizons", () => {
  const expected = new Map([
    [2027, { remainingYears: 1, pace: PLANNING_PACES.EARLY }],
    [2028, { remainingYears: 2, pace: PLANNING_PACES.EARLY }],
    [2029, { remainingYears: 3, pace: PLANNING_PACES.EARLY }],
    [2030, { remainingYears: 4, standing: "freshman" }],
    [2031, { remainingYears: 5, standing: "freshman", pace: PLANNING_PACES.EXTENDED }]
  ]);

  for (const [graduationYear, result] of expected) {
    const compressed = graduationYear < 2030;
    const context = resolvePlanningContext({
      isTransferStudent: true,
      transferExpectedGraduationYear: String(graduationYear),
      transferEntryAcademicYear: "2026-2027",
      planCreationDate: "2027-01-10",
      ...(compressed ? {
        projectedSeniorStandingConfirmation: seniorConfirmation(`${graduationYear - 1}/${graduationYear}`)
      } : {})
    });

    assert.equal(context.transferValidation.valid, true);
    assert.equal(context.planningValidation.valid, true);
    assert.equal(context.remainingYears, result.remainingYears);
    assert.equal(context.effectiveStanding, "freshman");
    assert.equal(context.planningPace, result.pace || PLANNING_PACES.STANDARD);
    assert.equal(context.expectedGraduationTerm, `Spring/May ${graduationYear}`);
    assert.equal(context.entryCatalogYear, "2026-2027");
  }
});

test("five-year transfer planning treats the fourth and fifth college years as senior years", () => {
  const context = resolvePlanningContext({
    isTransferStudent: true,
    transferExpectedGraduationYear: "2031",
    transferEntryAcademicYear: "2026-2027",
    planCreationDate: "2027-01-10"
  });
  const slots = buildPlanningSlots(context);

  assert.equal(context.isFiveYearTransferPlan, true);
  assert.equal(slots.find(slot => slot.label === "Winter 2030").absoluteStandingIndex, 3);
  assert.equal(slots.find(slot => slot.label === "Winter 2031").absoluteStandingIndex, 3);
  assert.equal(slots.at(-1).label, "Spring/May 2031");
});

test("regular standard, early, and extended paces resolve one authoritative horizon", () => {
  const expectedStandardYears = new Map([
    ["freshman", 4],
    ["sophomore", 3],
    ["junior", 2],
    ["senior", 1]
  ]);

  for (const [academicStanding, remainingYears] of expectedStandardYears) {
    const context = resolvePlanningContext({
      academicStanding,
      planningPace: PLANNING_PACES.STANDARD,
      planCreationDate: "2026-07-26"
    });
    assert.equal(context.remainingYears, remainingYears);
    assert.equal(context.requiresProjectedSeniorStandingConfirmation, false);
    assert.equal(context.planningValidation.valid, true);
  }

  const extended = resolvePlanningContext({
    academicStanding: "freshman",
    planningPace: PLANNING_PACES.EXTENDED,
    planCreationDate: "2026-07-26"
  });
  assert.equal(extended.remainingYears, 5);
  assert.equal(extended.expectedGraduationTerm, "Spring/May 2031");
  const extendedSlots = buildPlanningSlots(extended);
  assert.equal(extendedSlots.find(slot => slot.label === "Winter 2030").absoluteStandingIndex, 3);
  assert.equal(extendedSlots.find(slot => slot.label === "Winter 2031").absoluteStandingIndex, 3);
});

test("early regular planning requires an exact final-year senior-standing confirmation", () => {
  const missing = resolvePlanningContext({
    academicStanding: "freshman",
    planningPace: PLANNING_PACES.EARLY,
    planCreationDate: "2026-07-26"
  });
  const stale = resolvePlanningContext({
    academicStanding: "freshman",
    planningPace: PLANNING_PACES.EARLY,
    planCreationDate: "2026-07-26",
    projectedSeniorStandingConfirmation: seniorConfirmation("2027/2028")
  });
  const confirmed = resolvePlanningContext({
    academicStanding: "freshman",
    planningPace: PLANNING_PACES.EARLY,
    planCreationDate: "2026-07-26",
    projectedSeniorStandingConfirmation: seniorConfirmation("2028/2029")
  });

  assert.equal(missing.remainingYears, 3);
  assert.equal(missing.planningValidation.valid, false);
  assert.equal(stale.planningValidation.valid, false);
  assert.equal(confirmed.planningValidation.valid, true);
  assert.equal(confirmed.expectedGraduationTerm, "Spring/May 2029");
  const seniorWinter = buildPlanningSlots(confirmed).find(slot => slot.label === "Winter 2029");
  assert.equal(seniorWinter.absoluteStandingIndex, 3);
  assert.equal(seniorWinter.seniorStandingBasis, "student_reported_registrar_or_advisor_confirmation");
});

test("one-year-early pace is invalid when fewer than two standard years remain", () => {
  const context = resolvePlanningContext({
    academicStanding: "senior",
    planningPace: PLANNING_PACES.EARLY,
    planCreationDate: "2026-07-26",
    projectedSeniorStandingConfirmation: seniorConfirmation("2026/2027")
  });

  assert.equal(context.remainingYears, 1);
  assert.equal(context.planningValidation.valid, false);
  assert.match(context.planningValidation.errors[0], /unavailable/);
});

test("transfer planning rejects missing or out-of-range graduation and entry years", () => {
  const missing = resolvePlanningContext({
    isTransferStudent: true,
    planCreationDate: "2027-01-10"
  });
  const tooLate = resolvePlanningContext({
    isTransferStudent: true,
    transferExpectedGraduationYear: "2032",
    transferEntryAcademicYear: "2026-2027",
    planCreationDate: "2027-01-10"
  });

  assert.equal(missing.transferValidation.valid, false);
  assert.equal(missing.entryCatalogYear, null);
  assert.equal(tooLate.transferValidation.valid, false);
  assert.match(tooLate.transferValidation.errors[0], /2027 through 2031/);
});
