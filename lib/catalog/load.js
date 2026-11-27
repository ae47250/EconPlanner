import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeEconomicsSchedule } from "../planning/scheduleProvider.js";
import { loadEconomicsPolicyCompatibility } from "../policy/compat-normalized.js";
import {
  availableCatalogPolicyYears,
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
  return availableCatalogPolicyYears();
}

// Economics only (owner decision): one program, one variant. The per-program maps stay because callers
// look up "economics" in them; their contents come from the governed catalog policy.
export async function loadCatalog(catalogYear) {
  const catalogPolicy = catalogPolicyRecord(catalogYear);
  if (!catalogPolicy) throw new Error(`No authoritative published Economics catalog policy is available for ${catalogYear}.`);
  const dir = path.join(root, "data/normalized/catalogs/2025-2026");
  const policy = loadEconomicsPolicyCompatibility({ catalogYear: "2025-2026" });
  const [programs, variants] = await Promise.all([
    readJson(path.join(dir, "programs.json"), []),
    readJson(path.join(dir, "program-variants.json"), [])
  ]);
  const economicsRequirements = catalogRecordToRequirementSnapshot(catalogPolicy, policy.requirements);
  const economicsPrerequisites = catalogRecordToPrerequisites(catalogPolicy, policy.prerequisites);
  const economicsSchedule = policy.schedule;
  const economicsCourseData = policy.courses;

  if (!programs.some(program => program.id === "economics") || !variants.length || !economicsRequirements || !economicsCourseData?.courses?.length) {
    throw new Error(`Approved catalog data for ${catalogYear} is incomplete.`);
  }

  const requirementsByProgram = new Map([["economics", economicsRequirements]]);
  const prerequisitesByProgram = new Map([["economics", economicsPrerequisites]]);

  return {
    catalogYear,
    programs,
    variants,
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
