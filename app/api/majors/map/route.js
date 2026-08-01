import { availableCatalogYears, loadCatalog, resolveCatalogYear } from "../../../../lib/catalog/load.js";
import { mapStudentToProgram } from "../../../../lib/assignment/solve.js";
import { analyzeFeasibility } from "../../../../lib/planning/feasibility.js";
import {
  assigned100LevelElectives,
  buildEconomicsTermPlans,
  classifyFeasibility,
  validateGeneratedPlan,
  validatePlanSet
} from "../../../../lib/planning/economics.js";
import { resolvePlanningContext } from "../../../../lib/planning/horizon.js";
import { compareRequirementSnapshots } from "../../../../lib/catalog/compare.js";
import { validateStudentPrerequisites } from "../../../../lib/planning/prerequisiteValidation.js";

export const runtime = "nodejs";

function jsonResponse(payload, status = 200) {
  return Response.json(payload, { status });
}

function resolveEconomicsCatalog(requestedCatalogYear, catalogYears) {
  const resolution = resolveCatalogYear(requestedCatalogYear, catalogYears);
  if (resolution.catalogResolutionStatus !== "unavailable" || !catalogYears.includes("2025-2026")) {
    return resolution;
  }
  return {
    requestedCatalogYear,
    selectedCatalogYear: "2025-2026",
    catalogResolutionStatus: "economics_provisional_fallback"
  };
}

function sortResults(results) {
  const riskRank = {
    FEASIBLE: 0,
    FEASIBLE_WITH_ASSUMPTIONS: 1,
    TIGHT: 2,
    HIGH_RISK: 3,
    NOT_CURRENTLY_FEASIBLE: 4,
    INSUFFICIENT_INFORMATION: 5
  };

  return [...results].sort((a, b) => {
    const riskCompare = (riskRank[a.risk.class] ?? 99) - (riskRank[b.risk.class] ?? 99);
    if (riskCompare) return riskCompare;
    const aRemaining = a.optimistic.remainingUnits ?? Number.POSITIVE_INFINITY;
    const bRemaining = b.optimistic.remainingUnits ?? Number.POSITIVE_INFINITY;
    return aRemaining - bRemaining || String(a.program.name).localeCompare(String(b.program.name));
  });
}

function catalogAdvisorAttention(resolution, catalogReview, planningContext) {
  const notices = [];
  if (resolution.catalogResolutionStatus === "previous_year_fallback") {
    notices.push({
      code: "CATALOG_PREVIOUS_YEAR_FALLBACK",
      title: "Advisor Attention",
      severity: "warning",
      message: `The ${resolution.requestedCatalogYear.replace("-", "/")} Economics catalog was unavailable, so EconMapper used the approved ${resolution.selectedCatalogYear.replace("-", "/")} requirements as a temporary fallback. Confirm the applicable requirements with the Economics Department before relying on this plan.`
    });
  }
  if (resolution.catalogResolutionStatus === "economics_provisional_fallback") {
    notices.push({
      code: "ECONOMICS_PROVISIONAL_CATALOG_FALLBACK",
      title: "Advisor Attention",
      severity: "warning",
      message: `The ${resolution.requestedCatalogYear.replace("-", "/")} entry catalog is unavailable. EconMapper used the approved 2025/2026 Economics requirements provisionally so graduation planning can continue. An advisor must confirm the student's governing Economics requirements; this fallback does not apply to any other major.`
    });
  }

  if (catalogReview.comparisonStatus === "unavailable" && planningContext.catalogComparisonApplicable) {
    notices.push({
      code: "COMPARISON_CATALOG_UNAVAILABLE",
      title: "Newer catalog could not be checked",
      severity: "warning",
      message: `The ${planningContext.declarationCatalogYear.replace("-", "/")} Economics catalog is not available locally for comparison. This plan continues to use ${resolution.selectedCatalogYear.replace("-", "/")}.`
    });
  }
  if (catalogReview.comparisonStatus === "more_flexible") {
    notices.push({
      code: "COMPARISON_CATALOG_MORE_FLEXIBLE",
      title: "Newer catalog available for review",
      severity: "info",
      message: `The ${planningContext.declarationCatalogYear.replace("-", "/")} Economics catalog appears more flexible. This plan still uses ${resolution.selectedCatalogYear.replace("-", "/")}; review the newer requirements with the department before changing the governing catalog.`,
      findings: catalogReview.comparisonFindings
    });
  }
  if (catalogReview.comparisonStatus === "changed_review") {
    notices.push({
      code: "COMPARISON_CATALOG_CHANGED",
      title: "Catalog requirements changed",
      severity: "warning",
      message: `The ${planningContext.declarationCatalogYear.replace("-", "/")} Economics catalog contains both favorable and unfavorable changes. This plan uses ${resolution.selectedCatalogYear.replace("-", "/")}; advisor review is recommended.`,
      findings: catalogReview.comparisonFindings
    });
  }
  return notices;
}

function electiveAdvisorAttention(results) {
  const economics = results.find(result => result.program?.id === "economics-base");
  const assignedCourses = assigned100LevelElectives(economics);
  if (!assignedCourses.length) return [];

  return [{
    code: "ONE_HUNDRED_LEVEL_ELECTIVE_USED",
    title: "100-level elective limit",
    severity: "info",
    message: `${assignedCourses[0]} is being used as the one permitted 100-level Economics elective. The other three Economics electives must be at the 200 level or above.`
  }];
}

function prerequisiteAdvisorAttention(validation) {
  return validation.conditionalApprovals.map(item => ({
    code: `${item.code}_${item.course.replace(/\s/g, "_")}_${item.prerequisite.replace(/\s/g, "_")}`,
    title: "Concurrent enrollment approval",
    severity: "warning",
    message: item.message
  }));
}

function planAdvisorAttention(results) {
  const economics = results.find(result => result.program?.id === "economics-base");
  const notices = (economics?.economicsPlans || []).flatMap(plan => [
    ...(plan.advisorChecks || [])
      .filter(check => /Concurrent enrollment requires approval/i.test(check.reason || ""))
      .map(check => ({
        code: `PLAN_CHECK_${plan.id}_${check.course.replace(/\s/g, "_")}`,
        title: "Graduation plan advisor review",
        severity: "warning",
        message: check.reason
      })),
    ...(plan.validation?.warnings || []).map((message, index) => ({
      code: `PLAN_WARNING_${plan.id}_${index}`,
      title: "Graduation planning assumption",
      severity: "warning",
      message
    }))
  ]);
  return [...new Map(notices.map(notice => [notice.message, notice])).values()];
}

function mapCatalogPrograms(catalog, student, catalogReview, { economicsOnly = false } = {}) {
  return catalog.variants.filter(variant => !economicsOnly || variant.programId === "economics").map(variant => {
    const program = catalog.programs.find(item => item.id === variant.programId) || {
      id: variant.programId,
      name: variant.label,
      sourceStatus: "DRAFT_REVIEW_REQUIRED"
    };
    const mapping = mapStudentToProgram({ ...program, ...variant }, catalog.requirementsByProgram.get(program.id), student);
    if (mapping.risk.class === "INSUFFICIENT_INFORMATION") return mapping;

    const feasibility = analyzeFeasibility({
      student,
      mapping,
      prerequisites: catalog.prerequisitesByProgram.get(program.id)
    });
    const riskReasons = [...new Set([...mapping.risk.reasons, ...feasibility.riskReasons])];
    const economicsPlanBundle = variant.programId === "economics"
      ? buildEconomicsTermPlans({
          student,
          mapping,
          schedule: catalog.economicsSchedule,
          prerequisites: catalog.prerequisitesByProgram.get(program.id),
          courseCatalog: catalog.economicsCourses
        })
      : null;
    const economicsPlanningGaps = economicsPlanBundle?.planningGaps || [];
    const combinedRiskReasons = [
      ...riskReasons,
      ...economicsPlanningGaps.map(gap => gap.message || gap.reason).filter(Boolean)
    ];
    const riskClass = economicsPlanBundle && !economicsPlanBundle.plans.length
      ? "NOT_CURRENTLY_FEASIBLE"
      : combinedRiskReasons.length
        ? "FEASIBLE_WITH_ASSUMPTIONS"
        : mapping.risk.class;

    return {
      ...mapping,
      annualSchedule: (program.id === "economics" || variant.programId === "economics") && catalog.economicsSchedule?.academicYear === "2026-2027"
        ? catalog.economicsSchedule
        : null,
      missingPrerequisites: feasibility.missingPrerequisites,
      minimumRegularTerms: feasibility.minimumRegularTerms,
      risk: {
        class: riskClass,
        reasons: [...new Set(combinedRiskReasons)]
      },
      economicsPlan: economicsPlanBundle?.plans?.[0] || null,
      economicsPlans: economicsPlanBundle?.plans || [],
      economicsPlanningGaps,
      economicsPlanValidation: economicsPlanBundle?.planSetValidation || null,
      planningContext: economicsPlanBundle?.context || null,
      economicsCandidateOutcomes: economicsPlanBundle?.candidateOutcomes || [],
      economicsPlanConvergences: economicsPlanBundle?.convergences || [],
      earlyGraduationContext: economicsPlanBundle?.earlyGraduationContext || null,
      catalogReview: variant.programId === "economics" ? catalogReview : null
    };
  });
}

function validateEditedEconomicsPlan({ catalog, student, planningContext, plan, plans }) {
  const variant = catalog.variants.find(item => item.programId === "economics");
  const program = catalog.programs.find(item => item.id === variant?.programId);
  if (!variant || !program) {
    return { error: "The approved Economics program could not be loaded for plan validation." };
  }

  const mapping = mapStudentToProgram(
    { ...program, ...variant },
    catalog.requirementsByProgram.get(program.id),
    student
  );
  const validation = validateGeneratedPlan(plan, {
    student,
    mapping,
    schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get(program.id),
    context: planningContext
  });
  const validatedPlan = { ...plan, validation };
  validatedPlan.feasibilityStatus = classifyFeasibility(validatedPlan, student);
  validatedPlan.verification = {
    ...(validatedPlan.verification || {}),
    status: validatedPlan.feasibilityStatus
  };
  const candidatePlans = Array.isArray(plans)
    ? plans.map(item => item.id === validatedPlan.id ? validatedPlan : item)
    : [validatedPlan];

  return {
    plan: validatedPlan,
    planSetValidation: validatePlanSet(candidatePlans)
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const student = body?.student || {};
    const planningContext = resolvePlanningContext(student);
    if (!student.planCreationDate) {
      return jsonResponse({ error: "Plan creation date is required before mapping majors.", planningContext }, 400);
    }
    if (planningContext.isTransferStudent && !planningContext.transferValidation.valid) {
      return jsonResponse({
        error: planningContext.transferValidation.errors[0],
        code: "INVALID_TRANSFER_PLANNING_INPUT",
        planningContext
      }, 422);
    }
    const catalogYears = await availableCatalogYears();
    const requestedCatalogYear = planningContext.entryCatalogYear;

    if (!requestedCatalogYear) {
      return jsonResponse({ error: "The entry catalog year could not be inferred from the student standing and plan date.", availableCatalogYears: catalogYears }, 400);
    }
    const catalogResolution = resolveEconomicsCatalog(requestedCatalogYear, catalogYears);
    if (catalogResolution.catalogResolutionStatus === "unavailable") {
      return jsonResponse({
        error: `Entry catalog year ${requestedCatalogYear} is unavailable, and no earlier approved Economics snapshot can be used.`,
        requestedCatalogYear,
        selectedCatalogYear: null,
        catalogResolutionStatus: "unavailable",
        availableCatalogYears: catalogYears
      }, 422);
    }

    let catalog;
    try {
      catalog = await loadCatalog(catalogResolution.selectedCatalogYear);
    } catch (error) {
      return jsonResponse({
        error: error.message,
        requestedCatalogYear,
        selectedCatalogYear: catalogResolution.selectedCatalogYear,
        catalogResolutionStatus: "unavailable",
        availableCatalogYears: catalogYears
      }, 422);
    }
    const prerequisiteValidation = validateStudentPrerequisites(
      student.courses || [],
      catalog.economicsPrerequisites
    );
    if (!prerequisiteValidation.valid) {
      return jsonResponse({
        error: "Correct the selected course prerequisites before generating a plan.",
        code: "INVALID_STUDENT_PREREQUISITES",
        prerequisiteIssues: prerequisiteValidation.issues
      }, 422);
    }

    if (body?.action === "validate-plan") {
      if (!body.plan?.id || !Array.isArray(body.plan?.terms)) {
        return jsonResponse({ error: "A generated Economics plan is required for validation." }, 400);
      }
      const editedPlanResult = validateEditedEconomicsPlan({
        catalog,
        student,
        planningContext,
        plan: body.plan,
        plans: body.plans
      });
      return editedPlanResult.error
        ? jsonResponse({ error: editedPlanResult.error }, 422)
        : jsonResponse(editedPlanResult);
    }
    let catalogReview = {
      selectedCatalogYear: catalogResolution.selectedCatalogYear,
      comparisonCatalogYear: planningContext.declarationCatalogYear,
      comparisonStatus: planningContext.catalogComparisonApplicable ? "unavailable" : "not_applicable",
      comparisonFindings: []
    };

    if (planningContext.catalogComparisonApplicable) {
      if (catalogYears.includes(planningContext.declarationCatalogYear)) {
        const declarationCatalog = await loadCatalog(planningContext.declarationCatalogYear);
        const comparison = compareRequirementSnapshots(
          catalog.economicsRequirements,
          declarationCatalog.economicsRequirements,
          catalog.economicsPrerequisites,
          declarationCatalog.economicsPrerequisites
        );
        catalogReview = {
          ...catalogReview,
          comparisonStatus: comparison.status,
          comparisonFindings: comparison.findings
        };
      }
    }

    const economicsOnly = catalogResolution.catalogResolutionStatus === "economics_provisional_fallback";
    const results = mapCatalogPrograms(catalog, student, catalogReview, { economicsOnly });
    const advisorAttention = [
      ...catalogAdvisorAttention(catalogResolution, catalogReview, planningContext),
      ...electiveAdvisorAttention(results),
      ...prerequisiteAdvisorAttention(prerequisiteValidation),
      ...planAdvisorAttention(results)
    ];

    return jsonResponse({
      catalog: {
        requestedCatalogYear,
        selectedCatalogYear: catalogResolution.selectedCatalogYear,
        catalogResolutionStatus: catalogResolution.catalogResolutionStatus,
        comparisonCatalogYear: planningContext.declarationCatalogYear,
        comparisonStatus: catalogReview.comparisonStatus,
        comparisonFindings: catalogReview.comparisonFindings,
        advisorAttention,
        evaluatedCatalogYears: [catalogResolution.selectedCatalogYear],
        basis: catalogResolution.catalogResolutionStatus === "exact"
          ? (planningContext.isTransferStudent
              ? "transfer_hanover_entry_academic_year"
              : "entry_catalog_year_inferred_from_standing_and_plan_date")
          : "previous_approved_catalog_fallback",
        uncertainty: advisorAttention.length ? advisorAttention.map(notice => notice.message).join(" ") : null,
        availableCatalogYears: catalogYears,
        scope: economicsOnly ? "economics_only_provisional" : "catalog_snapshot"
      },
      summary: {
        programCount: results.length,
        mappedProgramCount: results.filter(result => result.sourceStatus === "APPROVED_LOCAL_SOURCE").length,
        reviewRequiredProgramCount: results.filter(result => result.risk.class === "INSUFFICIENT_INFORMATION").length
      },
      programs: sortResults(results)
    });
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: "The major mapper could not read the request or catalog data." }, 500);
  }
}
