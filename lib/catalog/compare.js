function asSet(values) {
  return new Set(Array.isArray(values) ? values.map(value => String(value)) : []);
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
