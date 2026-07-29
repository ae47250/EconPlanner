import { availableCatalogYears, loadCatalog } from "../catalog/load.js";
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
  const catalogYear = planningContext?.entryCatalogYear || String(student.entryCatalogYear || "").trim();
  if (!catalogYear || !catalogYears.includes(catalogYear)) {
    throw new Error(`Economics report requires an available catalog year. Available years: ${catalogYears.join(", ")}`);
  }

  const catalog = await loadCatalog(catalogYear);
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
    prerequisites: catalog.prerequisitesByProgram.get("economics")
  });

  return buildEconomicsReport({
    student,
    mapping: enrichedMapping,
    schedule: catalog.economicsSchedule,
    economicsPlan,
    preparedDate
  });
}
