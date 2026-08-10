import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildCapacityAwareDistribution,
  distributeEvenlyLatest
} from "../lib/planning/distribution.js";

const planningPolicy = JSON.parse(await readFile(
  new URL("../policy/rules/planning-flexibility.json", import.meta.url),
  "utf8"
));
const strategies = new Map(planningPolicy.economicsPlanningStrategies.strategies.map(strategy => [strategy.id, strategy]));

function fullYearSlots(yearCount, fixedFirstYear = 0) {
  return Array.from({ length: yearCount }, (_unused, yearIndex) => ([
    {
      id: `fall-${yearIndex}`,
      yearIndex,
      termKey: "Fall",
      fixedTrackedCourseCount: yearIndex === 0 ? fixedFirstYear : 0,
      remainingPlannerCapacity: yearIndex === 0 ? 4 - fixedFirstYear : 4
    },
    { id: `winter-${yearIndex}`, yearIndex, termKey: "Winter", fixedTrackedCourseCount: 0, remainingPlannerCapacity: 4 },
    { id: `spring-${yearIndex}`, yearIndex, termKey: "Spring", fixedTrackedCourseCount: 0, remainingPlannerCapacity: 1 }
  ])).flat();
}

function model({ unresolvedCount, yearCount = 4, slots = fullYearSlots(yearCount), strategy = "balanced", fixedFirstYear = 0 }) {
  const selected = strategies.get(strategy);
  return buildCapacityAwareDistribution({
    unresolvedCount,
    yearCount,
    slots: fixedFirstYear ? fullYearSlots(yearCount, fixedFirstYear) : slots,
    strategy,
    balancedFirstYearTarget: 3,
    preferences: selected.rankingPreferences
  });
}

test("Balanced puts annual remainders in later years", () => {
  assert.deepEqual(distributeEvenlyLatest(12, 4), [3, 3, 3, 3]);
  assert.deepEqual(distributeEvenlyLatest(11, 4), [2, 3, 3, 3]);
  assert.deepEqual(distributeEvenlyLatest(10, 4), [2, 2, 3, 3]);
  assert.deepEqual(distributeEvenlyLatest(9, 4), [2, 2, 2, 3]);
});

test("Explore is lighter than Balanced and backloads a full freshman horizon", () => {
  const balanced = model({ unresolvedCount: 12 });
  const explore = model({ unresolvedCount: 12, strategy: "explore-first" });
  assert.deepEqual(balanced.targetYearCounts, [3, 3, 3, 3]);
  assert.deepEqual(explore.targetYearCounts, [2, 3, 3, 4]);
  assert.ok(explore.targetYearCounts[0] < balanced.targetYearCounts[0]);
});

test("fixed tracked occupancy balances total load while assigning only unresolved work", () => {
  const oneFixedBalanced = model({ unresolvedCount: 11, fixedFirstYear: 1 });
  const oneFixedExplore = model({ unresolvedCount: 11, strategy: "explore-first", fixedFirstYear: 1 });
  assert.deepEqual(oneFixedBalanced.targetYearAdditionCounts, [2, 3, 3, 3]);
  assert.deepEqual(oneFixedBalanced.targetYearCounts, [3, 3, 3, 3]);
  assert.deepEqual(oneFixedExplore.targetYearAdditionCounts, [1, 3, 3, 4]);
  assert.deepEqual(oneFixedExplore.targetYearCounts, [2, 3, 3, 4]);

  const twoFixedBalanced = model({ unresolvedCount: 10, fixedFirstYear: 2 });
  const twoFixedExplore = model({ unresolvedCount: 10, strategy: "explore-first", fixedFirstYear: 2 });
  assert.deepEqual(twoFixedBalanced.targetYearAdditionCounts, [1, 3, 3, 3]);
  assert.deepEqual(twoFixedExplore.targetYearAdditionCounts, [0, 3, 3, 4]);
});

test("shared legal term shapes match the owner-approved contract", () => {
  const expected = new Map([
    [3, [[1, 1, 1]]],
    [4, [[1, 2, 1], [2, 1, 1]]],
    [5, [[2, 2, 1]]]
  ]);
  for (const [total, shapes] of expected) {
    const result = model({ unresolvedCount: total, yearCount: 1 });
    assert.deepEqual(result.preferredTermShapeTiersByYear[0].equallyPreferred, shapes);
    assert.ok(result.preferredTermShapeTiersByYear[0].selected[2] <= 1);
  }
});

test("Explore ranks separated first-year two-course shapes in explicit tiers", () => {
  const result = model({ unresolvedCount: 2, yearCount: 1, strategy: "explore-first" });
  const shape = result.preferredTermShapeTiersByYear[0];
  assert.deepEqual(shape.selected, [1, 1, 0]);
  assert.deepEqual(shape.preferredTiers, [
    [[1, 1, 0]],
    [[1, 0, 1], [0, 1, 1]],
    [[2, 0, 0], [0, 2, 0]]
  ]);
});

test("partial-year and insufficient-capacity targets stay truthful", () => {
  const partialSlots = [
    { id: "spring-0", yearIndex: 0, termKey: "Spring", fixedTrackedCourseCount: 0, remainingPlannerCapacity: 1 },
    ...fullYearSlots(1).map(slot => ({ ...slot, id: `${slot.id}-next`, yearIndex: 1 }))
  ];
  const partial = model({ unresolvedCount: 4, yearCount: 2, slots: partialSlots });
  assert.deepEqual(partial.targetYearCounts, [1, 3]);
  assert.equal(partial.targetTermCounts["spring-0"], 1);
  assert.ok(partial.targetYears.every(year => year.targetCount <= year.capacity));

  const insufficient = model({ unresolvedCount: 12, yearCount: 1 });
  assert.equal(insufficient.capacitySufficient, false);
  assert.equal(insufficient.unallocatedCount, 3);
  assert.equal(insufficient.targetYearCounts.reduce((sum, count) => sum + count, 0), 9);
});

test("capacity-aware generation is deterministic and preserves totals when possible", () => {
  for (let yearCount = 1; yearCount <= 5; yearCount += 1) {
    const capacity = yearCount * 9;
    for (let total = 0; total <= Math.min(24, capacity); total += 1) {
      const left = model({ unresolvedCount: total, yearCount });
      const right = model({ unresolvedCount: total, yearCount });
      assert.deepEqual(left, right);
      assert.equal(left.targetYearCounts.reduce((sum, count) => sum + count, 0), total);
      assert.ok(left.targetYears.every(year => year.targetCount <= year.capacity));
      for (const slot of fullYearSlots(yearCount)) {
        assert.ok(left.targetTermCounts[slot.id] <= slot.remainingPlannerCapacity);
      }
      assert.deepEqual(left.targetYearCounts, [...left.targetYearCounts].sort((a, b) => a - b));
    }
  }
});
