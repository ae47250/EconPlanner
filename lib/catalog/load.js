import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeEconomicsSchedule } from "../planning/scheduleProvider.js";
import { loadEconomicsPolicyCompatibility } from "../policy/compat-normalized.js";
import {
  availableCatalogPolicyYears,
  catalogPolicyRecords,
  catalogPolicyRecord,
  catalogRecordToPrerequisites,
  catalogRecordToRequirementSnapshot
} from "./policy-releases.js";

const root = process.cwd();

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return fallback;
  }
}

export async function availableCatalogYears() {
  const governedYears = availableCatalogPolicyYears();
  try {
    const entries = await readdir(path.join(root, "data/normalized/catalogs"), { withFileTypes: true });
    return [...new Set([...governedYears, ...entries.filter(entry => entry.isDirectory()).map(entry => entry.name)])].sort();
  } catch {
    return governedYears;
  }
}

export async function loadCatalog(catalogYear) {
  const catalogPolicy = catalogPolicyRecord(catalogYear);
  if (!catalogPolicy) throw new Error(`No authoritative published Economics catalog policy is available for ${catalogYear}.`);
  const normalizedCatalogYear = catalogYear === "2025-2026" ? catalogYear : "2025-2026";
  const dir = path.join(root, "data/normalized/catalogs", normalizedCatalogYear);
  const policy = loadEconomicsPolicyCompatibility({ catalogYear: "2025-2026" });
  const [programs, variants, requirements, prerequisites, courses, globalRules] = await Promise.all([
    readJson(path.join(dir, "programs.json"), []),
    readJson(path.join(dir, "program-variants.json"), []),
    readJson(path.join(dir, "requirements.json"), []),
    readJson(path.join(dir, "prerequisites.json"), {}),
    readJson(path.join(dir, "courses.json"), []),
    readJson(path.join(dir, "global-rules.json"), {})
  ]);
  const economicsRequirements = catalogRecordToRequirementSnapshot(catalogPolicy, policy.requirements);
  const selectedPrerequisites = catalogRecordToPrerequisites(catalogPolicy, policy.prerequisites);
  const byCatalogYear = Object.fromEntries(catalogPolicyRecords()
    .filter(record => record.activationStatus === "OWNER_AUTHORIZED_DECLARATION_YEAR")
    .map(record => [
    record.catalogYear,
    catalogRecordToPrerequisites(record, policy.prerequisites)
  ]));
  const economicsPrerequisites = {...selectedPrerequisites};
  Object.defineProperty(economicsPrerequisites, "byCatalogYear", {
    value: Object.freeze(byCatalogYear),
    enumerable: false
  });
  Object.freeze(economicsPrerequisites);
  const economicsSchedule = policy.schedule;
  const economicsCourseData = policy.courses;

  if (!programs.length || !variants.length || !requirements.length || !economicsRequirements || !economicsCourseData?.courses?.length) {
    throw new Error(`Approved catalog data for ${catalogYear} is incomplete.`);
  }

  const requirementsByProgram = new Map(requirements.map(item => [item.programId, item]));
  const prerequisitesByProgram = new Map();
  for (const program of programs) prerequisitesByProgram.set(program.id, prerequisites[program.id] || {});

  const economicsProgram = programs.find(program => program.id === "economics");
  if (economicsProgram && economicsRequirements) {
    requirementsByProgram.set("economics", economicsRequirements);
    prerequisitesByProgram.set("economics", economicsPrerequisites);
  }

  return {
    catalogYear,
    programs,
    variants,
    courses,
    globalRules,
    requirementsByProgram,
    prerequisitesByProgram,
    economicsSchedule: normalizeEconomicsSchedule(economicsSchedule),
    economicsCourses: economicsCourseData.courses,
    economicsRequirements,
    economicsPrerequisites,
    catalogPolicy,
    policyBundle: policy.bundle,
    policyBundleVersion: policy.bundle.bundleVersion,
    policyBundleHash: policy.bundle.contentHash
  };
}
