import { createHash } from "node:crypto";
import { canonicalJson } from "../policy/canonical-json.js";

export const CATALOG_APPLICABILITY_STATUS = Object.freeze({
  EXACT: "EXACT",
  AMBIGUOUS: "AMBIGUOUS",
  UNAVAILABLE: "UNAVAILABLE"
});

function catalogStart(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{4})$/);
  return match && Number(match[2]) === Number(match[1]) + 1 ? Number(match[1]) : null;
}

function catalogRange(first, last) {
  const start = catalogStart(first);
  const end = catalogStart(last);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return Array.from({ length: high - low + 1 }, (_, index) => `${low + index}-${low + index + 1}`);
}

function advisorAction(candidateCatalogYears, sourceRefs) {
  const identity = { candidateCatalogYears, sourceRefs };
  const digest = createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex").slice(0, 20);
  return {
    actionId: `advisor-action-${digest}`,
    reasonCode: "CATALOG_APPLICABILITY_REVIEW",
    controllingRuleId: "CATALOG-APPLICABILITY-DECLARATION-YEAR",
    sourceRefs,
    responsibleAuthority: "ACADEMIC_ADVISOR_OR_REGISTRAR",
    evidenceRequired: ["MAJOR_DECLARATION_CATALOG_YEAR"],
    affectedObject: { catalogDecision: "GOVERNING_MAJOR_CATALOG_YEAR" },
    currentDisposition: "UNRESOLVED_REVIEW"
  };
}

export function resolveCatalogApplicability({
  majorDeclarationCatalogYear = null,
  entryCatalogYear = null,
  currentCatalogYear = null,
  availableCatalogYears = [],
  sourceRefs = []
} = {}) {
  const available = [...new Set(availableCatalogYears)].filter(year => catalogStart(year) !== null).sort();
  const declared = catalogStart(majorDeclarationCatalogYear) === null ? null : majorDeclarationCatalogYear;
  const candidates = declared
    ? [declared]
    : catalogRange(entryCatalogYear, currentCatalogYear || entryCatalogYear);
  const evaluated = candidates.filter(year => available.includes(year));

  if (declared && available.includes(declared)) {
    return Object.freeze({
      status: CATALOG_APPLICABILITY_STATUS.EXACT,
      governingMajorCatalogYear: declared,
      candidateCatalogYears: [declared],
      evaluatedCatalogYears: [declared],
      basis: "DECLARATION_YEAR_PROVIDED",
      sourceRefs: [...new Set(sourceRefs)].sort(),
      advisorAction: null
    });
  }

  const status = declared || !candidates.length
    ? CATALOG_APPLICABILITY_STATUS.UNAVAILABLE
    : CATALOG_APPLICABILITY_STATUS.AMBIGUOUS;
  const refs = [...new Set(sourceRefs)].sort();
  return Object.freeze({
    status,
    governingMajorCatalogYear: null,
    candidateCatalogYears: candidates,
    evaluatedCatalogYears: evaluated,
    basis: declared ? "DECLARATION_YEAR_RELEASE_UNAVAILABLE" : "DECLARATION_YEAR_NOT_PROVIDED",
    sourceRefs: refs,
    advisorAction: advisorAction(candidates, refs)
  });
}

export function analyzeCatalogApplicabilityProfiles(profiles = [], options = {}) {
  return [...profiles].map(profile => {
    const applicability = resolveCatalogApplicability({
      majorDeclarationCatalogYear: profile.majorDeclarationCatalogYear,
      entryCatalogYear: profile.entryCatalogYear,
      currentCatalogYear: profile.currentCatalogYear,
      availableCatalogYears: options.availableCatalogYears,
      sourceRefs: options.sourceRefs
    });
    return {
      profileId: profile.profileId,
      confirmedMajorDeclarationCatalogYear: profile.majorDeclarationCatalogYear || null,
      inferredEntryYear: profile.entryCatalogYear || null,
      possibleGoverningDeclarationCatalogYears: applicability.candidateCatalogYears,
      catalogApplicabilityStatus: applicability.status,
      materiallyDifferentOutcomePossible: applicability.status !== CATALOG_APPLICABILITY_STATUS.EXACT,
      differingRuleFamilies: applicability.status === CATALOG_APPLICABILITY_STATUS.EXACT ? [] : ["REQUIREMENTS", "PREREQUISITES", "EQUIVALENCIES"],
      missingAuthoritativeSources: applicability.candidateCatalogYears.filter(year => !applicability.evaluatedCatalogYears.includes(year)),
      fieldsNeeded: applicability.status === CATALOG_APPLICABILITY_STATUS.EXACT ? [] : ["majorDeclarationCatalogYear"],
      recommendation: applicability.status === CATALOG_APPLICABILITY_STATUS.EXACT
        ? "No CP4b-B catalog applicability work is required for this profile."
        : "CP4b-B should validate and activate the authoritative release only after the declaration year is supplied or resolved by an advisor."
    };
  }).sort((left, right) => left.profileId.localeCompare(right.profileId));
}
