import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256 } from "../policy/canonical-json.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_COMPILED_ROOT = path.join(REPOSITORY_ROOT, "data/compiled/policy");
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
    "active.json"
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
    if (slot.id === "statistics") return {...slot, label: catalog.requirements.statisticsOptions.join(" / "), options: catalog.requirements.statisticsOptions,
      preferredOptions: (slot.preferredOptions || []).filter(option => catalog.requirements.statisticsOptions.includes(option))};
    if (slot.id === "finance") return {...slot, label: catalog.requirements.moneyFinanceOptions.join(" / "), options: catalog.requirements.moneyFinanceOptions,
      preferredOptions: (slot.preferredOptions || []).filter(option => catalog.requirements.moneyFinanceOptions.includes(option))};
    if (slot.id === "cognate") return {...slot, label: catalog.requirements.cognateOptions.join(" / "), options: catalog.requirements.cognateOptions,
      preferredOptions: (slot.preferredOptions || []).filter(option => catalog.requirements.cognateOptions.includes(option))};
    if (slot.kind === "elective") {
      return {
        ...slot,
        excludedCourses: catalog.requirements.economicsElectives.excludedCourses,
        maxLevel100: catalog.requirements.economicsElectives.max100Level,
        conditionalCourses: Object.fromEntries(Object.entries(slot.conditionalCourses || {}).filter(([, condition]) => catalog.requirements.moneyFinanceOptions.includes(condition.assignedCode)))
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

export function prerequisitesForCatalogYear(prerequisites = {}, catalogYear = null) {
  return prerequisites.byCatalogYear?.[catalogYear] || prerequisites;
}

export function classifyPrerequisiteChange(previous, current) {
  if (!previous || !current) return "UNKNOWN";
  const codes = [...new Set([
    ...(previous.all || []), ...(current.all || []),
    ...(previous.any || []).flat(), ...(current.any || []).flat()
  ])];
  if (codes.length > 12) return "MIXED_REVIEW_REQUIRED";
  const satisfied = (rule, available) => (rule.all || []).every(code => available.has(code))
    && (rule.any || []).every(group => group.some(code => available.has(code)));
  let oldOnly = false;
  let newOnly = false;
  for (let mask = 0; mask < 2 ** codes.length; mask += 1) {
    const available = new Set(codes.filter((_, index) => mask & (1 << index)));
    const before = satisfied(previous, available);
    const after = satisfied(current, available);
    oldOnly ||= before && !after;
    newOnly ||= after && !before;
  }
  if (oldOnly && newOnly) return "MIXED_REVIEW_REQUIRED";
  if (oldOnly) return "STRICTER";
  if (newOnly) return "MORE_FLEXIBLE";
  return "UNCHANGED";
}

export function governingCatalogPrerequisite(course, academicYear) {
  const year = String(academicYear || "").replace("/", "-");
  const releases = loadCatalogPolicyReleases().releases.filter(item => (
    item.activationStatus === "OWNER_AUTHORIZED_DECLARATION_YEAR"
  ));
  const index = releases.findIndex(item => (
    item.catalogYear === year
  ));
  const release = releases[index];
  const previous = index > 0 ? releases[index - 1] : null;
  const rule = release?.catalog?.prerequisites?.[course];
  return rule ? {
    rule,
    catalogYear: year,
    bundleVersion: release.bundleVersion,
    contentHash: release.contentHash,
    sourceRefs: release.catalog.sourceRefs,
    changeKind: previous?.catalog?.prerequisites?.[course]
      ? classifyPrerequisiteChange(previous.catalog.prerequisites[course], rule)
      : "UNKNOWN",
    previousSourceRefs: previous?.catalog?.sourceRefs || []
  } : null;
}

export function clearCatalogPolicyReleaseCache() {
  cache.clear();
  planningFlexibilityCache.clear();
}
