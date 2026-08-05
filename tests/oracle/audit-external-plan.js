import {
  canonicalExternalTermKey,
  createExternalPlanSemanticSignature,
  externalTermPosition,
  parseExternalAcademicYear
} from "./plan-signature.js";
import { checkExternalEconomicsRequirements } from "./check-requirements.js";
import { checkExternalEconomicsPrerequisites } from "./check-prerequisites.js";
import { checkExternalEconomicsScheduleAndHorizon } from "./check-schedule-and-horizon.js";

const STRUCTURAL_SOURCE = "tests/oracle/audit-external-plan.js#structural-contract";

const RULE_IDS = Object.freeze({
  input: "ORACLE-STRUCTURE-INPUT",
  term: "ORACLE-STRUCTURE-TERM",
  horizon: "ORACLE-STRUCTURE-HORIZON",
  course: "ORACLE-STRUCTURE-COURSE"
});

const CHECKED_FAMILIES = Object.freeze([
  "INPUT_SHAPE",
  "TERM_IDENTITIES",
  "TERM_ORDER",
  "GRADUATION_HORIZON_STRUCTURE",
  "COURSE_ENTRY_STRUCTURE"
]);

const UNCHECKED_FAMILIES = Object.freeze([
  "REQUIREMENT_ALLOCATION",
  "PREREQUISITES",
  "SCHEDULE",
  "CAPACITY",
  "GRADUATION_RULES"
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function addViolation(violations, {
  code,
  ruleId,
  objectPath,
  message,
  sourceReference = STRUCTURAL_SOURCE
}) {
  violations.push({ code, ruleId, objectPath, message, sourceReference });
}

function validateHorizon(expectedContext, violations) {
  if (!isObject(expectedContext)) return null;
  const { startYear, remainingYears, expectedGraduationYear, expectedGraduationTerm } = expectedContext;
  const startValid = Number.isInteger(startYear) && startYear >= 1900 && startYear <= 2200;
  const remainingValid = Number.isInteger(remainingYears) && remainingYears >= 1 && remainingYears <= 5;
  const graduationValid = Number.isInteger(expectedGraduationYear)
    && expectedGraduationYear > 1900
    && expectedGraduationYear <= 2205;

  if (!startValid) addViolation(violations, {
    code: "HORIZON_START_YEAR_INVALID",
    ruleId: RULE_IDS.horizon,
    objectPath: "$.expectedContext.startYear",
    message: "The graduation horizon start year must be a four-digit integer."
  });
  if (!remainingValid) addViolation(violations, {
    code: "HORIZON_REMAINING_YEARS_INVALID",
    ruleId: RULE_IDS.horizon,
    objectPath: "$.expectedContext.remainingYears",
    message: "The graduation horizon must contain one through five remaining academic years."
  });
  if (!graduationValid) addViolation(violations, {
    code: "HORIZON_GRADUATION_YEAR_INVALID",
    ruleId: RULE_IDS.horizon,
    objectPath: "$.expectedContext.expectedGraduationYear",
    message: "The expected graduation year must be a four-digit integer."
  });
  if (startValid && remainingValid && graduationValid && expectedGraduationYear !== startYear + remainingYears) {
    addViolation(violations, {
      code: "HORIZON_YEAR_COUNT_MISMATCH",
      ruleId: RULE_IDS.horizon,
      objectPath: "$.expectedContext.expectedGraduationYear",
      message: "The expected graduation year must equal the start year plus the remaining academic years."
    });
  }

  const expectedTerm = graduationValid ? `Spring/May ${expectedGraduationYear}` : null;
  if (!nonemptyString(expectedGraduationTerm) || (expectedTerm && expectedGraduationTerm.trim() !== expectedTerm)) {
    addViolation(violations, {
      code: "HORIZON_GRADUATION_TERM_MISMATCH",
      ruleId: RULE_IDS.horizon,
      objectPath: "$.expectedContext.expectedGraduationTerm",
      message: `The expected graduation term must be ${expectedTerm || "a Spring/May year"}.`
    });
  }

  return startValid && remainingValid && graduationValid
    ? { startYear, remainingYears, expectedGraduationYear }
    : null;
}

function validateCourseEntries(term, termIndex, termIdentity, violations, seenCourseEntries) {
  const coursesPath = `$.plan.terms[${termIndex}].courses`;
  if (!Array.isArray(term.courses)) {
    addViolation(violations, {
      code: "TERM_COURSES_REQUIRED",
      ruleId: RULE_IDS.course,
      objectPath: coursesPath,
      message: "Each term must contain a courses array."
    });
    return;
  }

  term.courses.forEach((course, courseIndex) => {
    const path = `${coursesPath}[${courseIndex}]`;
    if (!isObject(course)) {
      addViolation(violations, {
        code: "COURSE_ENTRY_MALFORMED",
        ruleId: RULE_IDS.course,
        objectPath: path,
        message: "Each course entry must be an object."
      });
      return;
    }

    const courseValid = nonemptyString(course.course);
    const requirementValid = nonemptyString(course.requirementId);
    if (!courseValid) addViolation(violations, {
      code: "COURSE_CODE_REQUIRED",
      ruleId: RULE_IDS.course,
      objectPath: `${path}.course`,
      message: "Each course entry must contain a non-empty course value."
    });
    if (!requirementValid) addViolation(violations, {
      code: "COURSE_REQUIREMENT_ID_REQUIRED",
      ruleId: RULE_IDS.course,
      objectPath: `${path}.requirementId`,
      message: "Each course entry must contain a non-empty requirementId."
    });
    if (course.section !== undefined && course.section !== null && !nonemptyString(course.section)) {
      addViolation(violations, {
        code: "COURSE_SECTION_MALFORMED",
        ruleId: RULE_IDS.course,
        objectPath: `${path}.section`,
        message: "A supplied section must be a non-empty string."
      });
    }
    if (course.source !== undefined && course.source !== null && !nonemptyString(course.source)) {
      addViolation(violations, {
        code: "COURSE_SOURCE_MALFORMED",
        ruleId: RULE_IDS.course,
        objectPath: `${path}.source`,
        message: "A supplied course source must be a non-empty string."
      });
    }

    if (!courseValid || !requirementValid) return;
    const entryIdentity = [
      termIdentity || `term-index-${termIndex}`,
      course.course.trim().toUpperCase(),
      typeof course.section === "string" ? course.section.trim().toUpperCase() : "",
      course.requirementId.trim()
    ].join("|");
    if (seenCourseEntries.has(entryIdentity)) {
      addViolation(violations, {
        code: "DUPLICATE_COURSE_ENTRY",
        ruleId: RULE_IDS.course,
        objectPath: path,
        message: `This exact course entry duplicates ${seenCourseEntries.get(entryIdentity)}.`
      });
    } else {
      seenCourseEntries.set(entryIdentity, path);
    }
  });
}

function validateTerms(plan, horizon, violations) {
  if (!Array.isArray(plan.terms) || plan.terms.length === 0) {
    addViolation(violations, {
      code: "PLAN_TERMS_REQUIRED",
      ruleId: RULE_IDS.input,
      objectPath: "$.plan.terms",
      message: "The plan must contain a non-empty terms array."
    });
    return;
  }

  const seenSlotIds = new Map();
  const seenTermIdentities = new Map();
  const seenCourseEntries = new Map();
  const orderedTerms = [];

  plan.terms.forEach((term, termIndex) => {
    const path = `$.plan.terms[${termIndex}]`;
    if (!isObject(term)) {
      addViolation(violations, {
        code: "TERM_ENTRY_MALFORMED",
        ruleId: RULE_IDS.term,
        objectPath: path,
        message: "Each term must be an object."
      });
      return;
    }

    if (!nonemptyString(term.slotId)) {
      addViolation(violations, {
        code: "TERM_SLOT_ID_REQUIRED",
        ruleId: RULE_IDS.term,
        objectPath: `${path}.slotId`,
        message: "Each term must contain a non-empty slotId."
      });
    } else if (seenSlotIds.has(term.slotId.trim())) {
      addViolation(violations, {
        code: "DUPLICATE_SLOT_ID",
        ruleId: RULE_IDS.term,
        objectPath: `${path}.slotId`,
        message: `This slotId duplicates ${seenSlotIds.get(term.slotId.trim())}.`
      });
    } else {
      seenSlotIds.set(term.slotId.trim(), `${path}.slotId`);
    }

    if (!nonemptyString(term.term)) addViolation(violations, {
      code: "TERM_LABEL_REQUIRED",
      ruleId: RULE_IDS.term,
      objectPath: `${path}.term`,
      message: "Each term must contain a display label."
    });

    const parsedYear = parseExternalAcademicYear(term.academicYear);
    if (!parsedYear.valid) addViolation(violations, {
      code: "ACADEMIC_YEAR_MALFORMED",
      ruleId: RULE_IDS.term,
      objectPath: `${path}.academicYear`,
      message: "Academic years must use consecutive four-digit years such as 2026/2027."
    });

    const termKey = canonicalExternalTermKey(term.termKey);
    if (!termKey) addViolation(violations, {
      code: "TERM_KEY_INVALID",
      ruleId: RULE_IDS.term,
      objectPath: `${path}.termKey`,
      message: "termKey must be Fall, Winter, Spring/May, Summer, or TBC."
    });

    let termIdentity = null;
    if (parsedYear.valid && termKey) {
      termIdentity = `${parsedYear.canonical}|${termKey}`;
      if (seenTermIdentities.has(termIdentity)) {
        addViolation(violations, {
          code: "DUPLICATE_TERM_IDENTITY",
          ruleId: RULE_IDS.term,
          objectPath: path,
          message: `This academic-year and term identity duplicates ${seenTermIdentities.get(termIdentity)}.`
        });
      } else {
        seenTermIdentities.set(termIdentity, path);
      }

      const position = externalTermPosition(term.academicYear, term.termKey);
      orderedTerms.push({ position, path });
      if (horizon && (parsedYear.startYear < horizon.startYear || parsedYear.startYear >= horizon.expectedGraduationYear)) {
        addViolation(violations, {
          code: "TERM_OUTSIDE_GRADUATION_HORIZON",
          ruleId: RULE_IDS.horizon,
          objectPath: `${path}.academicYear`,
          message: "The term lies outside the declared graduation horizon."
        });
      }
    }

    validateCourseEntries(term, termIndex, termIdentity, violations, seenCourseEntries);
  });

  for (let index = 1; index < orderedTerms.length; index += 1) {
    if (orderedTerms[index].position >= orderedTerms[index - 1].position) continue;
    addViolation(violations, {
      code: "TERM_ORDER_INVALID",
      ruleId: RULE_IDS.term,
      objectPath: orderedTerms[index].path,
      message: "Plan terms must appear in chronological order."
    });
  }
}

export function auditExternalEconomicsPlan(input) {
  const violations = [];
  const args = isObject(input) ? input : {};
  if (!isObject(input)) addViolation(violations, {
    code: "INPUT_NOT_OBJECT",
    ruleId: RULE_IDS.input,
    objectPath: "$",
    message: "The audit input must be an object."
  });

  for (const field of ["student", "plan", "expectedContext", "policy", "verifiedSchedule"]) {
    if (isObject(args[field])) continue;
    addViolation(violations, {
      code: `${field.replace(/([A-Z])/g, "_$1").toUpperCase()}_REQUIRED`,
      ruleId: RULE_IDS.input,
      objectPath: `$.${field}`,
      message: `${field} must be supplied as an object.`
    });
  }

  const plan = isObject(args.plan) ? args.plan : {};
  if (isObject(args.plan) && !nonemptyString(plan.id)) addViolation(violations, {
    code: "PLAN_ID_REQUIRED",
    ruleId: RULE_IDS.input,
    objectPath: "$.plan.id",
    message: "The plan must contain a non-empty id."
  });

  const horizon = validateHorizon(args.expectedContext, violations);
  if (isObject(args.plan)) validateTerms(plan, horizon, violations);

  const checkedRuleFamilies = CHECKED_FAMILIES.map(family => ({ family, status: "CHECKED" }));
  const uncheckedRuleFamilies = UNCHECKED_FAMILIES.map(family => ({ family, status: "NOT_CHECKED" }));
  const reviewItems = uncheckedRuleFamilies.map(item => ({
    code: "RULE_FAMILY_NOT_CHECKED",
    family: item.family,
    status: item.status,
    message: `${item.family} is intentionally not checked by the Task 3 structural oracle.`
  }));
  const valid = violations.length === 0 && uncheckedRuleFamilies.length === 0;
  return {
    valid,
    status: violations.length ? "INVALID_STRUCTURE" : uncheckedRuleFamilies.length ? "NOT_CHECKED" : "VALID",
    violations,
    warnings: [],
    reviewItems,
    semanticSignature: createExternalPlanSemanticSignature(args.plan, args.expectedContext),
    checkedRuleFamilies,
    uncheckedRuleFamilies
  };
}

export function auditExternalEconomicsPlanWithRequirements(input) {
  const structural = auditExternalEconomicsPlan(input);
  if (structural.violations.length) return structural;

  const requirements = checkExternalEconomicsRequirements(input);
  const structuralReviewItems = structural.reviewItems.filter(
    item => item.family !== "REQUIREMENT_ALLOCATION"
  );
  const requirementReviewItems = requirements.reviewItems.filter(
    item => item.code !== "RULE_FAMILY_NOT_CHECKED"
  );
  const checkedRuleFamilies = [
    ...structural.checkedRuleFamilies,
    ...requirements.checkedRuleFamilies
  ];
  const uncheckedRuleFamilies = requirements.uncheckedRuleFamilies;
  const status = requirements.violations.length
    ? requirements.status
    : requirementReviewItems.length
      ? "REVIEW_REQUIRED"
      : "NOT_CHECKED";

  return {
    ...structural,
    valid: false,
    status,
    violations: requirements.violations,
    warnings: requirements.warnings,
    reviewItems: [
      ...requirementReviewItems,
      ...structuralReviewItems.filter(item => uncheckedRuleFamilies.some(
        family => family.family === item.family
      ))
    ],
    checkedRuleFamilies,
    uncheckedRuleFamilies,
    requirementAllocation: requirements
  };
}

export function auditExternalEconomicsPlanWithPrerequisites(input) {
  const requirementsAudit = auditExternalEconomicsPlanWithRequirements(input);
  if (requirementsAudit.violations.length
    || requirementsAudit.requirementAllocation?.status !== "VALID_REQUIREMENTS") {
    return requirementsAudit;
  }

  const prerequisites = checkExternalEconomicsPrerequisites(input);
  const prerequisiteReviewItems = prerequisites.reviewItems.filter(
    item => item.code !== "RULE_FAMILY_NOT_CHECKED"
  );
  const checkedRuleFamilies = [
    ...requirementsAudit.checkedRuleFamilies,
    ...prerequisites.checkedRuleFamilies
  ];
  const uncheckedRuleFamilies = prerequisites.uncheckedRuleFamilies;
  const status = prerequisites.violations.length
    ? prerequisites.status
    : prerequisiteReviewItems.length
      ? "REVIEW_REQUIRED"
      : "NOT_CHECKED";

  return {
    ...requirementsAudit,
    valid: false,
    status,
    violations: prerequisites.violations,
    warnings: prerequisites.warnings,
    reviewItems: [
      ...prerequisiteReviewItems,
      ...requirementsAudit.reviewItems.filter(item => uncheckedRuleFamilies.some(
        family => family.family === item.family
      ))
    ],
    checkedRuleFamilies,
    uncheckedRuleFamilies,
    prerequisiteValidation: prerequisites
  };
}

export function auditExternalEconomicsPlanComplete(input) {
  const prerequisitesAudit = auditExternalEconomicsPlanWithPrerequisites(input);
  if (prerequisitesAudit.violations.length
    || prerequisitesAudit.prerequisiteValidation?.status !== "VALID_PREREQUISITES") {
    return prerequisitesAudit;
  }

  const scheduleAndHorizon = checkExternalEconomicsScheduleAndHorizon({
    ...input,
    requirementAllocation: prerequisitesAudit.requirementAllocation
  });
  const checkedRuleFamilies = [
    ...prerequisitesAudit.checkedRuleFamilies,
    ...scheduleAndHorizon.checkedRuleFamilies
  ];
  const reviewedFamilies = new Set(scheduleAndHorizon.checkedRuleFamilies.map(item => item.family));
  const reviewItems = [
    ...prerequisitesAudit.reviewItems.filter(item => !reviewedFamilies.has(item.family)),
    ...scheduleAndHorizon.reviewItems
  ];

  return {
    ...prerequisitesAudit,
    valid: scheduleAndHorizon.valid,
    status: scheduleAndHorizon.status,
    feasibilityStatus: scheduleAndHorizon.feasibilityStatus,
    violations: scheduleAndHorizon.violations,
    warnings: scheduleAndHorizon.warnings,
    reviewItems,
    enrollmentConditions: scheduleAndHorizon.enrollmentConditions,
    preliminaryFindings: scheduleAndHorizon.preliminaryFindings,
    checkedRuleFamilies,
    uncheckedRuleFamilies: [],
    scheduleAndHorizonValidation: scheduleAndHorizon
  };
}
