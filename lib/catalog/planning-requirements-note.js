import catalog2023 from "../../policy/catalogs/economics-2023-2024.json" with { type: "json" };
import catalog2024 from "../../policy/catalogs/economics-2024-2025.json" with { type: "json" };
import catalog2025 from "../../policy/catalogs/economics-2025-2026.json" with { type: "json" };
import { compareCatalogPolicyRecords } from "./compare.js";

const CATALOGS = new Map([catalog2023, catalog2024, catalog2025].map(record => [record.catalogYear, record]));

function relevantCatalogYear({ majorDeclarationCatalogYear, entryCatalogYear } = {}) {
  return /^\d{4}-\d{4}$/.test(majorDeclarationCatalogYear || "")
    ? majorDeclarationCatalogYear : entryCatalogYear;
}

export function replacesLegacyCatalogNotice(context) {
  const year = relevantCatalogYear(context);
  return year === "2025-2026" || year === "2026-2027" || CATALOGS.has(year);
}

export function planningRequirementsNote(context = {}) {
  const catalogYear = relevantCatalogYear(context);
  if (!catalogYear || catalogYear >= catalog2025.catalogYear) return null;
  const earlier = CATALOGS.get(catalogYear);
  if (!earlier) return null;

  const findings = compareCatalogPolicyRecords(earlier, catalog2025).findings;
  const addedOptions = [...new Set(findings
    .filter(item => ["STATISTICS", "MONEY_FINANCE"].includes(item.family) && item.direction === "MORE_FLEXIBLE")
    .flatMap(item => item.affected || []))].sort();
  const shortYear = catalogYear.replace(/-20/, "–");
  const details = [];
  if (addedOptions.length) {
    const courses = addedOptions.length === 1 ? addedOptions[0] : addedOptions.join(" or ");
    details.push(`Your ${shortYear} catalog does not count ${courses} toward the major. If your plan uses ${addedOptions.length === 1 ? "it" : "either"}, your advisor will help you file a routine SAC petition.`);
  }
  if (findings.some(item => item.code === "ECONOMICS_COMPREHENSIVE_EVALUATION_CHANGED"
    && earlier.nonCourseMilestones.some(milestone => milestone.id === "ECONOMICS-COMPREHENSIVE-EVALUATION" && milestone.status === "REQUIRED"))) {
    details.push(`Your ${shortYear} catalog also required an Economics comprehensive evaluation. The current requirements do not list it.`);
  }
  return {
    heading: "This plan uses the current (2026–27) Economics major requirements.",
    details
  };
}
