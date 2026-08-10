import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256 } from "../policy/canonical-json.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_COMPILED_ROOT = path.join(REPOSITORY_ROOT, "data/compiled/policy");
const PLANNING_FLEXIBILITY_VERSION = "econ-planning-flexibility.4";
const cache = new Map();
const planningFlexibilityCache = new Map();

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function immutable(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

export function loadCatalogPolicyReleases({compiledRoot = DEFAULT_COMPILED_ROOT, useCache = true} = {}) {
  const cacheKey = path.resolve(compiledRoot);
  if (useCache && cache.has(cacheKey)) return cache.get(cacheKey);
  const registry = readJson(path.join(compiledRoot, "catalog-releases.json"));
  if (registry.activeRuntimeMappingChanged !== false) throw new Error("Historical catalog compilation may not change the active runtime mapping.");
  const releases = registry.releases.map(reference => {
    const bundle = readJson(path.join(compiledRoot, reference.releasePath));
    const {contentHash, ...payload} = bundle;
    const computedHash = `sha256:${canonicalSha256(payload)}`;
    if (contentHash !== reference.contentHash || computedHash !== reference.contentHash) {
      throw new Error(`Compiled catalog policy digest mismatch for ${reference.bundleVersion}.`);
    }
    if (bundle.authoritativePublicationStatus !== "AUTHORITATIVE_PUBLISHED") {
      throw new Error(`${reference.bundleVersion} is not authoritative published catalog evidence.`);
    }
    return bundle;
  }).sort((left, right) => left.catalogYear.localeCompare(right.catalogYear));
  const loaded = immutable({registry, releases});
  if (useCache) cache.set(cacheKey, loaded);
  return loaded;
}

export function catalogPolicyRecords(options) {
  return loadCatalogPolicyReleases(options).releases.map(release => release.catalog);
}

export function availableCatalogPolicyYears(options) {
  return catalogPolicyRecords(options).map(catalog => catalog.catalogYear);
}

export function catalogPolicyRecord(catalogYear, options) {
  return catalogPolicyRecords(options).find(catalog => catalog.catalogYear === catalogYear) || null;
}

export function latestCatalogPolicyRecord(options) {
  return catalogPolicyRecords(options).at(-1) || null;
}

export function loadPlanningFlexibilityPolicy({compiledRoot = DEFAULT_COMPILED_ROOT, useCache = true} = {}) {
  const cacheKey = path.resolve(compiledRoot);
  if (useCache && planningFlexibilityCache.has(cacheKey)) return planningFlexibilityCache.get(cacheKey);
  const bundle = readJson(path.join(
    compiledRoot,
    "planning-flexibility",
    PLANNING_FLEXIBILITY_VERSION,
    "bundle.json"
  ));
  const {contentHash, ...payload} = bundle;
  const computedHash = `sha256:${canonicalSha256(payload)}`;
  if (contentHash !== computedHash) throw new Error("Compiled planning-flexibility policy digest mismatch.");
  if (bundle.activationStatus !== "OWNER_APPROVED" || bundle.activeRuntimeMappingChanged !== false) {
    throw new Error("Compiled planning-flexibility policy is not owner-approved and isolated from the active mapping.");
  }
  const loaded = immutable(bundle);
  if (useCache) planningFlexibilityCache.set(cacheKey, loaded);
  return loaded;
}

export function mostFlexibleEconomicsMajorRequirementSet(options) {
  return loadPlanningFlexibilityPolicy(options).policy.mostFlexibleEconomicsMajorRequirementSet;
}

export function economicsPlanningStrategyContract(options) {
  return loadPlanningFlexibilityPolicy(options).policy.economicsPlanningStrategies;
}

export function catalogRecordToRequirementSnapshot(catalog, template) {
  if (!catalog || !template) return template;
  const slots = template.requirementSlots.map(slot => {
    if (slot.id === "statistics") return {...slot, label: catalog.requirements.statisticsOptions.join(" / "), options: catalog.requirements.statisticsOptions};
    if (slot.id === "finance") return {...slot, label: catalog.requirements.moneyFinanceOptions.join(" / "), options: catalog.requirements.moneyFinanceOptions};
    if (slot.kind === "elective") {
      const supportsBusnFinance = catalog.requirements.moneyFinanceOptions.includes("BUSN 323");
      return {
        ...slot,
        excludedCourses: catalog.requirements.economicsElectives.excludedCourses,
        maxLevel100: catalog.requirements.economicsElectives.max100Level,
        conditionalCourses: supportsBusnFinance ? slot.conditionalCourses : {}
      };
    }
    return slot;
  });
  return immutable({
    ...template,
    catalogYear: catalog.catalogYear,
    sourceStatus: catalog.publicationStatus,
    sourceRefs: catalog.sourceRefs,
    requirementSlots: slots,
    rules: {
      ...template.rules,
      totalMajorCourses: catalog.requirements.majorCourseCount,
      totalCognateCourses: catalog.requirements.cognateCourseCount,
      max100LevelElectives: catalog.requirements.economicsElectives.max100Level
    },
    nonCourseMilestones: catalog.nonCourseMilestones,
    collegeWideBoundary: catalog.collegeWideBoundary
  });
}

export function catalogRecordToPrerequisites(catalog, template = {}) {
  if (!catalog) return template;
  const merged = {...template};
  for (const [course, rule] of Object.entries(catalog.prerequisites)) {
    const any = (rule.any || []).map(group => group.filter(option => option !== "READY_FOR_CALCULUS_PLACEMENT"));
    merged[course] = {
      ...(template[course] || {}),
      all: rule.all || [],
      any,
      ...(rule.any?.flat().includes("READY_FOR_CALCULUS_PLACEMENT")
        ? {placementAlternatives: ["READY_FOR_CALCULUS_PLACEMENT"]}
        : {})
    };
  }
  return immutable(merged);
}

export function clearCatalogPolicyReleaseCache() {
  cache.clear();
  planningFlexibilityCache.clear();
}
