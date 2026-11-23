import { availableCatalogYears, loadCatalog } from "../../../../lib/catalog/load.js";
import { mapStudentToProgram } from "../../../../lib/assignment/solve.js";
import { analyzeFeasibility } from "../../../../lib/planning/feasibility.js";
import {
  buildFeasibilityDetails,
  buildEconomicsTermPlans,
  classifyFeasibility,
  annotateEconomicsPlanChoices,
  FEASIBILITY_STATUS,
  SEARCH_INCOMPLETE_MESSAGE,
  validateGeneratedPlan,
  validatePlanSet
} from "../../../../lib/planning/economics.js";
import { validatePlanningInputs, validateStudentCourseHistoryLimit, normalizeScheduleSetByTerm, resolvePlanningContext, selectedPlanContext } from "../../../../lib/planning/horizon.js";
import { applyEconomicsPlanEdit } from "../../../../lib/planning/termSolver.js";
import { buildAcceleratedPlanningResult } from "../../../../lib/planning/acceleratedResult.js";
import { buildEconomicsPlanResult } from "../../../../lib/planning/noPlanResult.js";
import { CATALOG_APPLICABILITY_STATUS, resolveCatalogApplicability } from "../../../../lib/catalog/applicability.js";
import { resolveInputResolution, validateSubmittedCatalogYear } from "../../../../lib/catalog/input-resolution.js";
import { validateStudentPrerequisites } from "../../../../lib/planning/prerequisiteValidation.js";
import { studentFacingPlanReviewMessage } from "../../../../lib/planning/plan-presentation.js";
import { buildPrerequisiteStatusNotices } from "../../../../lib/planning/prerequisiteEvaluator.js";
import { annotatePreliminaryScheduleEvidence } from "../../../../lib/policy/preliminary-schedule.js";
import { loadPlannerFingerprint } from "../../../../lib/planning/fingerprint.js";
import { compactEconomicsPlanForValidation } from "../../../../lib/planning/validation-payload.js";
import { studentDisplayMessages } from "../../../../lib/planning/student-language.js";

export const runtime = "nodejs";

async function jsonResponse(payload, status = 200, policyBundle = null) {
  if (payload.programs || payload.economicsPlanResult?.category === "INPUT_BLOCKED") {
    let plannerFingerprint = null;
    try {
      plannerFingerprint = await loadPlannerFingerprint(policyBundle);
    } catch {
      // Missing freshness evidence must prevent restoration, not hide input errors.
    }
    payload = { ...payload, plannerFingerprint };
  }
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    return Response.json({ plannerFingerprint: await loadPlannerFingerprint() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Current planning policy could not be verified." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
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

function prerequisiteAdvisorAttention(validation, student, policyBundle) {
  // Existing enrollment is course history, not a proposed concurrent placement.
  // Keep its validation evidence; do not present it as a new registration task.
  const takingNow = new Set((student.courses || []).filter(course => course.status === "in_progress").map(course => course.code));
  const approvals = validation.conditionalApprovals
    .filter(item => !(takingNow.has(item.course) && takingNow.has(item.prerequisite)))
    .map(item => ({
    code: `${item.code}_${item.course.replace(/\s/g, "_")}_${item.prerequisite.replace(/\s/g, "_")}`,
    title: "Concurrent enrollment approval",
    severity: "warning",
    message: item.message
  }));
  const apOrTransfer = new Set((student.courses || []).filter(course => course.status === "transfer"
    || course.source === "ap_credit" || /transfer/i.test(course.source || "")).map(course => course.code));
  const reviews = (validation.reviewFindings || []).filter(finding => !apOrTransfer.has(finding.subject?.course)).map((finding, index) => ({
    code: `HISTORY_REVIEW_${finding.subject?.course?.replace(/\s/g, "_") || index}`,
    title: `${finding.subject?.course || "Course history"} prerequisite check`,
    severity: "warning",
    message: studentFacingPlanReviewMessage(finding, { student, policyBundle })
      || `${finding.subject?.course || "A recorded class"} needs an advisor to check whether its prerequisites were met.`
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
  planningContext = null,
  catalogApplicability = null,
  inputResolution = null
} = {}) {
  return catalog.variants.filter(variant => variant.programId === "economics").map(variant => {
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
    let riskClass = economicsPlanBundle && !economicsPlanBundle.plans.length
      ? economicsSearchIncomplete ? "FEASIBLE_WITH_ASSUMPTIONS" : "NOT_CURRENTLY_FEASIBLE"
      : combinedRiskReasons.length
        ? "FEASIBLE_WITH_ASSUMPTIONS"
        : mapping.risk.class;
    const economicsPlanResult = economicsPlanBundle
      ? buildEconomicsPlanResult({
          student,
          plans: economicsPlanBundle.plans,
          mapping,
          planningContext: economicsPlanBundle.context,
          policyBundle: catalog.policyBundle,
          inputResolution,
          candidateOutcomes: economicsPlanBundle.candidateOutcomes,
          planningGaps: economicsPlanBundle.planningGaps,
          metricsDiagnostics: economicsPlanBundle.metricsDiagnostics
        })
      : null;
    if (economicsPlanResult?.conclusion === "UNKNOWN" && !economicsPlanBundle.plans.length) riskClass = "FEASIBLE_WITH_ASSUMPTIONS";
    const economicsAcceleratedResult = economicsPlanBundle
      ? buildAcceleratedPlanningResult({
          planningContext: economicsPlanBundle.context,
          earlyGraduationContext: economicsPlanBundle.earlyGraduationContext,
          mapping, student, policyBundle: catalog.policyBundle,
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

function validateEditedEconomicsPlan({ catalog, student, planningContext, plan, plans, edit }) {
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
  const context = selectedPlanContext(planningContext, plan);
  if (!context) return { error: "That plan strategy is no longer eligible. Regenerate your plans." };
  const validationOptions = {
    student,
    mapping,
    schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get(program.id),
    context,
    policyBundle: catalog.policyBundle,
    enforcePlanIntegrity: true
  };
  const validatedPeers = (Array.isArray(plans) ? plans : [])
    .filter(item => item.id !== plan.id)
    .map(peer => {
      const peerContext = selectedPlanContext(planningContext, peer);
      if (!peerContext) return { ...peer, validation: { valid: false, errors: ["The comparison plan is no longer eligible."] } };
      return {
        ...peer,
        planningContext: peerContext,
        validation: validateGeneratedPlan(peer, { ...validationOptions, context: peerContext })
      };
    });
  if (validatedPeers.some(peer => !peer.validation?.valid)) {
    return { error: "A comparison plan no longer passes validation. Regenerate your plans." };
  }
  if (edit) {
    const originalValidation = validateGeneratedPlan(plan, validationOptions);
    if (!originalValidation.valid) return { error: "The original plan no longer passes validation. Regenerate your plans." };
    try {
      plan = applyEconomicsPlanEdit({ plan, edit, student, mapping,
        schedule: catalog.economicsSchedule, prerequisites: catalog.prerequisitesByProgram.get(program.id),
        courseCatalog: catalog.economicsCourses, policyBundle: catalog.policyBundle });
    } catch (error) {
      return { error: error.message };
    }
  }
  const validation = validateGeneratedPlan(plan, validationOptions);
  const validatedPlan = {
    ...plan,
    planningContext: context,
    validation,
    warnings: validation.warnings,
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
  annotatePreliminaryScheduleEvidence(validatedPlan, catalog.policyBundle);
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
    ? plans.map(item => item.id === validatedPlan.id
      ? validatedPlan
      : validatedPeers.find(peer => peer.id === item.id))
    : [validatedPlan];

  const choicesUpdatedPlans = annotateEconomicsPlanChoices({
    plans: candidatePlans,
    annotatePlanIds: [validatedPlan.id],
    student,
    mapping,
    schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get(program.id),
    courseCatalog: catalog.economicsCourses,
    context: planningContext,
    policyBundle: catalog.policyBundle
  });
  const choiceUpdatedPlan = choicesUpdatedPlans.find(item => item.id === validatedPlan.id) || validatedPlan;
  return {
    plan: choiceUpdatedPlan,
    planSetValidation: validatePlanSet(choicesUpdatedPlans)
  };
}

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return jsonResponse({ error: "The request contains invalid JSON. Please try again." }, 400);
      }
      throw error;
    }
    const submittedStudent = body?.student || {};
    if (submittedStudent.courses !== undefined && (
      !Array.isArray(submittedStudent.courses) ||
      submittedStudent.courses.some(course => !course || typeof course !== "object" || Array.isArray(course))
    )) {
      return jsonResponse({
        error: "Courses must be a list of course records. Each course must be an object, not an empty value or text.",
        code: "INVALID_COURSE_INPUT"
      }, 400);
    }
    const courseHistoryLimit = validateStudentCourseHistoryLimit(submittedStudent);
    if (!courseHistoryLimit.valid) {
      return jsonResponse({
        error: courseHistoryLimit.issue.message,
        code: courseHistoryLimit.issue.code,
        field: courseHistoryLimit.issue.field,
        count: courseHistoryLimit.count,
        limit: courseHistoryLimit.limit
      }, 413);
    }
    const inputValidation = validatePlanningInputs(submittedStudent, { requireDate: true });
    if (!inputValidation.valid) {
      const missingDate = inputValidation.issues[0].code === "MISSING_PLAN_CREATION_DATE";
      const code = missingDate ? "MISSING_PLAN_CREATION_DATE" : "INVALID_PLANNING_INPUT";
      const inputResolution = resolveInputResolution({ issueCode: code, issues: inputValidation.issues });
      return jsonResponse({
        error: inputValidation.issues[0].message, code, issues: inputValidation.issues,
        inputResolution, economicsPlanResult: buildEconomicsPlanResult({ inputResolution })
      }, missingDate ? 400 : 422);
    }
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
        plan: compactEconomicsPlanForValidation(body.plan),
        plans: Array.isArray(body.plans) ? body.plans.map(compactEconomicsPlanForValidation) : body.plans,
        edit: body.edit
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
    const results = mapCatalogPrograms(catalog, student, catalogReview, {
      planningContext: authoritativePlanningContext,
      catalogApplicability,
      inputResolution
    });
    const advisorAttention = [
      ...catalogAdvisorAttention(authoritativePlanningContext),
      ...results.flatMap(result => result.advisorNotifications || []),
      ...prerequisiteAdvisorAttention(prerequisiteValidation, student, catalog.policyBundle),
      ...planAdvisorAttention(results)
    ];

    return jsonResponse({
      policyMessages: studentDisplayMessages(catalog.policyBundle),
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
        scope: requestedCatalogYear !== catalogApplicability.appliedMajorCatalogYear
          ? "economics_only_provisional" : "catalog_snapshot"
      },
      inputResolution,
      summary: {
        programCount: results.length,
        mappedProgramCount: results.filter(result => ["APPROVED_LOCAL_SOURCE", "AUTHORITATIVE_PUBLISHED"].includes(result.sourceStatus)).length,
        reviewRequiredProgramCount: results.filter(result => result.risk.class === "INSUFFICIENT_INFORMATION").length
      },
      programs: sortResults(results)
    }, 200, catalog.policyBundle);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: "The major mapper could not read the request or catalog data." }, 500);
  }
}
