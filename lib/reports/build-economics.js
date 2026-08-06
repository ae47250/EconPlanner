import { availableCatalogYears, loadCatalog } from "../catalog/load.js";
import { CATALOG_APPLICABILITY_STATUS, resolveCatalogApplicability } from "../catalog/applicability.js";
import { mapStudentToProgram } from "../assignment/solve.js";
import { analyzeFeasibility } from "../planning/feasibility.js";
import {
  buildEconomicsTermPlans,
  buildFeasibilityDetails,
  classifyFeasibility,
  validateGeneratedPlan
} from "../planning/economics.js";
import { resolvePlanningContext } from "../planning/horizon.js";
import { buildEconomicsReport } from "./economics.js";
import { runShadowSafely } from "../decision-engine/shadow.js";

export async function buildEconomicsReportFromStudent(student = {}, preparedDate, selectedPlan = null) {
  const catalogYears = await availableCatalogYears();
  const effectivePreparedDate = preparedDate || new Date().toISOString().slice(0, 10);
  const effectiveStudent = student.planCreationDate
    ? student
    : { ...student, planCreationDate: effectivePreparedDate };
  const planningContext = resolvePlanningContext(effectiveStudent);
  if (planningContext.isTransferStudent && !planningContext.transferValidation.valid) {
    throw new Error(planningContext.transferValidation.errors[0]);
  }
  if (!planningContext.planningValidation.valid) {
    throw new Error(planningContext.planningValidation.errors[0]);
  }
  const planningStudent = {
    ...effectiveStudent,
    expectedGraduationTerm: planningContext.expectedGraduationTerm
  };
  const requestedCatalogYear = planningContext.submittedMajorDeclarationCatalogYear
    || (!student.planCreationDate && student.entryCatalogYear
      ? String(student.entryCatalogYear).trim()
      : planningContext?.entryCatalogYear || String(effectiveStudent.entryCatalogYear || "").trim());
  const catalogApplicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: planningContext.submittedMajorDeclarationCatalogYear,
    entryCatalogYear: planningContext.entryCatalogYear,
    currentCatalogYear: planningContext.currentCatalogYear,
    availableCatalogYears: catalogYears
  });
  if (!catalogApplicability.appliedMajorCatalogYear) {
    throw new Error(`Economics report requires an authoritative published catalog snapshot at or before ${requestedCatalogYear || "the requested year"}.`);
  }
  const catalogResolution = {
    requestedCatalogYear,
    selectedCatalogYear: catalogApplicability.appliedMajorCatalogYear,
    catalogResolutionStatus: catalogApplicability.status === CATALOG_APPLICABILITY_STATUS.EXACT_DECLARATION_CATALOG
      ? "exact"
      : "latest_flexible_conditional_fallback"
  };

  const catalog = await loadCatalog(catalogResolution.selectedCatalogYear);
  const authoritativePlanningContext = {...planningContext, catalogApplicability};
  const program = catalog.programs.find(item => item.id === "economics");
  const variant = catalog.variants.find(item => item.programId === "economics") || { id: "economics-base", programId: "economics", label: "Economics" };
  const mapping = mapStudentToProgram(
    { ...program, ...variant },
    catalog.requirementsByProgram.get("economics"),
    planningStudent,
    {policyBundle: catalog.policyBundle, catalogApplicability}
  );
  const feasibility = analyzeFeasibility({
    student: planningStudent,
    mapping,
    prerequisites: catalog.prerequisitesByProgram.get("economics"),
    policyBundle: catalog.policyBundle
  });
  const enrichedMapping = {
    ...mapping,
    missingPrerequisites: feasibility.missingPrerequisites,
    minimumRegularTerms: feasibility.minimumRegularTerms
  };
  const planBundle = buildEconomicsTermPlans({
    student: planningStudent,
    mapping: enrichedMapping,
    schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"),
    courseCatalog: catalog.economicsCourses,
    policyBundle: catalog.policyBundle,
    planningContext: authoritativePlanningContext,
    catalogApplicability
  });
  let economicsPlan = planBundle.plans[0] || null;
  if (selectedPlan) {
    const selectedContext = selectedPlan.isEarlyGraduation
      ? planBundle.earlyGraduationContext
      : planBundle.context;
    const validation = validateGeneratedPlan(selectedPlan, {
      student: planningStudent,
      mapping: enrichedMapping,
      schedule: catalog.economicsSchedule,
      prerequisites: catalog.prerequisitesByProgram.get("economics"),
      context: selectedContext,
      policyBundle: catalog.policyBundle,
      enforcePlanIntegrity: true
    });
    if (!validation.valid) {
      throw new Error("The selected Economics plan no longer passes server validation.");
    }
    economicsPlan = { ...selectedPlan, validation };
    economicsPlan.feasibilityStatus = classifyFeasibility(economicsPlan, planningStudent);
    economicsPlan.feasibility = buildFeasibilityDetails(
      economicsPlan,
      planningStudent,
      selectedPlan.feasibility?.search
    );
  }
  if (!economicsPlan) {
    throw new Error("No complete Economics plan is feasible for the supplied student record and graduation horizon.");
  }
  const advisorAttention = catalogApplicability.advisorNotice ? [{
    code: catalogApplicability.advisorNotice.reasonCode,
    title: "Economics catalog confirmation",
    severity: "warning",
    message: `The planner used the ${catalogApplicability.appliedMajorCatalogYear.replace("-", "/")} Economics-major requirements conditionally. Confirm that this student may use them.`,
    findings: catalogApplicability.materialDifferences,
    advisorNotice: catalogApplicability.advisorNotice
  }] : [];

  await runShadowSafely({
    student: planningStudent,
    plan: economicsPlan,
    productionValidation: economicsPlan.validation,
    catalogYear: catalogResolution.selectedCatalogYear,
    context: { planningContext: economicsPlan.planningContext || planBundle.context },
    source: "economics-report-json"
  });

  return buildEconomicsReport({
    student: planningStudent,
    mapping: enrichedMapping,
    schedule: catalog.economicsSchedule,
    economicsPlan,
    planBundle,
    catalog: {
      requestedCatalogYear,
      selectedCatalogYear: catalogResolution.selectedCatalogYear,
      catalogResolutionStatus: catalogResolution.catalogResolutionStatus,
      catalogApplicability,
      advisorAttention
    },
    preparedDate: effectivePreparedDate
  });
}
