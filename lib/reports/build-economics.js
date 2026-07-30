import { availableCatalogYears, loadCatalog, resolveCatalogYear } from "../catalog/load.js";
import { mapStudentToProgram } from "../assignment/solve.js";
import { analyzeFeasibility } from "../planning/feasibility.js";
import { buildEconomicsTermPlan } from "../planning/economics.js";
import { resolvePlanningContext } from "../planning/horizon.js";
import { buildEconomicsReport } from "./economics.js";

export async function buildEconomicsReportFromStudent(student = {}, preparedDate) {
  const catalogYears = await availableCatalogYears();
  const planningContext = student.planCreationDate ? resolvePlanningContext(student) : null;
  if (planningContext?.requiresSummerClarification) {
    throw new Error(planningContext.question);
  }
  const requestedCatalogYear = planningContext?.entryCatalogYear || String(student.entryCatalogYear || "").trim();
  const catalogResolution = resolveCatalogYear(requestedCatalogYear, catalogYears);
  if (!requestedCatalogYear || catalogResolution.catalogResolutionStatus === "unavailable") {
    throw new Error(`Economics report requires an approved catalog snapshot at or before ${requestedCatalogYear || "the requested year"}.`);
  }

  const catalog = await loadCatalog(catalogResolution.selectedCatalogYear);
  const program = catalog.programs.find(item => item.id === "economics");
  const variant = catalog.variants.find(item => item.programId === "economics") || { id: "economics-base", programId: "economics", label: "Economics" };
  const mapping = mapStudentToProgram({ ...program, ...variant }, catalog.requirementsByProgram.get("economics"), student);
  const feasibility = analyzeFeasibility({
    student,
    mapping,
    prerequisites: catalog.prerequisitesByProgram.get("economics")
  });
  const enrichedMapping = {
    ...mapping,
    missingPrerequisites: feasibility.missingPrerequisites,
    minimumRegularTerms: feasibility.minimumRegularTerms
  };
  const economicsPlan = buildEconomicsTermPlan({
    student,
    mapping: enrichedMapping,
    schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"),
    courseCatalog: catalog.economicsCourses
  });
  const advisorAttention = catalogResolution.catalogResolutionStatus === "previous_year_fallback"
    ? [{
        code: "CATALOG_PREVIOUS_YEAR_FALLBACK",
        title: "Advisor Attention",
        severity: "warning",
        message: `The ${requestedCatalogYear.replace("-", "/")} Economics catalog was unavailable, so EconMapper used the approved ${catalogResolution.selectedCatalogYear.replace("-", "/")} requirements as a temporary fallback. Confirm the applicable requirements with the Economics Department before relying on this plan.`
      }]
    : [];

  return buildEconomicsReport({
    student,
    mapping: enrichedMapping,
    schedule: catalog.economicsSchedule,
    economicsPlan,
    catalog: {
      requestedCatalogYear,
      selectedCatalogYear: catalogResolution.selectedCatalogYear,
      catalogResolutionStatus: catalogResolution.catalogResolutionStatus,
      advisorAttention
    },
    preparedDate
  });
}
