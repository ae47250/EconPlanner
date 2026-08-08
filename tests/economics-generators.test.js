import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fc from "fast-check";
import {
  ECONOMICS_GENERATOR_AXES,
  ECONOMICS_GENERATOR_VERSION,
  ORDINARY_ON_TIME_COHORT_ID,
  auditGeneratedFictionalProfile,
  auditOrdinaryOnTimeEconomicsProfile,
  canonicalizeGeneratedCourse,
  fictionalEconomicsProfileArbitrary,
  generateFictionalEconomicsProfiles,
  generateLegacyV3FictionalEconomicsProfiles,
  generateInvalidEconomicsNeighbors,
  independentPrerequisiteClosure,
  loadOrdinaryOnTimeEconomicsProfiles,
  pairwiseCoverageReport,
  shrinkFictionalEconomicsProfile,
  withExplicitMayCommitment
} from "./helpers/economics-generators.js";

const manifest = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const verifiedSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));

const SEED_A = 20260803;
const SEED_B = 20260804;

test("seeded pairwise profiles cover every declared axis pair without a Cartesian product", () => {
  const generated = generateFictionalEconomicsProfiles({
    seed: SEED_A,
    manifest,
    verifiedSchedule
  });
  const cartesianSize = Object.values(ECONOMICS_GENERATOR_AXES)
    .reduce((product, values) => product * values.length, 1);
  const coverage = pairwiseCoverageReport(generated.profiles);

  assert.equal(generated.selectionMode, "seeded-pairwise-greedy");
  assert.equal(coverage.missingPairs.length, 0);
  assert.equal(coverage.coveredPairs, coverage.requiredPairs);
  assert.ok(generated.profiles.length < cartesianSize / 100);
  assert.ok(generated.profiles.every(profile => profile.seed === SEED_A));
  assert.ok(generated.profiles.every(profile => profile.profileId.startsWith(`fictional-econ-${SEED_A}-`)));
});

test("the same seed reproduces the exact profile sequence", () => {
  const first = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });
  const second = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });
  assert.deepEqual(second, first);
});

test("generator v4 corrects derived May reservations while preserving one-to-one v3 replay IDs", () => {
  const corrected = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });
  const legacy = generateLegacyV3FictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });

  assert.equal(corrected.generatorVersion, ECONOMICS_GENERATOR_VERSION);
  assert.deepEqual(corrected.profiles.map(profile => profile.profileId), legacy.profiles.map(profile => profile.profileId));
  assert.ok(corrected.profiles.every(profile => profile.student.reservedCapacity.May === 0));
  assert.ok(legacy.profiles.some(profile => profile.student.reservedCapacity.May === 1));
  assert.ok(corrected.profiles.every(profile => profile.generation.mayReservationPolicy === "EXPLICIT_COMMITMENT_ONLY"));
});

test("ordinary-on-time-v1 freezes six materially different neutral histories per standing", async () => {
  const cohort = await loadOrdinaryOnTimeEconomicsProfiles({ manifest, verifiedSchedule });
  const expectedYears = { freshman: 4, sophomore: 3, junior: 2, senior: 1 };

  assert.equal(cohort.cohortId, ORDINARY_ON_TIME_COHORT_ID);
  assert.equal(cohort.profiles.length, 24);
  assert.equal(cohort.historyCoverage.length, 4);
  for (const design of cohort.historyCoverage) {
    const profiles = cohort.profiles.filter(profile => profile.student.academicStanding === design.standing);
    const courseSignatures = new Set(profiles.map(profile => JSON.stringify(
      profile.student.courses.map(course => [course.course, course.status])
    )));
    assert.equal(design.profileCount, 6, design.standing);
    assert.equal(design.normalRemainingYears, expectedYears[design.standing], design.standing);
    assert.equal(design.historyCategories.length, 6, design.standing);
    assert.equal(courseSignatures.size, 6, design.standing);
    assert.ok(design.historyCategories.includes("no-economics-history"), design.standing);
    assert.match(design.justification, /difficult|without assuming|late-start|late start|progress/iu, design.standing);
  }

  for (const profile of cohort.profiles) {
    const audit = auditOrdinaryOnTimeEconomicsProfile(profile, manifest, verifiedSchedule);
    assert.equal(audit.valid, true, profile.profileId);
    assert.deepEqual(audit, profile.ordinaryAudit, profile.profileId);
    assert.equal(audit.declaredStanding, audit.resolvedEffectiveStanding, profile.profileId);
    assert.equal(audit.effectiveRemainingYears, expectedYears[audit.declaredStanding], profile.profileId);
    assert.equal(profile.student.planningPace, "standard", profile.profileId);
    assert.equal(profile.student.isTransferStudent, false, profile.profileId);
    assert.deepEqual(profile.student.reservedCapacity, { Fall: 0, Winter: 0, May: 0 }, profile.profileId);
    assert.equal(profile.axes.availabilityState, "open", profile.profileId);
    assert.equal(profile.axes.approvalState, "not-required", profile.profileId);
    assert.ok(profile.student.courses.every(course => course.status !== "transfer"), profile.profileId);
  }
});

test("ordinary-on-time-v1 rejects non-ordinary and invalid denominator mutations", async () => {
  const cohort = await loadOrdinaryOnTimeEconomicsProfiles({ manifest, verifiedSchedule });
  const base = cohort.profiles.find(profile => profile.student.courses.length > 0);
  const cases = [
    ["transfer student", "ORDINARY-NON-TRANSFER", profile => {
      profile.student.isTransferStudent = true;
      profile.axes.transferStatus = "transfer";
    }],
    ["transfer history", "ORDINARY-NO-TRANSFER-HISTORY", profile => {
      profile.student.courses[0].status = "transfer";
    }],
    ["nonstandard pace", "ORDINARY-STANDARD-PACE", profile => {
      profile.student.planningPace = "one_year_extended";
      profile.axes.planningPace = "one_year_extended";
    }],
    ["ordinary reservation", "ORDINARY-ZERO-RESERVATIONS", profile => {
      profile.student.reservedCapacity.Fall = 1;
    }],
    ["synthetic May occupancy", "ORDINARY-ZERO-RESERVATIONS", profile => {
      profile.student.reservedCapacity.May = 1;
    }],
    ["explicit May commitment", "ORDINARY-NO-MAY-COMMITMENT", profile => {
      profile.scenario.trueMayCommitment = { explicit: true, reservedCourseUnits: 1 };
    }],
    ["availability stress", "ORDINARY-OPEN-AVAILABILITY", profile => {
      profile.axes.availabilityState = "constrained";
      profile.scenario.availability.state = "constrained";
    }],
    ["approval stress", "ORDINARY-NO-APPROVAL-MUTATION", profile => {
      profile.axes.approvalState = "valid-instructor";
      profile.scenario.approval = { status: "recorded" };
    }],
    ["invalid standing", "ORDINARY-EFFECTIVE-STANDING", profile => {
      profile.student.academicStanding = "graduate";
      profile.axes.standing = "graduate";
    }]
  ];

  for (const [label, expectedRule, mutate] of cases) {
    const profile = structuredClone(base);
    mutate(profile);
    const audit = auditOrdinaryOnTimeEconomicsProfile(profile, manifest, verifiedSchedule);
    assert.equal(audit.valid, false, label);
    assert.ok(audit.violations.some(violation => violation.ruleId === expectedRule), label);
  }
});

test("a real May reservation is represented only by an explicit held-out commitment", () => {
  const generated = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });
  const explicit = withExplicitMayCommitment(generated.profiles[0], 1);

  assert.equal(explicit.student.reservedCapacity.May, 1);
  assert.equal(explicit.scenario.trueMayCommitment.explicit, true);
  assert.equal(auditGeneratedFictionalProfile(explicit, manifest, verifiedSchedule).valid, true);

  const implicit = structuredClone(explicit);
  delete implicit.scenario.trueMayCommitment;
  const audit = auditGeneratedFictionalProfile(implicit, manifest, verifiedSchedule);
  assert.equal(audit.valid, false);
  assert.ok(audit.violations.some(item => item.ruleId === "GENERATOR-EXPLICIT-MAY-COMMITMENT"));
});

test("different seeds create controlled variation with the same schema and complete coverage", () => {
  const first = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });
  const second = generateFictionalEconomicsProfiles({ seed: SEED_B, manifest, verifiedSchedule });

  assert.notDeepEqual(second.profiles.map(profile => profile.axes), first.profiles.map(profile => profile.axes));
  assert.equal(second.coverage.missingPairs.length, 0);
  assert.deepEqual(Object.keys(second.profiles[0]).sort(), Object.keys(first.profiles[0]).sort());
  assert.ok(second.profiles.every(profile => profile.seed === SEED_B));
});

test("every valid generated profile passes the independent manifest gate", () => {
  const { profiles } = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });

  for (const profile of profiles) {
    assert.equal(profile.fictional, true, profile.profileId);
    assert.equal(profile.policyAudit.valid, true, profile.profileId);
    assert.deepEqual(
      auditGeneratedFictionalProfile(profile, manifest, verifiedSchedule),
      profile.policyAudit,
      profile.profileId
    );
    assert.ok(profile.student.courses.every(entry => entry.source.startsWith("fictional-")), profile.profileId);
  }
});

test("valid profiles reserve ECO 257 for statistics and reduce elective symmetry", () => {
  const { profiles } = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });

  for (const profile of profiles) {
    const hints = profile.requirementHints;
    assert.equal(hints.statistics.requirementRuleId, "REQ-STATISTICS", profile.profileId);
    assert.ok(["ECO 257", "MAT 217", "PSY 217"].includes(hints.statistics.course), profile.profileId);
    assert.ok(!hints.electiveCandidates.includes("ECO 257"), profile.profileId);
    assert.ok(!hints.electiveAssignments.some(entry => entry.course === "ECO 257"), profile.profileId);
    assert.deepEqual(hints.electiveCandidates, [...new Set(hints.electiveCandidates)].sort(), profile.profileId);
  }
});

test("prerequisite closure is transitive and independent of production planning code", () => {
  const microElectiveClosure = independentPrerequisiteClosure("ECO 331", manifest, SEED_A);
  assert.ok(microElectiveClosure.includes("ECO 113"));
  assert.ok(microElectiveClosure.includes("ECO 213"));
  assert.equal(microElectiveClosure.filter(course => ["MAT 113", "MAT 121"].includes(course)).length, 1);
  assert.ok(independentPrerequisiteClosure("ECO 461", manifest, SEED_A).includes("ECO 214"));
});

test("verified micro and macro offerings remain distinct and cross-lists are canonical", () => {
  const { profiles } = generateFictionalEconomicsProfiles({ seed: SEED_A, manifest, verifiedSchedule });
  const expectedMicroTerm = verifiedSchedule.sections.find(section => section.course === "ECO 213").term;
  const expectedMacroTerm = verifiedSchedule.sections.find(section => section.course === "ECO 214").term;

  assert.notEqual(expectedMicroTerm, expectedMacroTerm);
  assert.ok(profiles.every(profile => profile.verifiedSchedulePattern.micro.term === expectedMicroTerm));
  assert.ok(profiles.every(profile => profile.verifiedSchedulePattern.macro.term === expectedMacroTerm));
  assert.equal(canonicalizeGeneratedCourse("PHI 234", manifest), "ECO 234");
  assert.ok(profiles
    .filter(profile => profile.axes.completedPathway === "cross-list")
    .every(profile => profile.student.courses.some(entry =>
      entry.course === "ECO 234" && entry.submittedCourse === "PHI 234"
    )));
});

test("invalid neighbors change one policy rule at a time, including ECO 257 elective misuse", () => {
  const neighbors = generateInvalidEconomicsNeighbors({ seed: SEED_A, manifest, verifiedSchedule });
  assert.deepEqual(
    neighbors.map(profile => profile.invalidNeighbor.mutationId),
    [
      "missing-math-prerequisite",
      "wrong-approval-authority",
      "eco-257-as-elective",
      "duplicate-cross-list"
    ]
  );

  for (const neighbor of neighbors) {
    assert.equal(neighbor.fictional, true);
    assert.equal(neighbor.kind, "invalid-fictional-neighbor");
    assert.equal(neighbor.invalidNeighbor.changedRules, 1);
    assert.equal(neighbor.policyAudit.valid, false, neighbor.profileId);
    assert.deepEqual(
      [...new Set(neighbor.policyAudit.violations.map(violation => violation.ruleId))],
      [neighbor.invalidNeighbor.expectedViolationRuleId],
      neighbor.profileId
    );
  }

  const eco257Neighbor = neighbors.find(profile =>
    profile.invalidNeighbor.mutationId === "eco-257-as-elective"
  );
  assert.equal(eco257Neighbor.requirementHints.statistics.course, "MAT 217");
  assert.equal(eco257Neighbor.requirementHints.electiveAssignments[0].course, "ECO 257");
});

test("fast-check arbitraries and deterministic candidates support smaller counterexamples", () => {
  const arbitrary = fictionalEconomicsProfileArbitrary({ manifest, verifiedSchedule });
  const sampled = fc.sample(arbitrary, { seed: SEED_A, numRuns: 4 });
  const shrinkCandidates = shrinkFictionalEconomicsProfile(sampled[0], { manifest, verifiedSchedule });

  assert.equal(sampled.length, 4);
  assert.ok(sampled.every(profile => profile.policyAudit.valid));
  assert.equal(typeof arbitrary.shrink, "function");
  assert.ok(shrinkCandidates.length > 0);
  assert.ok(shrinkCandidates.every(profile =>
    profile.policyAudit.valid && profile.generation.shrinkOf === sampled[0].profileId
  ));
});
