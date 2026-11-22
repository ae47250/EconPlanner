import {createHash} from "node:crypto";
import {canonicalJson} from "../policy/canonical-json.js";
import {
  catalogPolicyRecords,
  mostFlexibleEconomicsMajorRequirementSet
} from "./policy-releases.js";
import {compareCatalogPolicyRecords} from "./compare.js";

export const UNKNOWN_DECLARATION_CATALOG_YEAR = "I_DO_NOT_KNOW";
export const CATALOG_FLEXIBILITY_RULE_ID = "ECONOMICS-OWNER-DESIGNATED-MOST-FLEXIBLE-REQUIREMENTS";
export const LEGACY_CATALOG_FLEXIBILITY_RULE_ID = "CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK";
export const CATALOG_NOTICE_REASON_CODE = "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE";
export const UNKNOWN_INCOMING_CATALOG_NOTICE_REASON_CODE = "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN";

export const CATALOG_APPLICABILITY_STATUS = Object.freeze({
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

function stableId(prefix, identity) {
  const digest = createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

function displayYear(value) {
  return String(value || "").replace("-", "–");
}

function policySources(records, years, designation) {
  return [...new Set([
    ...records.filter(record => years.includes(record.catalogYear)).flatMap(record => record.sourceRefs || []),
    ...(designation.sourceRefs || []),
    "OWNER-CONFIRMATION-CP4B-B-FOLLOWUP#PLANNING-FLEXIBILITY"
  ])].sort();
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

function administrativeNotice({designation, incomingCatalogYear, materialDifferences, sourceRefs, unknown}) {
  const source = unknown
    ? designation.notices.incomingYearUnknown
    : designation.notices.materialDifference;
  const message = (unknown
    ? incomingCatalogYear && source.messageWhenYearKnownButRequirementsUnavailableTemplate
      ? (incomingCatalogYear === "2026-2027"
          ? source.messageWhenYearKnownButRequirementsUnavailableTemplate
          : source.messageWhenOtherYearKnownButRequirementsUnavailableTemplate || source.message)
        .replace("[incoming year]", displayYear(incomingCatalogYear))
      : source.message
    : source.messageTemplate.replace("[incoming year]", displayYear(incomingCatalogYear)))
    .replaceAll("SAC petition", "petition with the Student Academic Assistance Committee (forms are at the Registrar's Office)");
  const identity = {
    reasonCode: source.code,
    incomingCatalogYear: incomingCatalogYear || null,
    appliedMajorCatalogYear: designation.catalogYear,
    materialDifferences
  };
  return Object.freeze({
    noticeId: stableId("advisor-notification", identity),
    reasonCode: source.code,
    code: source.code,
    title: unknown ? "Incoming catalog year" : "Routine catalog petition",
    severity: "info",
    message,
    blocking: false,
    readinessImpact: "NONE",
    category: source.category,
    incomingCatalogYear: incomingCatalogYear || null,
    appliedMajorCatalogYear: designation.catalogYear,
    sacPetitionRequired: source.sacPetitionRequired,
    responsibleParty: source.responsibleParty,
    materialDifferences,
    controllingRuleIds: [designation.ruleId],
    sourceRefs
  });
}

export function resolveCatalogApplicability({
  majorDeclarationCatalogYear = null,
  entryCatalogYear = null,
  currentCatalogYear = null,
  availableCatalogYears = [],
  sourceRefs = [],
  catalogRecords = null,
  designationPolicy = null
} = {}) {
  const records = (catalogRecords || catalogPolicyRecords())
    .filter(record => record.publicationStatus === "AUTHORITATIVE_PUBLISHED");
  const recordYears = records.map(record => record.catalogYear);
  const available = orderedYears(
    availableCatalogYears.length
      ? availableCatalogYears.filter(year => recordYears.includes(year))
      : recordYears
  );
  const designation = designationPolicy || mostFlexibleEconomicsMajorRequirementSet();
  const designatedCatalogYear = designation?.catalogYear || null;
  const designatedRecord = records.find(record => record.catalogYear === designatedCatalogYear) || null;
  const submitted = String(majorDeclarationCatalogYear || "").trim() || null;
  const explicitlyUnknownDeclaration = submitted === UNKNOWN_DECLARATION_CATALOG_YEAR;
  const declared = !explicitlyUnknownDeclaration && catalogStart(submitted) !== null ? submitted : null;
  const submittedIncoming = catalogStart(entryCatalogYear) !== null ? entryCatalogYear : declared;
  const incomingRecord = records.find(record => record.catalogYear === submittedIncoming) || null;
  const incomingCatalogYear = submittedIncoming || null;
  const comparableIncomingCatalogYear = incomingRecord?.catalogYear || null;
  const requestedUnavailableCatalogYear = submittedIncoming && !incomingRecord ? submittedIncoming : null;
  const candidateCatalogYears = orderedYears([
    ...(submittedIncoming ? [submittedIncoming] : []),
    ...(designatedCatalogYear ? [designatedCatalogYear] : [])
  ]);
  const evaluatedCatalogYears = candidateCatalogYears.filter(year => recordYears.includes(year));
  const refs = [...new Set([
    ...sourceRefs,
    ...policySources(records, evaluatedCatalogYears, designation || {})
  ])].sort();

  if (!designation || !designatedRecord || !available.includes(designatedCatalogYear)) {
    return Object.freeze({
      status: CATALOG_APPLICABILITY_STATUS.CATALOG_UNAVAILABLE,
      submittedDeclarationCatalogYear: submitted,
      studentIncomingCatalogYear: incomingCatalogYear,
      incomingCatalogYear,
      incomingCatalogComparisonYear: comparableIncomingCatalogYear,
      originalCatalogYear: incomingCatalogYear,
      candidateCatalogYears,
      evaluatedCatalogYears,
      appliedMajorCatalogYear: null,
      governingMajorCatalogYear: null,
      designatedMajorCatalogYear: designatedCatalogYear,
      latestAvailableCatalogYear: available.at(-1) || null,
      basis: "OWNER_DESIGNATED_REQUIREMENT_SET_UNAVAILABLE",
      flexibilityRuleUsed: null,
      requiresAdvisorConfirmation: false,
      approvalStatus: "UNAVAILABLE",
      materialDifferences: [],
      evaluations: [],
      sourceRefs: refs,
      ruleIds: [],
      advisorNotice: null,
      advisorNotifications: [],
      advisorAction: null
    });
  }

  const comparison = incomingRecord && comparableIncomingCatalogYear !== designatedCatalogYear
    ? compareCatalogPolicyRecords(incomingRecord, designatedRecord)
    : {status: "no_change", findings: [], unfavorable: []};
  const materialDifferences = comparison.findings || [];
  const incomingUnknown = !incomingRecord;
  const sameRequirementSet = comparableIncomingCatalogYear === designatedCatalogYear;
  const advisorNotice = sameRequirementSet
    ? null
    : administrativeNotice({
        designation,
        incomingCatalogYear: submittedIncoming,
        materialDifferences,
        sourceRefs: refs,
        unknown: incomingUnknown
      });
  const status = sameRequirementSet
    ? CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_MATCH
    : incomingUnknown
      ? CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_INCOMING_UNKNOWN
      : CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_SAC_PETITION;

  return Object.freeze({
    status,
    submittedDeclarationCatalogYear: submitted,
    studentIncomingCatalogYear: incomingCatalogYear,
    incomingCatalogYear,
    incomingCatalogComparisonYear: comparableIncomingCatalogYear,
    submittedIncomingCatalogYear: submittedIncoming || null,
    originalCatalogYear: incomingCatalogYear,
    requestedUnavailableCatalogYear,
    candidateCatalogYears,
    evaluatedCatalogYears,
    appliedMajorCatalogYear: designatedCatalogYear,
    governingMajorCatalogYear: designatedCatalogYear,
    designatedMajorCatalogYear: designatedCatalogYear,
    latestAvailableCatalogYear: available.at(-1) || null,
    basis: "OWNER_DESIGNATED_MOST_FLEXIBLE_ECONOMICS_MAJOR_REQUIREMENT_SET",
    incomingCatalogRole: designation.incomingCatalogRole,
    declarationCatalogMayOverride: false,
    automaticNewestSelectionPermitted: false,
    fallbackReason: null,
    flexibilityRuleUsed: designation.ruleId,
    requiresAdvisorConfirmation: false,
    approvalStatus: "OWNER_DESIGNATED",
    approvalCondition: null,
    materialDifferences,
    evaluations: records
      .filter(record => evaluatedCatalogYears.includes(record.catalogYear))
      .map(record => evaluation(record, designatedRecord)),
    sourceRefs: refs,
    ruleIds: [designation.ruleId],
    advisorNotice,
    advisorNotifications: advisorNotice ? [advisorNotice] : [],
    advisorAction: null,
    administrativeFollowUpOnly: Boolean(advisorNotice),
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
      recommendation: applicability.advisorNotice?.sacPetitionRequired
        ? "Use the owner-designated 2025-2026 Economics requirements and complete the routine petition with the Student Academic Assistance Committee for degree-audit records."
        : "Use the owner-designated 2025-2026 Economics requirements."
    };
  }).sort((left, right) => left.profileId.localeCompare(right.profileId));
}
