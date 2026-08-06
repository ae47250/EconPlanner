import {
  CATALOG_APPLICABILITY_STATUS,
  CATALOG_FLEXIBILITY_RULE_ID,
  UNKNOWN_DECLARATION_CATALOG_YEAR
} from "./applicability.js";

export const INPUT_RESOLUTION_STATUS = Object.freeze({
  COMPLETE: "COMPLETE",
  RESOLVED_WITH_AUTHORIZED_DEFAULT: "RESOLVED_WITH_AUTHORIZED_DEFAULT",
  RECOVERABLE_MISSING_INFORMATION: "RECOVERABLE_MISSING_INFORMATION",
  RECOVERABLE_AMBIGUOUS_INFORMATION: "RECOVERABLE_AMBIGUOUS_INFORMATION",
  CONTRADICTORY_INFORMATION: "CONTRADICTORY_INFORMATION",
  UNSUPPORTED_INPUT: "UNSUPPORTED_INPUT",
  TRULY_INVALID: "TRULY_INVALID"
});

export function validateSubmittedCatalogYear(value, availableCatalogYears = []) {
  const submittedValue = String(value || "").trim();
  if (!submittedValue || submittedValue === UNKNOWN_DECLARATION_CATALOG_YEAR) {
    return {valid: true, submittedValue: submittedValue || null, normalizedYear: null, explicitlyUnknown: submittedValue === UNKNOWN_DECLARATION_CATALOG_YEAR};
  }
  if (!/^\d{4}-\d{4}$/.test(submittedValue) || Number(submittedValue.slice(5)) !== Number(submittedValue.slice(0, 4)) + 1) {
    return {valid: false, submittedValue, normalizedYear: null, explicitlyUnknown: false, reasonCode: "MALFORMED_MAJOR_DECLARATION_CATALOG_YEAR"};
  }
  if (!availableCatalogYears.includes(submittedValue)) {
    return {valid: false, submittedValue, normalizedYear: null, explicitlyUnknown: false, reasonCode: "UNSUPPORTED_MAJOR_DECLARATION_CATALOG_YEAR"};
  }
  return {valid: true, submittedValue, normalizedYear: submittedValue, explicitlyUnknown: false};
}

function question(field, prompt) {
  return {field, prompt};
}

export function resolveInputResolution({
  student = {},
  planningContext = {},
  catalogApplicability = null,
  issueCode = null,
  issues = [],
  catalogValidation = null
} = {}) {
  const blockingFields = [];
  const questions = [];
  let status = INPUT_RESOLUTION_STATUS.COMPLETE;
  let planningCanContinueConditionally = false;
  let advisorActionRequired = false;
  let planningMustRemainBlocked = false;

  if (issueCode === "INVALID_CATALOG_INPUT" || catalogValidation?.valid === false) {
    status = INPUT_RESOLUTION_STATUS.UNSUPPORTED_INPUT;
    blockingFields.push("majorDeclarationCatalogYear");
    questions.push(question("majorDeclarationCatalogYear", "Choose an authoritative published catalog year or select I do not know."));
    planningMustRemainBlocked = true;
  } else if (issueCode === "INVALID_TRANSFER_PLANNING_INPUT") {
    status = INPUT_RESOLUTION_STATUS.RECOVERABLE_MISSING_INFORMATION;
    if (!student.transferExpectedGraduationYear) {
      blockingFields.push("transferExpectedGraduationYear");
      questions.push(question("transferExpectedGraduationYear", "What year do you expect to graduate?"));
    }
    if (!student.transferEntryAcademicYear) {
      blockingFields.push("transferEntryAcademicYear");
      questions.push(question("transferEntryAcademicYear", "In which academic year did you first enroll at Hanover?"));
    }
    if (!blockingFields.length) {
      status = INPUT_RESOLUTION_STATUS.CONTRADICTORY_INFORMATION;
      blockingFields.push("transferExpectedGraduationYear", "transferEntryAcademicYear");
      questions.push(question("transferPlanning", "Confirm that the Hanover entry year and expected graduation year are correct."));
    }
    planningMustRemainBlocked = true;
  } else if (issueCode === "INVALID_PLANNING_PACE") {
    status = INPUT_RESOLUTION_STATUS.RECOVERABLE_MISSING_INFORMATION;
    blockingFields.push("projectedSeniorStandingConfirmation");
    questions.push(question(
      "projectedSeniorStandingConfirmation",
      `Will the Registrar or your advisor confirm senior standing by ${planningContext.projectedSeniorStandingAcademicYear || "the compressed plan's senior year"}?`
    ));
    planningMustRemainBlocked = true;
  } else if (issueCode === "INVALID_STUDENT_PREREQUISITES") {
    status = INPUT_RESOLUTION_STATUS.CONTRADICTORY_INFORMATION;
    for (const field of issues.map(issue => issue.course || issue.code).filter(Boolean)) blockingFields.push(`courses.${field}`);
    questions.push(question("courses", "Correct the selected course history or provide authoritative prerequisite-satisfaction evidence."));
    planningMustRemainBlocked = true;
    advisorActionRequired = true;
  } else if (issueCode) {
    status = INPUT_RESOLUTION_STATUS.TRULY_INVALID;
    planningMustRemainBlocked = true;
  } else if (catalogApplicability?.status === CATALOG_APPLICABILITY_STATUS.LATEST_FLEXIBLE_FALLBACK) {
    status = INPUT_RESOLUTION_STATUS.RESOLVED_WITH_AUTHORIZED_DEFAULT;
    planningCanContinueConditionally = true;
  }

  const catalogFallbackApplied = catalogApplicability?.status === CATALOG_APPLICABILITY_STATUS.LATEST_FLEXIBLE_FALLBACK;
  const safeDefaultsApplied = catalogFallbackApplied ? [{
    field: "majorDeclarationCatalogYear",
    value: catalogApplicability.appliedMajorCatalogYear,
    kind: "CONDITIONAL_PLANNING_BASIS_NOT_STUDENT_FACT",
    reasonCode: "LATEST_FLEXIBLE_MAJOR_CATALOG_AUTHORIZED_DEFAULT",
    ruleId: CATALOG_FLEXIBILITY_RULE_ID
  }] : [];
  const uniqueFields = [...new Set(blockingFields)].sort();
  const uniqueQuestions = [...new Map(questions.map(item => [`${item.field}|${item.prompt}`, item])).values()];
  return Object.freeze({
    status,
    blockingFields: uniqueFields,
    answerCount: uniqueQuestions.length,
    questions: uniqueQuestions,
    safeDefaultsApplied,
    planningCanContinueConditionally,
    advisorActionRequired,
    planningMustRemainBlocked,
    missingCatalogYearIsOnlyBlocker: !issueCode && catalogFallbackApplied,
    latestFlexibleFallbackEligible: catalogFallbackApplied,
    ruleIds: catalogFallbackApplied ? [CATALOG_FLEXIBILITY_RULE_ID] : [],
    sourceRefs: catalogFallbackApplied ? catalogApplicability.sourceRefs : [],
    issueCode,
    issueDetails: issues
  });
}
