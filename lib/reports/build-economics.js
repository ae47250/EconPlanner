import { applyHanoverOnlyCourseRule } from "../planning/hanover-only-courses.js";
import { availableCatalogYears, loadCatalog } from "../catalog/load.js";
import { CATALOG_APPLICABILITY_STATUS, resolveCatalogApplicability } from "../catalog/applicability.js";
import { mapStudentToProgram } from "../assignment/solve.js";
import { analyzeFeasibility } from "../planning/feasibility.js";
import {
  buildEconomicsTermPlans,
  buildFeasibilityDetails,
  classifyFeasibility,
  annotateEconomicsPlanChoices,
  validateGeneratedPlan
} from "../planning/economics.js";
import { PlanningInputError, validatePlanningInputs, selectedPlanContext, resolvePlanningContext } from "../planning/horizon.js";
import { buildEconomicsReport } from "./economics.js";
import { buildPrerequisiteStatusNotices } from "../planning/prerequisiteEvaluator.js";
import { annotatePreliminaryScheduleEvidence } from "../policy/preliminary-schedule.js";

export async function buildEconomicsReportFromStudent(student = {}, preparedDate, selectedPlan = null, selectedPlans = []) {
  const inputValidation = validatePlanningInputs(student);
  const preparedValidation = validatePlanningInputs({ planCreationDate: preparedDate });
  const issues = [...inputValidation.issues, ...preparedValidation.issues.map(issue => ({ ...issue, field: "preparedDate" }))];
  if (issues.length) throw new PlanningInputError(issues);
  const catalogYears = await availableCatalogYears();
  const effectivePreparedDate = preparedDate || new Date().toISOString().slice(0, 10);
  const effectiveStudent = applyHanoverOnlyCourseRule(student.planCreationDate
    ? student
    : { ...student, planCreationDate: effectivePreparedDate });
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
    catalogResolutionStatus: catalogApplicability.status === CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_MATCH
      ? "owner_designated_matches_incoming"
      : "owner_designated_flexible_requirements"
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
  let planBundle = null;
  let economicsPlan = null;
  if (selectedPlan) {
    const selectedContext = selectedPlanContext(authoritativePlanningContext, selectedPlan);
    if (!selectedContext) {
      throw new Error("The selected Economics plan no longer passes server validation.");
    }
    const validation = validateGeneratedPlan(selectedPlan, {
      student: planningStudent,
      mapping: enrichedMapping,
      collectDiagnostics: true,
      schedule: catalog.economicsSchedule,
      prerequisites: catalog.prerequisitesByProgram.get("economics"),
      context: selectedContext,
      policyBundle: catalog.policyBundle,
      enforcePlanIntegrity: true
    });
    if (!validation.valid) {
      throw new Error("The selected Economics plan no longer passes server validation.");
    }
    economicsPlan = {
      ...selectedPlan,
      validation,
      planningContext: selectedContext,
      warnings: validation.warnings,
      search: null,
      solverFailure: null,
      feasibility: null
    };
    annotatePreliminaryScheduleEvidence(economicsPlan, catalog.policyBundle);
    economicsPlan.degreeRequirementInformation = validation.degreeRequirementInformation;
    economicsPlan.studentNotices = validation.studentNotices;
    economicsPlan.advisorNotifications = validation.advisorNotifications;
    economicsPlan.prerequisiteNotices = buildPrerequisiteStatusNotices({
      plan: economicsPlan,
      student: planningStudent,
      prerequisites: catalog.prerequisitesByProgram.get("economics")
    });
    economicsPlan.studentMessages = [...new Set([
      ...(validation.warnings || []),
      ...(validation.studentNotices || []).map(notice => notice.message),
      ...economicsPlan.prerequisiteNotices.map(notice => notice.message),
      ...(economicsPlan.advisorChecks || []).map(item => item.reason).filter(Boolean),
      ...(economicsPlan.terms || []).flatMap(term => (term.courses || []).map(course => course.studentHistoricalOfferingMessage).filter(Boolean))
    ])];
    economicsPlan.feasibilityStatus = classifyFeasibility(economicsPlan, planningStudent);
    economicsPlan.feasibility = buildFeasibilityDetails(
      economicsPlan,
      planningStudent,
      null
    );
    economicsPlan.feasibility.search = null;
  } else {
    planBundle = buildEconomicsTermPlans({
      student: planningStudent,
      mapping: enrichedMapping,
      collectDiagnostics: true,
      schedule: catalog.economicsSchedule,
      prerequisites: catalog.prerequisitesByProgram.get("economics"),
      courseCatalog: catalog.economicsCourses,
      policyBundle: catalog.policyBundle,
      planningContext: authoritativePlanningContext,
      catalogApplicability
    });
    economicsPlan = planBundle.plans[0] || null;
  }
  if (!economicsPlan) {
    return buildEconomicsReport({student: planningStudent, mapping: enrichedMapping, schedule: catalog.economicsSchedule, economicsPlan: null, planBundle, courseCatalog: catalog.economicsCourses, policyBundle: catalog.policyBundle, preparedDate: effectivePreparedDate});
  }
  if (selectedPlan) {
    const comparisonPlans = (Array.isArray(selectedPlans) ? selectedPlans : [])
      .filter(plan => plan.id !== economicsPlan.id)
      .map(plan => {
        const peerContext = selectedPlanContext(authoritativePlanningContext, plan);
        if (!peerContext) return { ...plan, validation: { valid: false, errors: ["The comparison plan is no longer eligible."] } };
        return {
          ...plan,
          planningContext: peerContext,
          validation: validateGeneratedPlan(plan, {
            student: planningStudent,
            mapping: enrichedMapping,
            schedule: catalog.economicsSchedule,
            prerequisites: catalog.prerequisitesByProgram.get("economics"),
            context: peerContext,
            policyBundle: catalog.policyBundle,
            enforcePlanIntegrity: true
          })
        };
      });
    const choicePlans = annotateEconomicsPlanChoices({
      plans: [...comparisonPlans, economicsPlan],
      student: planningStudent,
      mapping: enrichedMapping,
      collectDiagnostics: true,
      schedule: catalog.economicsSchedule,
      prerequisites: catalog.prerequisitesByProgram.get("economics"),
      courseCatalog: catalog.economicsCourses,
      context: authoritativePlanningContext,
      policyBundle: catalog.policyBundle
    });
    economicsPlan = choicePlans.find(plan => plan.id === economicsPlan.id) || economicsPlan;
  }
  const advisorAttention = [...new Map((economicsPlan.advisorNotifications || []).map(notice => [
    notice.code,
    {
      ...notice,
      findings: notice.materialDifferences || [],
      advisorNotice: notice
    }
  ])).values()];

  return buildEconomicsReport({
    policyBundle: catalog.policyBundle,
    courseCatalog: catalog.economicsCourses,
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
