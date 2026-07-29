import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readFirstJson(filePaths, fallback) {
  for (const filePath of filePaths) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      // Try the next versioned source.
    }
  }
  return fallback;
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
  const [programs, variants, requirements, prerequisites, courses, globalRules, economicsRequirements, economicsPrerequisites, economicsSchedule] = await Promise.all([
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
    readJson(path.join(root, "data/normalized/economics/schedule-2026-2027.json"), null)
  ]);

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
    economicsSchedule,
    economicsRequirements,
    economicsPrerequisites
  };
}
