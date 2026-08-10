const TERM_ORDER = new Map([["Fall", 0], ["Winter", 1], ["Spring", 2], ["May", 2]]);

function integer(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function compareArrays(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = integer(left[index]) - integer(right[index]);
    if (difference) return difference;
  }
  return 0;
}

function distance(left, right) {
  return left.reduce((total, value, index) => total + Math.abs(value - integer(right[index])), 0);
}

function enumerateTotals(minimums, maximums, total) {
  const results = [];
  const current = [];
  function visit(index, remaining) {
    if (index === minimums.length) {
      if (remaining === 0) results.push([...current]);
      return;
    }
    const minimumAfter = sum(minimums.slice(index + 1));
    const maximumAfter = sum(maximums.slice(index + 1));
    const low = Math.max(minimums[index], remaining - maximumAfter);
    const high = Math.min(maximums[index], remaining - minimumAfter);
    for (let value = low; value <= high; value += 1) {
      current.push(value);
      visit(index + 1, remaining - value);
      current.pop();
    }
  }
  visit(0, total);
  return results;
}

export function distributeEvenlyLatest(total, count) {
  if (count <= 0) return [];
  const base = Math.floor(integer(total) / count);
  const remainder = integer(total) % count;
  return Array.from({ length: count }, (_item, index) => (
    base + (index >= count - remainder ? 1 : 0)
  ));
}

export function exploreAnnualTargets(total, yearCount, balancedFirstYearTarget) {
  if (yearCount <= 1) return [integer(total)];
  const first = Math.max(0, Math.min(
    integer(balancedFirstYearTarget) - 1,
    Math.floor(integer(total) / yearCount)
  ));
  return [first, ...distributeEvenlyLatest(integer(total) - first, yearCount - 1)];
}

function chooseCapacityAwareAnnualTarget({ desired, minimums, maximums, total }) {
  const capacityTotal = sum(maximums);
  const assignedTotal = Math.min(integer(total), capacityTotal);
  const candidates = enumerateTotals(minimums, maximums, assignedTotal);
  const selected = candidates.sort((left, right) => (
    distance(left, desired) - distance(right, desired)
    || left.reduce((score, value, index) => score + ((value - integer(desired[index])) ** 2), 0)
      - right.reduce((score, value, index) => score + ((value - integer(desired[index])) ** 2), 0)
    || compareArrays(left, right)
  ))[0] || [...minimums];
  return {
    selected,
    capacitySufficient: capacityTotal >= integer(total),
    unallocatedCount: Math.max(0, integer(total) - assignedTotal)
  };
}

function genericPreferredShapeTiers(total, termCount) {
  if (termCount === 3) {
    if (total === 2) return [[[1, 1, 0], [1, 0, 1], [0, 1, 1]]];
    if (total === 3) return [[[1, 1, 1]]];
    if (total === 4) return [[[1, 2, 1], [2, 1, 1]]];
    if (total === 5) return [[[2, 2, 1]]];
  }
  return [[distributeEvenlyLatest(total, termCount)]];
}

function legalShape(shape, minimums, maximums) {
  return shape.length === minimums.length && shape.every((value, index) => (
    value >= minimums[index] && value <= maximums[index]
  ));
}

function shapeRank(shape, tiers) {
  const exactTier = tiers.findIndex(tier => tier.some(preferred => compareArrays(shape, preferred) === 0));
  if (exactTier >= 0) return [0, exactTier, 0];
  let best = [1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  tiers.forEach((tier, tierIndex) => {
    const tierDistance = Math.min(...tier.map(preferred => distance(shape, preferred)));
    const candidate = [1, tierDistance, tierIndex];
    if (compareArrays(candidate, best) < 0) best = candidate;
  });
  return best;
}

function chooseTermShapes({ total, slots, strategy, yearIndex, preferences }) {
  const minimums = slots.map(slot => integer(slot.fixedTrackedCourseCount));
  const maximums = slots.map(slot => integer(slot.fixedTrackedCourseCount) + integer(slot.remainingPlannerCapacity));
  const candidates = enumerateTotals(minimums, maximums, integer(total));
  const fullYear = slots.length === 3
    && slots.every((slot, index) => (TERM_ORDER.get(slot.termKey) ?? -1) === index);
  let tiers = genericPreferredShapeTiers(integer(total), slots.length);
  if (strategy === "explore-first" && yearIndex === 0 && fullYear && integer(total) === 2) {
    tiers = preferences?.firstFullYearTwoCourseShapeTiers || tiers;
  }
  const legalTiers = tiers
    .map(tier => tier.filter(shape => legalShape(shape, minimums, maximums)))
    .filter(tier => tier.length);
  const rankingTiers = legalTiers.length ? legalTiers : tiers;
  const ranked = candidates.sort((left, right) => (
    compareArrays(shapeRank(left, rankingTiers), shapeRank(right, rankingTiers))
    || compareArrays(left, right)
  ));
  const selected = ranked[0] || [...minimums];
  const bestRank = shapeRank(selected, rankingTiers);
  const equallyPreferred = ranked.filter(shape => compareArrays(shapeRank(shape, rankingTiers), bestRank) === 0);
  return {
    slotIds: slots.map(slot => slot.id),
    selected,
    preferredTiers: rankingTiers,
    equallyPreferred,
    minimums,
    maximums
  };
}

export function plannerTrackedCourse(course = {}) {
  return Boolean(course.requirementId || (course.fixedInProgress && course.plannerTracked));
}

export function plannerTrackedTermLoad(term = {}) {
  return (term.courses || []).filter(plannerTrackedCourse).length;
}

export function plannerTrackedYearLoads(plan = {}, yearCount = null) {
  const count = yearCount ?? Math.max(0, ...(plan.distribution?.targetYearCounts || []).map((_item, index) => index + 1));
  return Array.from({ length: count }, (_item, yearIndex) => (
    (plan.terms || [])
      .filter(term => Number(term.yearIndex) === yearIndex)
      .reduce((total, term) => total + plannerTrackedTermLoad(term), 0)
  ));
}

export function termShapePenalty(plan = {}, distribution = {}) {
  return Object.values(distribution.preferredTermShapeTiersByYear || {}).reduce((total, model) => {
    const actual = model.slotIds.map(slotId => plannerTrackedTermLoad(
      (plan.terms || []).find(term => term.slotId === slotId)
    ));
    const legalPreferred = model.equallyPreferred?.length ? [model.equallyPreferred] : null;
    const rank = shapeRank(actual, legalPreferred || model.preferredTiers || []);
    return total + rank[0] * 100 + rank[1] * 10 + rank[2];
  }, 0);
}

export function buildCapacityAwareDistribution({
  unresolvedCount,
  yearCount,
  slots = [],
  strategy = "balanced",
  balancedFirstYearTarget = null,
  preferences = {}
} = {}) {
  const regularSlots = slots.filter(slot => !slot.isSummer);
  const fixedByYear = Array.from({ length: yearCount }, () => 0);
  const capacityByYear = Array.from({ length: yearCount }, () => 0);
  const fixedByTerm = {};
  const reservedByTerm = {};
  const remainingByTerm = {};
  for (const slot of regularSlots) {
    const fixed = integer(slot.fixedTrackedCourseCount);
    const remaining = integer(slot.remainingPlannerCapacity);
    fixedByYear[slot.yearIndex] += fixed;
    capacityByYear[slot.yearIndex] += fixed + remaining;
    fixedByTerm[slot.id] = fixed;
    reservedByTerm[slot.id] = integer(slot.reservedCourseUnits);
    remainingByTerm[slot.id] = remaining;
  }
  const totalTracked = integer(unresolvedCount) + sum(fixedByYear);
  const desired = strategy === "explore-first"
    ? exploreAnnualTargets(totalTracked, yearCount, balancedFirstYearTarget)
    : distributeEvenlyLatest(totalTracked, yearCount);
  const annual = chooseCapacityAwareAnnualTarget({
    desired,
    minimums: fixedByYear,
    maximums: capacityByYear,
    total: totalTracked
  });
  const targetTermCounts = {};
  const targetTermAdditionCounts = {};
  const termTargetCeilings = {};
  const preferredTermShapeTiersByYear = {};
  for (let yearIndex = 0; yearIndex < yearCount; yearIndex += 1) {
    const yearSlots = regularSlots
      .filter(slot => slot.yearIndex === yearIndex)
      .sort((left, right) => (TERM_ORDER.get(left.termKey) ?? 99) - (TERM_ORDER.get(right.termKey) ?? 99));
    if (!yearSlots.length) continue;
    const model = chooseTermShapes({
      total: annual.selected[yearIndex],
      slots: yearSlots,
      strategy,
      yearIndex,
      preferences
    });
    preferredTermShapeTiersByYear[yearIndex] = model;
    yearSlots.forEach((slot, index) => {
      targetTermCounts[slot.id] = model.selected[index];
      targetTermAdditionCounts[slot.id] = Math.max(0, model.selected[index] - integer(slot.fixedTrackedCourseCount));
      termTargetCeilings[slot.id] = Math.max(...model.equallyPreferred.map(shape => shape[index]));
    });
  }
  return {
    strategy,
    unresolvedTarget: integer(unresolvedCount),
    totalTrackedTarget: totalTracked,
    fixedTrackedOccupancy: {
      total: sum(fixedByYear),
      byYear: fixedByYear,
      byTerm: fixedByTerm
    },
    otherReservedCapacityByTerm: reservedByTerm,
    authoritativeRemainingCapacityByTerm: remainingByTerm,
    annualCapacity: capacityByYear,
    capacitySufficient: annual.capacitySufficient,
    unallocatedCount: annual.unallocatedCount,
    desiredYearCounts: desired,
    targetYearCounts: annual.selected,
    targetYearAdditionCounts: annual.selected.map((target, index) => Math.max(0, target - fixedByYear[index])),
    targetTermCounts,
    targetTermAdditionCounts,
    termTargetCeilings,
    preferredTermShapeTiersByYear,
    targetYears: annual.selected.map((targetCount, yearIndex) => ({
      yearIndex,
      fixedTrackedCount: fixedByYear[yearIndex],
      targetCount,
      additionTarget: Math.max(0, targetCount - fixedByYear[yearIndex]),
      capacity: capacityByYear[yearIndex]
    }))
  };
}
