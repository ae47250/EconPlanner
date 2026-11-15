import {catalogPolicyRecords} from "./policy-releases.js";
import {compareCatalogPolicyRecords} from "./compare.js";

export const UNKNOWN_DECLARATION_CATALOG_YEAR = "I_DO_NOT_KNOW";
export const CATALOG_FLEXIBILITY_RULE_ID = "ECONOMICS-OWNER-DESIGNATED-MOST-FLEXIBLE-REQUIREMENTS";
export const LEGACY_CATALOG_FLEXIBILITY_RULE_ID = "CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK";
export const CATALOG_NOTICE_REASON_CODE = "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE";
export const UNKNOWN_INCOMING_CATALOG_NOTICE_REASON_CODE = "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN";

export const CATALOG_APPLICABILITY_STATUS = Object.freeze({
  DECLARATION_YEAR_REQUIRED: "MAJOR_DECLARATION_YEAR_REQUIRED_PRELIMINARY",
  DECLARATION_CATALOG_UNAVAILABLE: "DECLARATION_YEAR_CATALOG_UNAVAILABLE",
  EXACT: "OWNER_DESIGNATED_REQUIREMENTS_MATCH_INCOMING_CATALOG",
  EXACT_DECLARATION_CATALOG: "OWNER_DESIGNATED_REQUIREMENTS_MATCH_INCOMING_CATALOG",
  OWNER_DESIGNATED_MATCH: "OWNER_DESIGNATED_REQUIREMENTS_MATCH_INCOMING_CATALOG",
  OWNER_DESIGNATED_SAC_PETITION: "OWNER_DESIGNATED_REQUIREMENTS_SAC_PETITION_NOTICE",
  OWNER_DESIGNATED_INCOMING_UNKNOWN: "OWNER_DESIGNATED_REQUIREMENTS_INCOMING_YEAR_UNKNOWN",
  LATEST_FLEXIBLE_APPROVED: "OWNER_DESIGNATED_REQUIREMENTS_SAC_PETITION_NOTICE",
  LATEST_FLEXIBLE_FALLBACK: "OWNER_DESIGNATED_REQUIREMENTS_SAC_PETITION_NOTICE",
  AMBIGUOUS: "OWNER_DESIGNATED_REQUIREMENTS_SAC_PETITION_NOTICE",
  AMBIGUOUS_MATERIAL_CONFLICT: "OWNER_DESIGNATED_REQUIREMENTS_SAC_PETITION_NOTICE",
  UNAVAILABLE: "CATALOG_UNAVAILABLE",
  CATALOG_UNAVAILABLE: "CATALOG_UNAVAILABLE"
});

function catalogStart(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{4})$/);
  return match && Number(match[2]) === Number(match[1]) + 1 ? Number(match[1]) : null;
}

function orderedYears(values) {
  return [...new Set(values)]
    .filter(year => catalogStart(year) !== null)
    .sort((left, right) => catalogStart(left) - catalogStart(right));
}

function evaluation(record, designatedRecord) {
  const comparison = compareCatalogPolicyRecords(record, designatedRecord);
  return {
    catalogYear: record.catalogYear,
    completionBasis: "CATALOG_REQUIREMENT_SNAPSHOT",
    comparisonToOwnerDesignatedSet: comparison.status,
    materialDifferences: comparison.findings,
    sourceRefs: record.sourceRefs
  };
}

export function resolveCatalogApplicability({
  majorDeclarationCatalogYear = null,
  entryCatalogYear = null,
  currentCatalogYear = null,
  availableCatalogYears = [],
  sourceRefs = [],
  catalogRecords = null
} = {}) {
  const records = (catalogRecords || catalogPolicyRecords())
    .filter(record => record.publicationStatus === "AUTHORITATIVE_PUBLISHED"
      && record.activationStatus === "OWNER_AUTHORIZED_DECLARATION_YEAR");
  const recordYears = records.map(record => record.catalogYear);
  const available = orderedYears(
    availableCatalogYears.length
      ? availableCatalogYears.filter(year => recordYears.includes(year))
      : recordYears
  );
  const submitted = String(majorDeclarationCatalogYear || "").trim() || null;
  const explicitlyUnknownDeclaration = submitted === UNKNOWN_DECLARATION_CATALOG_YEAR;
  const declared = !explicitlyUnknownDeclaration && catalogStart(submitted) !== null ? submitted : null;
  const incomingCatalogYear = declared || (catalogStart(entryCatalogYear) !== null ? entryCatalogYear : null);
  const incomingRecord = records.find(record => record.catalogYear === declared) || null;
  const requestedUnavailableCatalogYear = declared && !incomingRecord ? declared : null;
  const candidateCatalogYears = orderedYears(declared ? [declared] : []);
  const evaluatedCatalogYears = candidateCatalogYears.filter(year => recordYears.includes(year));
  const refs = [...new Set([
    ...sourceRefs,
    ...records.filter(record => evaluatedCatalogYears.includes(record.catalogYear)).flatMap(record => record.sourceRefs || [])
  ])].sort();

  if (!declared) {
    return Object.freeze({
      status: CATALOG_APPLICABILITY_STATUS.DECLARATION_YEAR_REQUIRED,
      submittedDeclarationCatalogYear: submitted,
      studentIncomingCatalogYear: incomingCatalogYear,
      incomingCatalogYear,
      incomingCatalogComparisonYear: null,
      originalCatalogYear: incomingCatalogYear,
      candidateCatalogYears: [],
      evaluatedCatalogYears: [],
      appliedMajorCatalogYear: null,
      governingMajorCatalogYear: null,
      designatedMajorCatalogYear: null,
      latestAvailableCatalogYear: available.at(-1) || null,
      basis: "FORMAL_MAJOR_DECLARATION_YEAR_REQUIRED",
      flexibilityRuleUsed: null,
      requiresAdvisorConfirmation: true,
      approvalStatus: "DECLARATION_UNKNOWN",
      materialDifferences: [],
      evaluations: [],
      sourceRefs: refs,
      ruleIds: [],
      advisorNotice: null,
      advisorNotifications: [],
      advisorAction: null,
      preliminaryOnly: true
    });
  }

  if (!incomingRecord || !available.includes(declared)) {
    return Object.freeze({
      status: CATALOG_APPLICABILITY_STATUS.DECLARATION_CATALOG_UNAVAILABLE,
      submittedDeclarationCatalogYear: submitted,
      studentIncomingCatalogYear: incomingCatalogYear,
      incomingCatalogYear,
      incomingCatalogComparisonYear: null,
      originalCatalogYear: incomingCatalogYear,
      candidateCatalogYears,
      evaluatedCatalogYears,
      appliedMajorCatalogYear: null,
      governingMajorCatalogYear: null,
      designatedMajorCatalogYear: null,
      latestAvailableCatalogYear: available.at(-1) || null,
      basis: "DECLARATION_YEAR_REQUIREMENT_SET_UNAVAILABLE",
      flexibilityRuleUsed: null,
      requiresAdvisorConfirmation: true,
      approvalStatus: "UNAVAILABLE",
      materialDifferences: [],
      evaluations: [],
      sourceRefs: refs,
      ruleIds: [],
      advisorNotice: null,
      advisorNotifications: [],
      advisorAction: null,
      preliminaryOnly: true
    });
  }

  const designatedCatalogYear = incomingRecord.catalogYear;
  const designatedRecord = incomingRecord;
  const materialDifferences = [];
  const advisorNotice = null;
  return Object.freeze({
    status: CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_MATCH,
    submittedDeclarationCatalogYear: submitted,
    studentIncomingCatalogYear: incomingCatalogYear,
    incomingCatalogYear,
    incomingCatalogComparisonYear: incomingRecord.catalogYear,
    submittedIncomingCatalogYear: incomingCatalogYear || null,
    originalCatalogYear: incomingCatalogYear,
    requestedUnavailableCatalogYear,
    candidateCatalogYears,
    evaluatedCatalogYears,
    appliedMajorCatalogYear: designatedCatalogYear,
    governingMajorCatalogYear: designatedCatalogYear,
    designatedMajorCatalogYear: designatedCatalogYear,
    latestAvailableCatalogYear: available.at(-1) || null,
    basis: "FORMAL_MAJOR_DECLARATION_YEAR_REQUIREMENTS",
    incomingCatalogRole: "FORMAL_MAJOR_DECLARATION_YEAR_AUTHORITY",
    declarationCatalogMayOverride: true,
    automaticNewestSelectionPermitted: false,
    fallbackReason: null,
    flexibilityRuleUsed: null,
    requiresAdvisorConfirmation: false,
    approvalStatus: "OWNER_DESIGNATED",
    approvalCondition: null,
    materialDifferences,
    evaluations: [evaluation(incomingRecord, designatedRecord)],
    sourceRefs: refs,
    ruleIds: [],
    advisorNotice,
    advisorNotifications: advisorNotice ? [advisorNotice] : [],
    advisorAction: null,
    administrativeFollowUpOnly: false,
    currentCatalogYear: catalogStart(currentCatalogYear) === null ? null : currentCatalogYear
  });
}

export function analyzeCatalogApplicabilityProfiles(profiles = [], options = {}) {
  return [...profiles].map(profile => {
    const applicability = resolveCatalogApplicability({
      majorDeclarationCatalogYear: profile.majorDeclarationCatalogYear,
      entryCatalogYear: profile.entryCatalogYear,
      currentCatalogYear: profile.currentCatalogYear,
      availableCatalogYears: options.availableCatalogYears,
      sourceRefs: options.sourceRefs,
      catalogRecords: options.catalogRecords,
      designationPolicy: options.designationPolicy
    });
    return {
      profileId: profile.profileId,
      confirmedMajorDeclarationCatalogYear: profile.majorDeclarationCatalogYear || null,
      incomingCatalogYear: applicability.incomingCatalogYear,
      inferredEntryYear: profile.entryCatalogYear || null,
      possibleGoverningDeclarationCatalogYears: applicability.candidateCatalogYears,
      catalogApplicabilityStatus: applicability.status,
      appliedMajorCatalogYear: applicability.appliedMajorCatalogYear,
      designatedMajorCatalogYear: applicability.designatedMajorCatalogYear,
      latestAvailableCatalogYear: applicability.latestAvailableCatalogYear,
      materiallyDifferentOutcomePossible: applicability.materialDifferences.length > 0,
      differingRuleFamilies: [...new Set(applicability.materialDifferences.map(item => item.family))].sort(),
      missingAuthoritativeSources: applicability.requestedUnavailableCatalogYear ? [applicability.requestedUnavailableCatalogYear] : [],
      fieldsNeeded: [],
      recommendation: applicability.appliedMajorCatalogYear
        ? `Use the complete ${applicability.appliedMajorCatalogYear} Economics requirements for the formal declaration year.`
        : "Confirm the formal Economics declaration year before applying major requirements."
    };
  }).sort((left, right) => left.profileId.localeCompare(right.profileId));
}
