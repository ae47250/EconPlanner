import { availableCatalogYears, loadCatalog } from "../../../../lib/catalog/load.js";
import { mapStudentToProgram } from "../../../../lib/assignment/solve.js";
import { analyzeFeasibility } from "../../../../lib/planning/feasibility.js";
import {
  assigned100LevelElectives,
  buildFeasibilityDetails,
  buildEconomicsTermPlans,
  classifyFeasibility,
  FEASIBILITY_STATUS,
  SEARCH_INCOMPLETE_MESSAGE,
  validateGeneratedPlan,
  validatePlanSet
} from "../../../../lib/planning/economics.js";
import { normalizeScheduleSetByTerm, resolvePlanningContext } from "../../../../lib/planning/horizon.js";
import { buildAcceleratedPlanningResult } from "../../../../lib/planning/acceleratedResult.js";
import { buildEconomicsPlanResult } from "../../../../lib/planning/noPlanResult.js";
import { CATALOG_APPLICABILITY_STATUS, resolveCatalogApplicability } from "../../../../lib/catalog/applicability.js";
import { resolveInputResolution, validateSubmittedCatalogYear } from "../../../../lib/catalog/input-resolution.js";
import { validateStudentPrerequisites } from "../../../../lib/planning/prerequisiteValidation.js";
import { buildPrerequisiteStatusNotices } from "../../../../lib/planning/prerequisiteEvaluator.js";

export const runtime = "nodejs";

function jsonResponse(payload, status = 200) {
  return Response.json(payload, { status });
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

function catalogAdvisorAttention(planningContext) {
  const applicability = planningContext.catalogApplicability;
  return (applicability?.advisorNotifications || []).map(notice => ({
    ...notice,
    findings: notice.materialDifferences || [],
    advisorNotice: notice
  }));
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
  const approvals = validation.conditionalApprovals.map(item => ({
    code: `${item.code}_${item.course.replace(/\s/g, "_")}_${item.prerequisite.replace(/\s/g, "_")}`,
    title: "Concurrent enrollment approval",
    severity: "warning",
    message: item.message
  }));
  const reviews = (validation.reviewFindings || []).map((finding, index) => ({
    code: `HISTORY_REVIEW_${finding.subject?.course?.replace(/\s/g, "_") || index}`,
    title: "Academic history review",
    severity: "warning",
    message: `${finding.subject?.course || "A recorded course"} is retained, but its historical prerequisite or transfer evidence requires advisor review.`
  }));
  return [...approvals, ...reviews];
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

function mapCatalogPrograms(catalog, student, catalogReview, {
  economicsOnly = false,
  planningContext = null,
  catalogApplicability = null,
  inputResolution = null
} = {}) {
  return catalog.variants.filter(variant => !economicsOnly || variant.programId === "economics").map(variant => {
    const program = catalog.programs.find(item => item.id === variant.programId) || {
      id: variant.programId,
      name: variant.label,
      sourceStatus: "DRAFT_REVIEW_REQUIRED"
    };
    const mapping = mapStudentToProgram(
      { ...program, ...variant, catalogYear: catalog.catalogYear },
      catalog.requirementsByProgram.get(program.id),
      student,
      { policyBundle: catalog.policyBundle, catalogApplicability }
    );
    if (mapping.risk.class === "INSUFFICIENT_INFORMATION") return mapping;

    const feasibility = analyzeFeasibility({
      student,
      mapping,
      prerequisites: catalog.prerequisitesByProgram.get(program.id),
      policyBundle: catalog.policyBundle
    });
    const riskReasons = [...new Set([...mapping.risk.reasons, ...feasibility.riskReasons])];
    const economicsPlanBundle = variant.programId === "economics"
      ? buildEconomicsTermPlans({
          student,
          mapping,
          schedule: catalog.economicsSchedule,
          prerequisites: catalog.prerequisitesByProgram.get(program.id),
          courseCatalog: catalog.economicsCourses,
          policyBundle: catalog.policyBundle,
          planningContext,
          catalogApplicability,
          collectDiagnostics: true
        })
      : null;
    const economicsPlanningGaps = economicsPlanBundle?.planningGaps || [];
    const economicsSearchIncomplete = economicsPlanBundle?.candidateOutcomes?.some(item => (
      item.status === FEASIBILITY_STATUS.SEARCH_INCOMPLETE
    ));
    const combinedRiskReasons = [
      ...riskReasons,
      ...economicsPlanningGaps.map(gap => gap.message || gap.reason).filter(Boolean),
      ...(economicsSearchIncomplete ? [SEARCH_INCOMPLETE_MESSAGE] : [])
    ];
    const riskClass = economicsPlanBundle && !economicsPlanBundle.plans.length
      ? economicsSearchIncomplete ? "FEASIBLE_WITH_ASSUMPTIONS" : "NOT_CURRENTLY_FEASIBLE"
      : combinedRiskReasons.length
        ? "FEASIBLE_WITH_ASSUMPTIONS"
        : mapping.risk.class;
    const economicsPlanResult = economicsPlanBundle
      ? buildEconomicsPlanResult({
          plans: economicsPlanBundle.plans,
          inputResolution,
          candidateOutcomes: economicsPlanBundle.candidateOutcomes,
          planningGaps: economicsPlanBundle.planningGaps,
          metricsDiagnostics: economicsPlanBundle.metricsDiagnostics
        })
      : null;
    const economicsAcceleratedResult = economicsPlanBundle
      ? buildAcceleratedPlanningResult({
          planningContext: economicsPlanBundle.context,
          earlyGraduationContext: economicsPlanBundle.earlyGraduationContext,
          candidateOutcomes: economicsPlanBundle.candidateOutcomes,
          metricsDiagnostics: economicsPlanBundle.metricsDiagnostics
        })
      : null;

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
      economicsPlanResult,
      economicsAcceleratedResult,
      earlyGraduationContext: economicsPlanBundle?.earlyGraduationContext || null,
      catalogApplicability,
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
    student,
    { policyBundle: catalog.policyBundle }
  );
  const validation = validateGeneratedPlan(plan, {
    student,
    mapping,
    schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get(program.id),
    context: planningContext,
    policyBundle: catalog.policyBundle,
    enforcePlanIntegrity: true
  });
  const validatedPlan = {
    ...plan,
    validation,
    readinessStatus: validation.readinessStatus,
    planDisposition: validation.planDisposition,
    advisorActionRequired: validation.advisorActionRequired,
    advisorActions: validation.advisorActions,
    conditions: validation.conditions,
    temporalSemantics: validation.temporalSemantics,
    catalogApplicability: validation.catalogApplicability,
    publicationStatus: validation.publicationStatus,
    notices: validation.notices,
    studentNotices: validation.studentNotices,
    advisorNotifications: validation.advisorNotifications,
    degreeRequirementInformation: validation.degreeRequirementInformation,
    distribution: validation.distribution.applicable
      ? {
          ...plan.distribution,
          actualYearCounts: validation.distribution.targetYearCounts.map((targetCount, yearIndex) => ({
            yearIndex,
            targetCount,
            actualCount: validation.distribution.actualYearCounts[yearIndex]
          }))
        }
      : plan.distribution
  };
  validatedPlan.prerequisiteNotices = buildPrerequisiteStatusNotices({
    plan: validatedPlan,
    student,
    prerequisites: catalog.prerequisitesByProgram.get(program.id)
  });
  validatedPlan.studentMessages = [...new Set([
    ...(validation.warnings || []),
    ...(validation.studentNotices || []).map(notice => notice.message),
    ...validatedPlan.prerequisiteNotices.map(notice => notice.message),
    ...(validatedPlan.advisorChecks || []).map(item => item.reason).filter(Boolean),
    ...(validatedPlan.terms || []).flatMap(term => (term.courses || []).map(course => course.studentHistoricalOfferingMessage).filter(Boolean))
  ])];
  validatedPlan.feasibilityStatus = classifyFeasibility(validatedPlan, student);
  validatedPlan.feasibility = buildFeasibilityDetails(
    validatedPlan,
    student,
    validatedPlan.feasibility?.search
  );
  validatedPlan.verification = {
    ...(validatedPlan.verification || {}),
    status: validatedPlan.feasibilityStatus,
    ...validatedPlan.feasibility.verification
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
    const submittedStudent = body?.student || {};
    const student = {
      ...submittedStudent,
      scheduleSetByTerm: normalizeScheduleSetByTerm(submittedStudent)
    };
    const catalogYears = await availableCatalogYears();
    const catalogValidation = validateSubmittedCatalogYear(student.majorDeclarationCatalogYear, catalogYears);
    const planningContext = resolvePlanningContext(student);
    if (!catalogValidation.valid) {
      const inputResolution = resolveInputResolution({
        student,
        planningContext,
        issueCode: "INVALID_CATALOG_INPUT",
        catalogValidation
      });
      return jsonResponse({
        error: "Choose an authoritative published Economics catalog year or select I do not know.",
        code: "INVALID_CATALOG_INPUT",
        submittedMajorDeclarationCatalogYear: catalogValidation.submittedValue,
        availableCatalogYears: catalogYears,
        planningContext,
        inputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, 422);
    }
    if (!student.planCreationDate) {
      const inputResolution = resolveInputResolution({student, planningContext, issueCode: "MISSING_PLAN_CREATION_DATE"});
      return jsonResponse({
        error: "Plan creation date is required before mapping majors.",
        planningContext,
        inputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, 400);
    }
    if (planningContext.isTransferStudent && !planningContext.transferValidation.valid) {
      const inputResolution = resolveInputResolution({student, planningContext, issueCode: "INVALID_TRANSFER_PLANNING_INPUT"});
      return jsonResponse({
        error: planningContext.transferValidation.errors[0],
        code: "INVALID_TRANSFER_PLANNING_INPUT",
        planningContext,
        inputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, 422);
    }
    if (planningContext.customGraduationEnabled && !planningContext.customGraduationValidation.valid) {
      const inputResolution = resolveInputResolution({student, planningContext, issueCode: "INVALID_CUSTOM_GRADUATION_INPUT"});
      return jsonResponse({
        error: planningContext.customGraduationValidation.errors[0],
        code: "INVALID_CUSTOM_GRADUATION_INPUT",
        planningContext,
        inputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, 422);
    }
    if (!planningContext.planningValidation.valid) {
      const inputResolution = resolveInputResolution({student, planningContext, issueCode: "INVALID_PLANNING_PACE"});
      return jsonResponse({
        error: planningContext.planningValidation.errors[0],
        code: "INVALID_PLANNING_PACE",
        planningContext,
        inputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, 422);
    }
    const catalogApplicability = resolveCatalogApplicability({
      majorDeclarationCatalogYear: planningContext.submittedMajorDeclarationCatalogYear,
      entryCatalogYear: planningContext.entryCatalogYear,
      currentCatalogYear: planningContext.currentCatalogYear,
      availableCatalogYears: catalogYears
    });
    const inputResolution = resolveInputResolution({student, planningContext, catalogApplicability});
    const requestedCatalogYear = planningContext.submittedMajorDeclarationCatalogYear || planningContext.entryCatalogYear;
    if (!catalogApplicability.appliedMajorCatalogYear) {
      return jsonResponse({
        error: "No authoritative published Economics catalog is available for conditional planning.",
        code: "CATALOG_UNAVAILABLE",
        requestedCatalogYear,
        selectedCatalogYear: null,
        catalogResolutionStatus: "unavailable",
        availableCatalogYears: catalogYears,
        catalogApplicability,
        inputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, 422);
    }
    const catalogResolution = {
      requestedCatalogYear,
      selectedCatalogYear: catalogApplicability.appliedMajorCatalogYear,
      catalogResolutionStatus: catalogApplicability.status === CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_MATCH
        ? "owner_designated_matches_incoming"
        : "owner_designated_flexible_requirements"
    };

    let catalog;
    try {
      catalog = await loadCatalog(catalogResolution.selectedCatalogYear);
    } catch (error) {
      return jsonResponse({
        error: error.message,
        requestedCatalogYear,
        selectedCatalogYear: catalogResolution.selectedCatalogYear,
        catalogResolutionStatus: "unavailable",
        availableCatalogYears: catalogYears,
        catalogApplicability,
        inputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, 422);
    }
    const authoritativePlanningContext = { ...planningContext, catalogApplicability };
    const prerequisiteValidation = validateStudentPrerequisites(
      student.courses || [],
      catalog.economicsPrerequisites,
      { policyBundle: catalog.policyBundle }
    );
    if (!prerequisiteValidation.valid) {
      const prerequisiteInputResolution = resolveInputResolution({
        student,
        planningContext: authoritativePlanningContext,
        catalogApplicability,
        issueCode: "INVALID_STUDENT_PREREQUISITES",
        issues: prerequisiteValidation.issues
      });
      return jsonResponse({
        error: "Correct the selected course prerequisites before generating a plan.",
        code: "INVALID_STUDENT_PREREQUISITES",
        prerequisiteIssues: prerequisiteValidation.issues,
        inputResolution: prerequisiteInputResolution,
        economicsPlanResult: buildEconomicsPlanResult({ inputResolution: prerequisiteInputResolution })
      }, 422);
    }

    if (body?.action === "validate-plan") {
      if (!body.plan?.id || !Array.isArray(body.plan?.terms)) {
        return jsonResponse({ error: "A generated Economics plan is required for validation." }, 400);
      }
      const editedPlanResult = validateEditedEconomicsPlan({
        catalog,
        student,
        planningContext: authoritativePlanningContext,
        plan: body.plan,
        plans: body.plans
      });
      if (editedPlanResult.error) {
        return jsonResponse({ error: editedPlanResult.error }, 422);
      }
      if (!editedPlanResult.plan.validation.valid) {
        return jsonResponse({
          error: `That plan change cannot be saved. ${editedPlanResult.plan.validation.errors[0] || "It violates the Economics planning rules."}`,
          code: "INVALID_PLAN_EDIT",
          validation: editedPlanResult.plan.validation
        }, 422);
      }
      if (!editedPlanResult.planSetValidation.valid) {
        return jsonResponse({
          error: `That plan change cannot be saved. ${editedPlanResult.planSetValidation.errors[0] || "The resulting plans are not a valid comparison."}`,
          code: "INVALID_PLAN_SET",
          planSetValidation: editedPlanResult.planSetValidation
        }, 422);
      }
      return jsonResponse(editedPlanResult);
    }
    const catalogReview = {
      selectedCatalogYear: catalogResolution.selectedCatalogYear,
      comparisonCatalogYear: catalogApplicability.originalCatalogYear,
      comparisonStatus: catalogApplicability.materialDifferences.length ? "more_flexible" : "no_change",
      comparisonFindings: catalogApplicability.materialDifferences,
      evaluations: catalogApplicability.evaluations
    };
    const economicsOnly = requestedCatalogYear !== catalogApplicability.appliedMajorCatalogYear;
    const results = mapCatalogPrograms(catalog, student, catalogReview, {
      economicsOnly,
      planningContext: authoritativePlanningContext,
      catalogApplicability,
      inputResolution
    });
    const advisorAttention = [
      ...catalogAdvisorAttention(authoritativePlanningContext),
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
        catalogApplicability,
        governingMajorCatalogYear: catalogApplicability.governingMajorCatalogYear,
        candidateCatalogYears: catalogApplicability.candidateCatalogYears,
        evaluatedCatalogYears: catalogApplicability.evaluatedCatalogYears,
        appliedMajorCatalogYear: catalogApplicability.appliedMajorCatalogYear,
        latestAvailableCatalogYear: catalogApplicability.latestAvailableCatalogYear,
        originalCatalogYear: catalogApplicability.originalCatalogYear,
        submittedDeclarationCatalogYear: catalogApplicability.submittedDeclarationCatalogYear,
        basis: planningContext.submittedMajorDeclarationCatalogYear
          ? (planningContext.majorDeclarationCatalogYearUnknown ? "major_declaration_catalog_year_unknown" : "major_declaration_catalog_year")
          : planningContext.isTransferStudent
            ? "transfer_hanover_entry_academic_year"
            : "entry_catalog_year_inferred_from_standing_and_plan_date",
        applicabilityBasis: catalogApplicability.basis,
        compatibilitySelectionBasis: catalogApplicability.basis,
        selectionAuthority: "OWNER_DESIGNATED_MOST_FLEXIBLE_ECONOMICS_MAJOR_REQUIREMENT_SET",
        uncertainty: advisorAttention.length ? advisorAttention.map(notice => notice.message).join(" ") : null,
        policyBundleVersion: catalog.policyBundleVersion,
        policyBundleHash: catalog.policyBundleHash,
        availableCatalogYears: catalogYears,
        scope: economicsOnly ? "economics_only_provisional" : "catalog_snapshot"
      },
      inputResolution,
      summary: {
        programCount: results.length,
        mappedProgramCount: results.filter(result => ["APPROVED_LOCAL_SOURCE", "AUTHORITATIVE_PUBLISHED"].includes(result.sourceStatus)).length,
        reviewRequiredProgramCount: results.filter(result => result.risk.class === "INSUFFICIENT_INFORMATION").length
      },
      programs: sortResults(results)
    });
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: "The major mapper could not read the request or catalog data." }, 500);
  }
}
