// Requirement identifiers and presentation labels are UI contracts. Membership
// comes only from the applicable compiled requirement records.
export const REQUIREMENT_PLACEHOLDERS = Object.freeze({
  statistics: 'STATISTICS REQUIREMENT', cognate: 'MATHEMATICS COGNATE', finance: 'FINANCE REQUIREMENT'
});
export function requirementOptions(bundle, id) {
  return Object.values(bundle.indexes.byRuleId).find(rule =>
    rule.ruleType === 'requirementDefinition' && rule.scope.requirements.includes(id) && rule.effect.options
  )?.effect.options || [];
}
export function electiveMaximum100(bundle) {
  return bundle.indexes.byRuleId['ELECTIVE-MAX-ONE-100-LEVEL'].effect.maximumAcrossElectiveSlots;
}
export function electivePairings(bundle) {
  return bundle.requirementProfile.electiveConditionalCourses;
}
// Course levels are numbered in hundreds; the next band excludes the limited band.
export function electivePlaceholderMinimumLevel(bundle) {
  return bundle.indexes.byRuleId['ELECTIVE-MAX-ONE-100-LEVEL'].condition.courseLevel + 100;
}
