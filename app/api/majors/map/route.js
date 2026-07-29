import { availableCatalogYears, loadCatalog } from "../../../../lib/catalog/load.js";
import { mapStudentToProgram } from "../../../../lib/assignment/solve.js";
import { analyzeFeasibility } from "../../../../lib/planning/feasibility.js";
import { buildEconomicsTermPlans } from "../../../../lib/planning/economics.js";
import { resolvePlanningContext } from "../../../../lib/planning/horizon.js";
import { compareRequirementSnapshots } from "../../../../lib/catalog/compare.js";

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

function mapCatalogPrograms(catalog, student, catalogReview) {
  return catalog.variants.map(variant => {
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
          prerequisites: catalog.prerequisitesByProgram.get(program.id)
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
        class: riskReasons.length ? "FEASIBLE_WITH_ASSUMPTIONS" : mapping.risk.class,
        reasons: riskReasons
      },
      economicsPlan: economicsPlanBundle?.plans?.[0] || null,
      economicsPlans: economicsPlanBundle?.plans || [],
      planningContext: economicsPlanBundle?.context || null,
      catalogReview: variant.programId === "economics" ? catalogReview : null
    };
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const student = body?.student || {};
    const planningContext = resolvePlanningContext(student);
    if (!student.planCreationDate) {
      return jsonResponse({ error: "Plan creation date is required before mapping majors.", planningContext }, 400);
    }
    if (student.planCreationDate && planningContext.requiresSummerClarification) {
      return jsonResponse({
        error: planningContext.question,
        requiresSummerClarification: true,
        planningContext
      }, 409);
    }
    const catalogYears = await availableCatalogYears();
    const requestedCatalogYear = planningContext.entryCatalogYear;

    if (!requestedCatalogYear) {
      return jsonResponse({ error: "The entry catalog year could not be inferred from the student standing and plan date.", availableCatalogYears: catalogYears }, 400);
    }
    if (!catalogYears.includes(requestedCatalogYear)) {
      return jsonResponse({
        error: `Entry catalog year ${requestedCatalogYear} is not available in the approved local data.`,
        entryCatalogYear: requestedCatalogYear,
        availableCatalogYears: catalogYears
      }, 422);
    }

    const catalog = await loadCatalog(requestedCatalogYear);
    let catalogReview = {
      selectedCatalogYear: requestedCatalogYear,
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

    const results = mapCatalogPrograms(catalog, student, catalogReview);

    return jsonResponse({
      catalog: {
        selectedCatalogYear: requestedCatalogYear,
        comparisonCatalogYear: planningContext.declarationCatalogYear,
        comparisonStatus: catalogReview.comparisonStatus,
        comparisonFindings: catalogReview.comparisonFindings,
        evaluatedCatalogYears: [requestedCatalogYear],
        basis: "entry_catalog_year_inferred_from_standing_and_plan_date",
        uncertainty: catalogReview.comparisonStatus === "unavailable" ? "The declaration/current catalog is not available locally for comparison; the plan uses the entry catalog." : null,
        availableCatalogYears: catalogYears
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
