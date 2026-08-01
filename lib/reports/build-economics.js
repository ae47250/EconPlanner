import { availableCatalogYears, loadCatalog, resolveCatalogYear } from "../catalog/load.js";
import { mapStudentToProgram } from "../assignment/solve.js";
import { analyzeFeasibility } from "../planning/feasibility.js";
import {
  buildEconomicsTermPlans,
  classifyFeasibility,
  validateGeneratedPlan
} from "../planning/economics.js";
import { resolvePlanningContext } from "../planning/horizon.js";
import { buildEconomicsReport } from "./economics.js";

export async function buildEconomicsReportFromStudent(student = {}, preparedDate, selectedPlan = null) {
  const catalogYears = await availableCatalogYears();
  const effectivePreparedDate = preparedDate || new Date().toISOString().slice(0, 10);
  let effectiveStudent = student.planCreationDate
    ? student
    : { ...student, planCreationDate: effectivePreparedDate };
  let planningContext = resolvePlanningContext(effectiveStudent);
  if (!student.planCreationDate && planningContext.requiresSummerClarification) {
    effectiveStudent = { ...effectiveStudent, summerStandingConfirmed: "yes" };
    planningContext = resolvePlanningContext(effectiveStudent);
  }
  if (planningContext?.requiresSummerClarification) {
    throw new Error(planningContext.question);
  }
  const requestedCatalogYear = !student.planCreationDate && student.entryCatalogYear
    ? String(student.entryCatalogYear).trim()
    : planningContext?.entryCatalogYear || String(effectiveStudent.entryCatalogYear || "").trim();
  const catalogResolution = resolveCatalogYear(requestedCatalogYear, catalogYears);
  if (!requestedCatalogYear || catalogResolution.catalogResolutionStatus === "unavailable") {
    throw new Error(`Economics report requires an approved catalog snapshot at or before ${requestedCatalogYear || "the requested year"}.`);
  }

  const catalog = await loadCatalog(catalogResolution.selectedCatalogYear);
  const program = catalog.programs.find(item => item.id === "economics");
  const variant = catalog.variants.find(item => item.programId === "economics") || { id: "economics-base", programId: "economics", label: "Economics" };
  const mapping = mapStudentToProgram({ ...program, ...variant }, catalog.requirementsByProgram.get("economics"), effectiveStudent);
  const feasibility = analyzeFeasibility({
    student: effectiveStudent,
    mapping,
    prerequisites: catalog.prerequisitesByProgram.get("economics")
  });
  const enrichedMapping = {
    ...mapping,
    missingPrerequisites: feasibility.missingPrerequisites,
    minimumRegularTerms: feasibility.minimumRegularTerms
  };
  const planBundle = buildEconomicsTermPlans({
    student: effectiveStudent,
    mapping: enrichedMapping,
    schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"),
    courseCatalog: catalog.economicsCourses
  });
  let economicsPlan = planBundle.plans[0] || null;
  if (selectedPlan) {
    const selectedContext = selectedPlan.isEarlyGraduation
      ? planBundle.earlyGraduationContext
      : planBundle.context;
    const validation = validateGeneratedPlan(selectedPlan, {
      student: effectiveStudent,
      mapping: enrichedMapping,
      schedule: catalog.economicsSchedule,
      prerequisites: catalog.prerequisitesByProgram.get("economics"),
      context: selectedContext
    });
    if (!validation.valid) {
      throw new Error("The selected Economics plan no longer passes server validation.");
    }
    economicsPlan = { ...selectedPlan, validation };
    economicsPlan.feasibilityStatus = classifyFeasibility(economicsPlan, effectiveStudent);
  }
  if (!economicsPlan) {
    throw new Error("No complete Economics plan is feasible for the supplied student record and graduation horizon.");
  }
  const advisorAttention = catalogResolution.catalogResolutionStatus === "previous_year_fallback"
    ? [{
        code: "CATALOG_PREVIOUS_YEAR_FALLBACK",
        title: "Advisor Attention",
        severity: "warning",
        message: `The ${requestedCatalogYear.replace("-", "/")} Economics catalog was unavailable, so EconMapper used the approved ${catalogResolution.selectedCatalogYear.replace("-", "/")} requirements as a temporary fallback. Confirm the applicable requirements with the Economics Department before relying on this plan.`
      }]
    : [];

  return buildEconomicsReport({
    student: effectiveStudent,
    mapping: enrichedMapping,
    schedule: catalog.economicsSchedule,
    economicsPlan,
    planBundle,
    catalog: {
      requestedCatalogYear,
      selectedCatalogYear: catalogResolution.selectedCatalogYear,
      catalogResolutionStatus: catalogResolution.catalogResolutionStatus,
      advisorAttention
    },
    preparedDate: effectivePreparedDate
  });
}
