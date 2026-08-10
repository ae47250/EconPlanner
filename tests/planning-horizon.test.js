import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEarlyGraduationContext,
  buildPlanningSlots,
  initialDropAddWindowForDate,
  normalizeScheduleSetByTerm,
  PLANNING_PACES,
  resolvePlanningContext,
  transferPlanningOptions
} from "../lib/planning/horizon.js";

const VERIFIED_INITIAL_DROP_ADD_WINDOWS = [
  ["Fall 2025", "2025-08-24", "2025-08-25", "2025-08-29", "2025-08-30"],
  ["Winter 2026", "2026-01-04", "2026-01-05", "2026-01-09", "2026-01-10"],
  ["Spring/May 2026", "2026-04-26", "2026-04-27", "2026-04-28", "2026-04-29"],
  ["Fall 2026", "2026-08-23", "2026-08-24", "2026-08-28", "2026-08-29"],
  ["Winter 2027", "2027-01-10", "2027-01-11", "2027-01-15", "2027-01-16"],
  ["Spring/May 2027", "2027-05-02", "2027-05-03", "2027-05-04", "2027-05-05"]
];

test("every verified initial drop/add window is inclusive and date-only", () => {
  for (const [label, before, first, last, after] of VERIFIED_INITIAL_DROP_ADD_WINDOWS) {
    assert.equal(initialDropAddWindowForDate(before), null, `${label}: day before`);
    assert.equal(initialDropAddWindowForDate(first)?.label, label, `${label}: first day`);
    assert.equal(initialDropAddWindowForDate(last)?.label, label, `${label}: last day`);
    assert.equal(initialDropAddWindowForDate(after), null, `${label}: day after`);
  }

  const hostileUtcFallback = new Date("2026-08-23T23:30:00.000Z");
  assert.equal(initialDropAddWindowForDate("2026-08-24", hostileUtcFallback)?.label, "Fall 2026");
});

test("later schedule-confirmation dates do not reopen a current term", () => {
  for (const date of ["2025-11-03", "2026-03-30", "2026-11-02", "2027-04-05"]) {
    assert.equal(initialDropAddWindowForDate(date), null);
  }
});

test("current-term schedule-set state is exact-window scoped", () => {
  assert.deepEqual(normalizeScheduleSetByTerm({
    planCreationDate: "2026-08-24",
    scheduleSetByTerm: { "fall-2026": true, "winter-2027": true }
  }), { "fall-2026": true });
  assert.deepEqual(normalizeScheduleSetByTerm({
    planCreationDate: "2026-08-29",
    scheduleSetByTerm: { "fall-2026": true }
  }), {});
});

test("the current term is usable only during initial drop/add and opt-out blocks new courses", () => {
  const open = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-08-24"
  });
  const openSlot = buildPlanningSlots(open).find(slot => slot.id === "fall-2026");
  assert.equal(openSlot?.isCurrentTerm, true);
  assert.equal(openSlot?.newCoursesAllowed, true);

  const optedOut = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-08-24",
    scheduleSetByTerm: { "fall-2026": true }
  });
  const optedOutSlot = buildPlanningSlots(optedOut).find(slot => slot.id === "fall-2026");
  assert.equal(optedOutSlot?.isCurrentTerm, true);
  assert.equal(optedOutSlot?.newCoursesAllowed, false);

  const closed = resolvePlanningContext({
    academicStanding: "freshman",
    planCreationDate: "2026-08-29",
    scheduleSetByTerm: { "fall-2026": true }
  });
  assert.equal(closed.currentTermPlanningWindow, null);
  assert.ok(!buildPlanningSlots(closed).some(slot => slot.id === "fall-2026"));
});

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
    const context = resolvePlanningContext({
      isTransferStudent: true,
      transferExpectedGraduationYear: String(graduationYear),
      transferEntryAcademicYear: "2026-2027",
      planCreationDate: "2027-01-10"
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

test("major declaration catalog year is preserved separately from inferred entry year", () => {
  const unknown = resolvePlanningContext({ academicStanding: "junior", planCreationDate: "2026-09-01" });
  const supplied = resolvePlanningContext({
    academicStanding: "junior",
    planCreationDate: "2026-09-01",
    majorDeclarationCatalogYear: "2025-2026"
  });
  assert.equal(unknown.majorDeclarationCatalogYear, null);
  assert.equal(unknown.majorDeclarationCatalogYearBasis, "NOT_PROVIDED");
  assert.equal(supplied.majorDeclarationCatalogYear, "2025-2026");
  assert.equal(supplied.majorDeclarationCatalogYearBasis, "STUDENT_OR_ADVISOR_PROVIDED");
  assert.notEqual(supplied.entryCatalogYear, supplied.majorDeclarationCatalogYear);
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

test("One Year Early preserves the ordinary horizon and derives a separate accelerated comparison", () => {
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
    assert.equal(context.acceleratedPlanAssumesSeniorStanding, false);
    assert.equal(context.planningValidation.valid, true);
    assert.equal(context.oneYearEarlyEligible, ["freshman", "sophomore", "junior"].includes(academicStanding));
  }

  for (const [academicStanding, normalTarget, earlyTarget] of [
    ["freshman", "Spring/May 2030", "Spring/May 2029"],
    ["sophomore", "Spring/May 2029", "Spring/May 2028"],
    ["junior", "Spring/May 2028", "Spring/May 2027"]
  ]) {
    const normal = resolvePlanningContext({
      academicStanding,
      planningPace: PLANNING_PACES.EARLY,
      planCreationDate: "2026-07-26"
    });
    assert.equal(normal.planningPace, PLANNING_PACES.STANDARD);
    assert.equal(normal.requestedPlanningPace, PLANNING_PACES.EARLY);
    assert.equal(normal.oneYearEarlyEligible, true);
    assert.equal(normal.planningPaceNormalization, null);
    assert.equal(normal.earlyComparisonRequested, true);
    assert.equal(normal.expectedGraduationTerm, normalTarget);
    assert.equal(normal.acceleratedPlanAssumesSeniorStanding, false);

    const early = buildEarlyGraduationContext(normal);
    assert.equal(early.planningPace, PLANNING_PACES.EARLY);
    assert.equal(early.expectedGraduationTerm, earlyTarget);
    assert.equal(early.acceleratedPlanAssumesSeniorStanding, true);
  }
});

test("the accelerated comparison assumes senior standing in its final year without a confirmation input", () => {
  const normal = resolvePlanningContext({
    academicStanding: "freshman",
    planningPace: PLANNING_PACES.EARLY,
    planCreationDate: "2026-07-26",
    projectedSeniorStandingConfirmation: {
      status: "STALE_LEGACY_INPUT_IS_IGNORED",
      academicYear: "2027/2028"
    }
  });

  const context = buildEarlyGraduationContext(normal);
  assert.equal(context.remainingYears, 3);
  assert.equal(context.planningValidation.valid, true);
  assert.equal(context.acceleratedPlanAssumesSeniorStanding, true);
  assert.equal(context.expectedGraduationTerm, "Spring/May 2029");
  assert.ok(!Object.hasOwn(context, "projectedSeniorStandingConfirmation"));
  const seniorWinter = buildPlanningSlots(context).find(slot => slot.label === "Winter 2029");
  assert.equal(seniorWinter.absoluteStandingIndex, 3);
  assert.equal(seniorWinter.seniorStandingBasis, "accelerated_plan_assumes_senior_standing_in_final_year");
});

test("senior one-year-early requests safely normalize to the standard horizon", () => {
  for (const [academicStanding, remainingYears, expectedGraduationTerm] of [
    ["senior", 1, "Spring/May 2027"]
  ]) {
    const context = resolvePlanningContext({
      academicStanding,
      planningPace: PLANNING_PACES.EARLY,
      planCreationDate: "2026-07-26"
    });

    assert.equal(context.remainingYears, remainingYears);
    assert.equal(context.expectedGraduationTerm, expectedGraduationTerm);
    assert.equal(context.requestedPlanningPace, PLANNING_PACES.EARLY);
    assert.equal(context.planningPace, PLANNING_PACES.STANDARD);
    assert.equal(context.oneYearEarlyEligible, false);
    assert.equal(context.earlyComparisonRequested, false);
    assert.equal(context.planningValidation.valid, true);
    assert.equal(context.planningPaceNormalization.code, "ONE_YEAR_EARLY_NORMALIZED_TO_STANDARD");
    assert.match(context.planningPaceNormalization.message, /through junior standing/i);
    assert.equal(buildEarlyGraduationContext(context), null);
  }
});

test("a custom graduation year changes only the horizon and does not create transfer identity", () => {
  const context = resolvePlanningContext({
    academicStanding: "sophomore",
    customGraduationEnabled: true,
    customExpectedGraduationYear: "2030",
    planningPace: PLANNING_PACES.EARLY,
    planCreationDate: "2026-07-26"
  });

  assert.equal(context.isTransferStudent, false);
  assert.equal(context.customGraduationEnabled, true);
  assert.equal(context.customGraduationValidation.valid, true);
  assert.equal(context.expectedGraduationTerm, "Spring/May 2030");
  assert.equal(context.remainingYears, 4);
  assert.equal(context.earlyComparisonRequested, false);
  assert.equal(context.planningPace, PLANNING_PACES.STANDARD);
  assert.equal(buildEarlyGraduationContext(context), null);
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
