import { availableCatalogYears, loadCatalog } from "../../../../lib/catalog/load.js";
import { mapStudentToProgram } from "../../../../lib/assignment/solve.js";
import { analyzeFeasibility } from "../../../../lib/planning/feasibility.js";
import { buildEconomicsTermPlan } from "../../../../lib/planning/economics.js";

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

function mapCatalogPrograms(catalog, student) {
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
      economicsPlan: variant.programId === "economics"
        ? buildEconomicsTermPlan({
            student,
            mapping,
            schedule: catalog.economicsSchedule,
            prerequisites: catalog.prerequisitesByProgram.get(program.id)
          })
        : null
    };
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const student = body?.student || {};
    const catalogYears = await availableCatalogYears();
    const requestedCatalogYear = String(student.majorDeclarationCatalogYear || student.entryCatalogYear || "").trim();

    if (!requestedCatalogYear) {
      return jsonResponse({ error: "Entry catalog year is required before mapping majors.", availableCatalogYears: catalogYears }, 400);
    }
    if (!catalogYears.includes(requestedCatalogYear)) {
      return jsonResponse({ error: `Catalog year ${requestedCatalogYear} is not available in the approved local data.`, availableCatalogYears: catalogYears }, 422);
    }

    const evaluationYears = student.majorDeclarationCatalogYear
      ? [requestedCatalogYear]
      : catalogYears;
    const evaluations = await Promise.all(evaluationYears.map(async catalogYear => {
      const catalog = await loadCatalog(catalogYear);
      return mapCatalogPrograms(catalog, student);
    }));
    const results = evaluations.flat();

    return jsonResponse({
      catalog: {
        selectedCatalogYear: requestedCatalogYear,
        evaluatedCatalogYears: evaluationYears,
        basis: student.majorDeclarationCatalogYear ? "major_declaration_catalog_year" : "entry_catalog_year_with_declaration_year_uncertain",
        uncertainty: student.majorDeclarationCatalogYear ? null : "Major-declaration catalog year was not supplied; all available local catalog versions were evaluated.",
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
