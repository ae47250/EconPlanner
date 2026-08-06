function asSet(values) {
  return new Set(Array.isArray(values) ? values.map(value => String(value)) : []);
}

function addFinding(list, code, message) {
  list.push({ code, message });
}

function compareSetChanges(baseValues, newerValues, favorable, unfavorable, addedCode, removedCode, label) {
  const base = asSet(baseValues);
  const newer = asSet(newerValues);
  const added = [...newer].filter(value => !base.has(value));
  const removed = [...base].filter(value => !newer.has(value));

  if (added.length) addFinding(favorable, addedCode, `${label} adds ${added.join(", ")}.`);
  if (removed.length) addFinding(unfavorable, removedCode, `${label} removes ${removed.join(", ")}.`);
}

function compareNumber(baseValue, newerValue, favorable, unfavorable, lowerCode, higherCode, label) {
  const base = Number(baseValue || 0);
  const newer = Number(newerValue || 0);
  if (newer < base) addFinding(favorable, lowerCode, `${label} decreases from ${base} to ${newer}.`);
  if (newer > base) addFinding(unfavorable, higherCode, `${label} increases from ${base} to ${newer}.`);
}

function compareSlot(baseSlot, newerSlot, favorable, unfavorable) {
  if (!baseSlot && newerSlot) {
    addFinding(unfavorable, "added_requirement", `The newer catalog adds ${newerSlot.label || newerSlot.id}.`);
    return;
  }
  if (baseSlot && !newerSlot) {
    addFinding(favorable, "removed_requirement", `The newer catalog removes ${baseSlot.label || baseSlot.id}.`);
    return;
  }

  if (!baseSlot || !newerSlot) return;
  const label = newerSlot.label || newerSlot.id;
  compareSetChanges(baseSlot.options, newerSlot.options, favorable, unfavorable, "added_option", "removed_option", `${label} options`);
  compareSetChanges(baseSlot.excludedCourses, newerSlot.excludedCourses, unfavorable, favorable, "more_exclusions", "fewer_exclusions", `${label} exclusions`);
  compareNumber(baseSlot.units, newerSlot.units, favorable, unfavorable, "reduced_units", "increased_units", `${label} units`);

  const baseMin = Number(baseSlot.minLevel || 0);
  const newerMin = Number(newerSlot.minLevel || 0);
  if (newerMin < baseMin) addFinding(favorable, "lower_minimum_level", `${label} lowers its minimum course level.`);
  if (newerMin > baseMin) addFinding(unfavorable, "higher_minimum_level", `${label} raises its minimum course level.`);

  const baseMax = Number(baseSlot.maxLevel || Number.POSITIVE_INFINITY);
  const newerMax = Number(newerSlot.maxLevel || Number.POSITIVE_INFINITY);
  if (newerMax > baseMax) addFinding(favorable, "higher_maximum_level", `${label} allows higher course levels.`);
  if (newerMax < baseMax) addFinding(unfavorable, "lower_maximum_level", `${label} limits course levels more tightly.`);
}

function comparePrerequisiteRules(baseRules = {}, newerRules = {}, favorable, unfavorable) {
  const codes = new Set([...Object.keys(baseRules), ...Object.keys(newerRules)]);
  for (const code of codes) {
    const base = baseRules[code];
    const newer = newerRules[code];
    if (base && !newer) {
      addFinding(favorable, "removed_prerequisite_rule", `The newer catalog removes prerequisites for ${code}.`);
      continue;
    }
    if (!base || !newer) {
      addFinding(unfavorable, "added_prerequisite_rule", `The newer catalog adds prerequisites for ${code}.`);
      continue;
    }

    compareSetChanges(base.all, newer.all, unfavorable, favorable, "added_prerequisite", "removed_prerequisite", `${code} required prerequisites`);
    const baseAny = (base.any || base.anyGroups || []).map(group => [...group].sort().join(" / ")).sort();
    const newerAny = (newer.any || newer.anyGroups || []).map(group => [...group].sort().join(" / ")).sort();
    compareSetChanges(baseAny, newerAny, favorable, unfavorable, "added_prerequisite_option_group", "removed_prerequisite_option_group", `${code} prerequisite options`);
  }
}

export function compareRequirementSnapshots(base, newer, basePrerequisites = {}, newerPrerequisites = {}) {
  if (!base || !newer) {
    return { status: "unavailable", favorable: [], unfavorable: [], findings: [] };
  }

  const favorable = [];
  const unfavorable = [];
  const baseSlots = new Map((base.requirementSlots || []).map(slot => [slot.id, slot]));
  const newerSlots = new Map((newer.requirementSlots || []).map(slot => [slot.id, slot]));
  const slotIds = new Set([...baseSlots.keys(), ...newerSlots.keys()]);

  for (const id of slotIds) compareSlot(baseSlots.get(id), newerSlots.get(id), favorable, unfavorable);

  compareNumber(
    (base.requirementSlots || []).length,
    (newer.requirementSlots || []).length,
    favorable,
    unfavorable,
    "fewer_requirement_slots",
    "more_requirement_slots",
    "Required course slots"
  );
  compareNumber(base.rules?.totalMajorCourses, newer.rules?.totalMajorCourses, favorable, unfavorable, "fewer_major_courses", "more_major_courses", "Required major courses");
  compareNumber(base.rules?.totalCognateCourses, newer.rules?.totalCognateCourses, favorable, unfavorable, "fewer_cognates", "more_cognates", "Required cognate courses");
  compareNumber(base.rules?.max100LevelElectives, newer.rules?.max100LevelElectives, favorable, unfavorable, "more_100_level_flexibility", "less_100_level_flexibility", "100-level elective limit");
  comparePrerequisiteRules(basePrerequisites, newerPrerequisites, favorable, unfavorable);

  const status = !favorable.length && !unfavorable.length
    ? "no_change"
    : favorable.length && !unfavorable.length
      ? "more_flexible"
      : "changed_review";

  return {
    status,
    favorable,
    unfavorable,
    findings: [...favorable, ...unfavorable]
  };
}

function structuredFinding(code, direction, family, detail, affected = []) {
  return {code, direction, family, detail, affected: [...new Set(affected)].sort()};
}

function optionDifferences(baseOptions, newerOptions, family, addedCode, removedCode) {
  const base = asSet(baseOptions);
  const newer = asSet(newerOptions);
  return [
    ...[...newer].filter(value => !base.has(value)).map(value => structuredFinding(addedCode, "MORE_FLEXIBLE", family, `${value} is available under the newer catalog.`, [value])),
    ...[...base].filter(value => !newer.has(value)).map(value => structuredFinding(removedCode, "STRICTER_OR_CONFLICTING", family, `${value} is not available under the newer catalog.`, [value]))
  ];
}

export function compareCatalogPolicyRecords(base, newer) {
  if (!base || !newer) return {status: "unavailable", favorable: [], unfavorable: [], findings: []};
  const findings = [
    ...optionDifferences(base.requirements.statisticsOptions, newer.requirements.statisticsOptions, "STATISTICS", "PSY_217_STATISTICS_OPTION_ADDED", "STATISTICS_OPTION_REMOVED"),
    ...optionDifferences(base.requirements.moneyFinanceOptions, newer.requirements.moneyFinanceOptions, "MONEY_FINANCE", "BUSN_323_MONEY_FINANCE_OPTION_ADDED", "MONEY_FINANCE_OPTION_REMOVED")
  ];
  const baseMilestone = base.nonCourseMilestones.find(item => item.id === "ECONOMICS-COMPREHENSIVE-EVALUATION")?.status;
  const newerMilestone = newer.nonCourseMilestones.find(item => item.id === "ECONOMICS-COMPREHENSIVE-EVALUATION")?.status;
  if (baseMilestone !== newerMilestone) {
    findings.push(structuredFinding(
      "ECONOMICS_COMPREHENSIVE_EVALUATION_CHANGED",
      baseMilestone === "REQUIRED" && newerMilestone === "NOT_LISTED" ? "MORE_FLEXIBLE" : "STRICTER_OR_CONFLICTING",
      "NON_COURSE_MILESTONE",
      `Economics comprehensive evaluation changes from ${baseMilestone} to ${newerMilestone}.`,
      ["ECONOMICS-COMPREHENSIVE-EVALUATION"]
    ));
  }
  for (const course of [...new Set([...Object.keys(base.prerequisites), ...Object.keys(newer.prerequisites)])].sort()) {
    const before = JSON.stringify(base.prerequisites[course] || null);
    const after = JSON.stringify(newer.prerequisites[course] || null);
    if (before !== after && course !== "ECO 461") {
      findings.push(structuredFinding("PREREQUISITE_CHANGED", "STRICTER_OR_CONFLICTING", "PREREQUISITE", `${course} prerequisite language differs.`, [course]));
    }
  }
  const favorable = findings.filter(item => item.direction === "MORE_FLEXIBLE");
  const unfavorable = findings.filter(item => item.direction === "STRICTER_OR_CONFLICTING");
  return {
    status: !findings.length ? "no_change" : unfavorable.length ? "changed_review" : "more_flexible",
    favorable,
    unfavorable,
    findings
  };
}
