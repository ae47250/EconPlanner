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

export function planningRequirementsNote(context = {}, plan = null) {
  const catalogYear = relevantCatalogYear(context);
  if (!catalogYear || catalogYear >= catalog2025.catalogYear) return null;
  const earlier = CATALOGS.get(catalogYear);
  if (!earlier) return null;

  const findings = compareCatalogPolicyRecords(earlier, catalog2025).findings;
  const addedOptions = [...new Set(findings
    .filter(item => ["STATISTICS", "MONEY_FINANCE"].includes(item.family) && item.direction === "MORE_FLEXIBLE")
    .flatMap(item => item.affected || []))].sort();
  const counted = new Set((plan?.validation?.requirementAllocation?.assignments || []).map(item => item.code));
  const usedOptions = plan ? addedOptions.filter(code => counted.has(code)) : addedOptions;
  const shortYear = catalogYear.replace(/-20/, "–");
  const details = [];
  if (usedOptions.length) {
    const courses = usedOptions.length === 1 ? usedOptions[0] : usedOptions.join(plan ? " and " : " or ");
    const pronoun = usedOptions.length === 1 ? "it" : plan ? "they" : "either";
    details.push(plan
      ? `Your plan counts ${courses}, which your ${shortYear} catalog does not accept. Ask your advisor to help you file a routine petition with the Student Academic Assistance Committee (forms are at the Registrar's Office) so ${usedOptions.length === 1 ? "it counts" : "they count"}.`
      : `Your ${shortYear} catalog does not count ${courses} toward the major. If your plan uses ${pronoun}, ask your advisor to help you file a routine petition with the Student Academic Assistance Committee (forms are at the Registrar's Office) so ${usedOptions.length === 1 ? "it counts" : "the course counts"}.`);
  }
  if (findings.some(item => item.code === "ECONOMICS_COMPREHENSIVE_EVALUATION_CHANGED"
    && earlier.nonCourseMilestones.some(milestone => milestone.id === "ECONOMICS-COMPREHENSIVE-EVALUATION" && milestone.status === "REQUIRED"))) {
    details.push(`Your ${shortYear} catalog also required a comprehensive evaluation in Economics. Ask your advisor whether you still need to take it.`);
  }
  return {
    heading: `This plan uses the current (${String(catalog2025.catalogYear).replace(/-20/, "–")}) Economics major requirements.`,
    details
  };
}
