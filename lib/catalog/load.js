import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeEconomicsSchedule } from "../planning/scheduleProvider.js";

const root = process.cwd();

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return fallback;
  }
}

async function readFirstJson(filePaths, fallback) {
  for (const filePath of filePaths) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return fallback;
}

function catalogStartYear(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{4})$/);
  return match ? Number(match[1]) : Number.NaN;
}

export function resolveCatalogYear(requestedCatalogYear, catalogYears = []) {
  const requestedStart = catalogStartYear(requestedCatalogYear);
  const approvedYears = [...new Set(catalogYears)]
    .filter(year => Number.isFinite(catalogStartYear(year)))
    .sort((left, right) => catalogStartYear(left) - catalogStartYear(right));

  if (approvedYears.includes(requestedCatalogYear)) {
    return {
      requestedCatalogYear,
      selectedCatalogYear: requestedCatalogYear,
      catalogResolutionStatus: "exact"
    };
  }

  const selectedCatalogYear = approvedYears
    .filter(year => catalogStartYear(year) < requestedStart)
    .at(-1);

  return {
    requestedCatalogYear,
    selectedCatalogYear: selectedCatalogYear || null,
    catalogResolutionStatus: selectedCatalogYear ? "previous_year_fallback" : "unavailable"
  };
}

export async function availableCatalogYears() {
  try {
    const entries = await readdir(path.join(root, "data/normalized/catalogs"), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return [];
  }
}

export async function loadCatalog(catalogYear) {
  const dir = path.join(root, "data/normalized/catalogs", catalogYear);
  const [programs, variants, requirements, prerequisites, courses, globalRules, economicsRequirements, economicsPrerequisites, economicsSchedule, economicsCourseData] = await Promise.all([
    readJson(path.join(dir, "programs.json"), []),
    readJson(path.join(dir, "program-variants.json"), []),
    readJson(path.join(dir, "requirements.json"), []),
    readJson(path.join(dir, "prerequisites.json"), {}),
    readJson(path.join(dir, "courses.json"), []),
    readJson(path.join(dir, "global-rules.json"), {}),
    readFirstJson([
      path.join(dir, "economics-requirements.json"),
      path.join(dir, "economics", "requirements.json"),
      path.join(root, "data/normalized/economics", `requirements-${catalogYear}.json`),
      ...(catalogYear === "2025-2026" ? [path.join(root, "data/normalized/economics/requirements.json")] : [])
    ], null),
    readFirstJson([
      path.join(dir, "economics-prerequisites.json"),
      path.join(dir, "economics", "prerequisites.json"),
      path.join(root, "data/normalized/economics", `prerequisites-${catalogYear}.json`),
      ...(catalogYear === "2025-2026" ? [path.join(root, "data/normalized/economics/prerequisites.json")] : [])
    ], {}),
    readJson(path.join(root, "data/normalized/economics/schedule-2026-2027.json"), null),
    readJson(path.join(root, "data/normalized/economics/courses.json"), null)
  ]);

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
    economicsPrerequisites
  };
}
