import {createHash} from "node:crypto";
import {canonicalJson} from "../policy/canonical-json.js";
import {catalogPolicyRecords} from "./policy-releases.js";
import {compareCatalogPolicyRecords} from "./compare.js";

export const UNKNOWN_DECLARATION_CATALOG_YEAR = "I_DO_NOT_KNOW";
export const CATALOG_FLEXIBILITY_RULE_ID = "CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK";
export const CATALOG_NOTICE_REASON_CODE = "LATEST_FLEXIBLE_MAJOR_RULES_APPLIED";

export const CATALOG_APPLICABILITY_STATUS = Object.freeze({
  EXACT: "EXACT_DECLARATION_CATALOG",
  EXACT_DECLARATION_CATALOG: "EXACT_DECLARATION_CATALOG",
  LATEST_FLEXIBLE_APPROVED: "LATEST_FLEXIBLE_APPROVED",
  LATEST_FLEXIBLE_FALLBACK: "LATEST_FLEXIBLE_FALLBACK",
  AMBIGUOUS: "AMBIGUOUS_MATERIAL_CONFLICT",
  AMBIGUOUS_MATERIAL_CONFLICT: "AMBIGUOUS_MATERIAL_CONFLICT",
  UNAVAILABLE: "CATALOG_UNAVAILABLE",
  CATALOG_UNAVAILABLE: "CATALOG_UNAVAILABLE"
});

function catalogStart(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{4})$/);
  return match && Number(match[2]) === Number(match[1]) + 1 ? Number(match[1]) : null;
}

function orderedYears(values) {
  return [...new Set(values)].filter(year => catalogStart(year) !== null).sort((left, right) => catalogStart(left) - catalogStart(right));
}

function catalogRange(first, last) {
  const start = catalogStart(first);
  const end = catalogStart(last);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return Array.from({length: high - low + 1}, (_, index) => `${low + index}-${low + index + 1}`);
}

function stableId(prefix, identity) {
  const digest = createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

function conflictAdvisorAction({candidateCatalogYears, sourceRefs, materialDifferences, reasonCode}) {
  const identity = {candidateCatalogYears, sourceRefs, materialDifferences, reasonCode};
  return {
    actionId: stableId("advisor-action", identity),
    reasonCode,
    controllingRuleId: CATALOG_FLEXIBILITY_RULE_ID,
    controllingRuleIds: [CATALOG_FLEXIBILITY_RULE_ID],
    sourceRefs,
    responsibleAuthority: "ECONOMICS_DEPARTMENT_OR_AUTHORIZED_ADVISOR",
    evidenceRequired: ["CONFIRMED_MAJOR_DECLARATION_CATALOG_AND_APPLICABLE_REQUIREMENTS"],
    affectedObject: {catalogDecision: "APPLIED_ECONOMICS_MAJOR_CATALOG"},
    currentDisposition: "UNRESOLVED_REVIEW"
  };
}

function canonicalAdvisorNotice({
  submittedDeclarationCatalogYear,
  originalCatalogYear,
  candidateCatalogYears,
  appliedMajorCatalogYear,
  latestAvailableCatalogYear,
  materialDifferences,
  sourceRefs,
  basis
}) {
  const affected = [...new Set(materialDifferences.flatMap(item => item.affected || []))].sort();
  const identity = {
    reasonCode: CATALOG_NOTICE_REASON_CODE,
    submittedDeclarationCatalogYear,
    originalCatalogYear,
    candidateCatalogYears,
    appliedMajorCatalogYear,
    latestAvailableCatalogYear,
    materialDifferences,
    basis
  };
  return Object.freeze({
    noticeId: stableId("advisor-notice", identity),
    reasonCode: CATALOG_NOTICE_REASON_CODE,
    submittedDeclarationCatalogYear: submittedDeclarationCatalogYear || UNKNOWN_DECLARATION_CATALOG_YEAR,
    candidateCatalogYears,
    originalCatalogYear,
    appliedMajorCatalogYear,
    latestAvailableCatalogYear,
    materialDifferences,
    whyMoreFlexible: materialDifferences.length
      ? "The applied catalog adds authorized Economics-major options or removes a department milestone."
      : "The latest authoritative published Economics catalog is the policy-authorized conditional planning basis.",
    confirmationRequested: "Confirm that the student may use the applied Economics-major catalog requirements.",
    responsibleAuthority: "ECONOMICS_DEPARTMENT_OR_AUTHORIZED_ADVISOR",
    controllingRuleIds: [CATALOG_FLEXIBILITY_RULE_ID],
    sourceRefs,
    readinessEffect: "READY_WITH_CONDITIONS",
    affectedCoursesRequirementsOrMilestones: affected
  });
}

function policySources(records, years) {
  const sourceRefs = records.filter(record => years.includes(record.catalogYear)).flatMap(record => record.sourceRefs || []);
  sourceRefs.push("OWNER-CONFIRMATION-CP4B-B#CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK");
  return [...new Set(sourceRefs)].sort();
}

function evaluation(record, latestRecord) {
  const comparison = compareCatalogPolicyRecords(record, latestRecord);
  return {
    catalogYear: record.catalogYear,
    completionBasis: "CATALOG_REQUIREMENT_SNAPSHOT",
    comparisonToLatest: comparison.status,
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
  latestFlexibleApprovalStatus = null,
  catalogRecords = null
} = {}) {
  const records = (catalogRecords || catalogPolicyRecords()).filter(record => record.publicationStatus === "AUTHORITATIVE_PUBLISHED");
  const recordYears = records.map(record => record.catalogYear);
  const available = orderedYears(availableCatalogYears.length ? availableCatalogYears.filter(year => recordYears.includes(year)) : recordYears);
  const latestAvailableCatalogYear = available.at(-1) || null;
  const latestRecord = records.find(record => record.catalogYear === latestAvailableCatalogYear) || null;
  const submitted = String(majorDeclarationCatalogYear || "").trim() || null;
  const explicitlyUnknown = submitted === UNKNOWN_DECLARATION_CATALOG_YEAR;
  const declared = !explicitlyUnknown && catalogStart(submitted) !== null ? submitted : null;

  if (!latestRecord) {
    const refs = [...new Set(sourceRefs)].sort();
    const candidates = declared ? [declared] : orderedYears(catalogRange(entryCatalogYear, currentCatalogYear || entryCatalogYear));
    return Object.freeze({
      status: CATALOG_APPLICABILITY_STATUS.CATALOG_UNAVAILABLE,
      submittedDeclarationCatalogYear: submitted,
      originalCatalogYear: null,
      candidateCatalogYears: candidates,
      evaluatedCatalogYears: [],
      appliedMajorCatalogYear: null,
      governingMajorCatalogYear: null,
      latestAvailableCatalogYear: null,
      basis: "NO_AUTHORITATIVE_PUBLISHED_ECONOMICS_CATALOG_AVAILABLE",
      flexibilityRuleUsed: null,
      requiresAdvisorConfirmation: true,
      approvalStatus: "UNRESOLVED",
      materialDifferences: [],
      evaluations: [],
      sourceRefs: refs,
      ruleIds: [],
      advisorNotice: null,
      advisorAction: conflictAdvisorAction({candidateCatalogYears: candidates, sourceRefs: refs, materialDifferences: [], reasonCode: "CATALOG_UNAVAILABLE"})
    });
  }

  const availableSet = new Set(available);
  const declaredRecord = records.find(record => record.catalogYear === declared) || null;
  const inferredCandidates = orderedYears(catalogRange(entryCatalogYear, currentCatalogYear || entryCatalogYear));
  const unknownCandidates = inferredCandidates.length ? inferredCandidates : available;
  const requestedUnavailable = Boolean(declared && !availableSet.has(declared));
  const candidateCatalogYears = declared
    ? orderedYears([declared, ...(declared !== latestAvailableCatalogYear ? [latestAvailableCatalogYear] : [])])
    : orderedYears([...unknownCandidates, latestAvailableCatalogYear]);
  const evaluatedCatalogYears = candidateCatalogYears.filter(year => availableSet.has(year));
  const evaluatedRecords = records.filter(record => evaluatedCatalogYears.includes(record.catalogYear));
  const originalCatalogYear = declaredRecord?.catalogYear || null;
  const originalComparison = originalCatalogYear && originalCatalogYear !== latestAvailableCatalogYear
    ? compareCatalogPolicyRecords(declaredRecord, latestRecord)
    : {status: "no_change", findings: [], unfavorable: []};
  const oldestCandidateRecord = evaluatedRecords[0] || latestRecord;
  const unknownComparison = compareCatalogPolicyRecords(oldestCandidateRecord, latestRecord);
  const comparison = originalCatalogYear ? originalComparison : unknownComparison;
  const refs = [...new Set([...sourceRefs, ...policySources(records, evaluatedCatalogYears)])].sort();

  if (declaredRecord && declared === latestAvailableCatalogYear) {
    return Object.freeze({
      status: CATALOG_APPLICABILITY_STATUS.EXACT_DECLARATION_CATALOG,
      submittedDeclarationCatalogYear: submitted,
      originalCatalogYear: declared,
      candidateCatalogYears: [declared],
      evaluatedCatalogYears: [declared],
      appliedMajorCatalogYear: declared,
      governingMajorCatalogYear: declared,
      latestAvailableCatalogYear,
      basis: "DECLARATION_YEAR_PROVIDED_AUTHORITATIVE_RELEASE",
      flexibilityRuleUsed: null,
      requiresAdvisorConfirmation: false,
      approvalStatus: "EXACT_CATALOG",
      materialDifferences: [],
      evaluations: [evaluation(declaredRecord, latestRecord)],
      sourceRefs: refs,
      ruleIds: [],
      advisorNotice: null,
      advisorAction: null
    });
  }

  const hasMaterialConflict = Boolean(originalCatalogYear && comparison.unfavorable?.length);
  if (hasMaterialConflict) {
    const advisorAction = conflictAdvisorAction({
      candidateCatalogYears,
      sourceRefs: refs,
      materialDifferences: comparison.findings,
      reasonCode: "AMBIGUOUS_MATERIAL_CATALOG_CONFLICT"
    });
    return Object.freeze({
      status: CATALOG_APPLICABILITY_STATUS.AMBIGUOUS_MATERIAL_CONFLICT,
      submittedDeclarationCatalogYear: submitted,
      originalCatalogYear,
      candidateCatalogYears,
      evaluatedCatalogYears,
      appliedMajorCatalogYear: originalCatalogYear,
      governingMajorCatalogYear: originalCatalogYear,
      latestAvailableCatalogYear,
      basis: "NEWER_CATALOG_HAS_STRICTER_OR_CONFLICTING_RULE",
      flexibilityRuleUsed: CATALOG_FLEXIBILITY_RULE_ID,
      requiresAdvisorConfirmation: true,
      approvalStatus: "UNRESOLVED_MATERIAL_CONFLICT",
      materialDifferences: comparison.findings,
      evaluations: evaluatedRecords.map(record => evaluation(record, latestRecord)),
      sourceRefs: refs,
      ruleIds: [CATALOG_FLEXIBILITY_RULE_ID],
      advisorNotice: null,
      advisorAction
    });
  }

  const approved = originalCatalogYear && latestFlexibleApprovalStatus === "APPROVED";
  const status = approved
    ? CATALOG_APPLICABILITY_STATUS.LATEST_FLEXIBLE_APPROVED
    : CATALOG_APPLICABILITY_STATUS.LATEST_FLEXIBLE_FALLBACK;
  const basis = requestedUnavailable
    ? "REQUESTED_CATALOG_UNAVAILABLE_LATEST_PUBLISHED_FALLBACK"
    : originalCatalogYear
      ? "KNOWN_OLDER_CATALOG_LATEST_FLEXIBLE_POLICY"
      : "DECLARATION_YEAR_UNKNOWN_LATEST_FLEXIBLE_POLICY";
  const materialDifferences = comparison.findings || [];
  const advisorNotice = canonicalAdvisorNotice({
    submittedDeclarationCatalogYear: submitted,
    originalCatalogYear,
    candidateCatalogYears,
    appliedMajorCatalogYear: latestAvailableCatalogYear,
    latestAvailableCatalogYear,
    materialDifferences,
    sourceRefs: refs,
    basis
  });
  return Object.freeze({
    status,
    submittedDeclarationCatalogYear: submitted,
    originalCatalogYear,
    requestedUnavailableCatalogYear: requestedUnavailable ? declared : null,
    candidateCatalogYears,
    evaluatedCatalogYears,
    appliedMajorCatalogYear: latestAvailableCatalogYear,
    governingMajorCatalogYear: latestAvailableCatalogYear,
    latestAvailableCatalogYear,
    basis,
    fallbackReason: requestedUnavailable
      ? "The requested catalog is not published in the governed source set."
      : originalCatalogYear
        ? "The newer catalog is equally or more flexible within the owner-approved Economics-major boundary."
        : "The declaration catalog is unknown, so the latest published flexible catalog is used conditionally.",
    flexibilityRuleUsed: CATALOG_FLEXIBILITY_RULE_ID,
    requiresAdvisorConfirmation: !approved,
    approvalStatus: approved ? "APPROVED_FOR_STUDENT" : "CONFIRMATION_REQUIRED",
    approvalCondition: approved ? null : "Advisor or Economics Department confirmation of the applied major requirements",
    materialDifferences,
    evaluations: evaluatedRecords.map(record => evaluation(record, latestRecord)),
    sourceRefs: refs,
    ruleIds: [CATALOG_FLEXIBILITY_RULE_ID],
    advisorNotice,
    advisorAction: null
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
      catalogRecords: options.catalogRecords
    });
    return {
      profileId: profile.profileId,
      confirmedMajorDeclarationCatalogYear: profile.majorDeclarationCatalogYear || null,
      inferredEntryYear: profile.entryCatalogYear || null,
      possibleGoverningDeclarationCatalogYears: applicability.candidateCatalogYears,
      catalogApplicabilityStatus: applicability.status,
      appliedMajorCatalogYear: applicability.appliedMajorCatalogYear,
      latestAvailableCatalogYear: applicability.latestAvailableCatalogYear,
      materiallyDifferentOutcomePossible: applicability.materialDifferences.length > 0,
      differingRuleFamilies: [...new Set(applicability.materialDifferences.map(item => item.family))].sort(),
      missingAuthoritativeSources: applicability.requestedUnavailableCatalogYear ? [applicability.requestedUnavailableCatalogYear] : [],
      fieldsNeeded: applicability.requiresAdvisorConfirmation ? ["majorDeclarationCatalogYear"] : [],
      recommendation: applicability.requiresAdvisorConfirmation
        ? "Use the latest flexible Economics catalog conditionally and confirm it with the advisor or department."
        : "Use the exact authoritative declaration catalog."
    };
  }).sort((left, right) => left.profileId.localeCompare(right.profileId));
}
