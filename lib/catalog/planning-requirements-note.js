import messages from "../../policy/messages/en-US.json" with { type: "json" };
import { displayMessage } from "../planning/student-language.js";
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
    const pronoun = usedOptions.length === 1 ? "it" : plan ? "them" : "either";
    details.push(displayMessage(messages.messages, plan ? "catalog.petitionPlanCounts" : "catalog.petitionPlanMayUse", { courses, shortYear, pronoun }));
  }
  if (findings.some(item => item.code === "ECONOMICS_COMPREHENSIVE_EVALUATION_CHANGED"
    && earlier.nonCourseMilestones.some(milestone => milestone.id === "ECONOMICS-COMPREHENSIVE-EVALUATION" && milestone.status === "REQUIRED"))) {
    details.push(displayMessage(messages.messages, "catalog.comprehensiveEvaluation", { shortYear }));
  }
  return {
    heading: "This plan uses the current Economics major requirements.",
    details
  };
}
