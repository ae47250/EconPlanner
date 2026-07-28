import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const catalogBaseUrl = "https://catalog.hanover.edu";
const indexUrl = `${catalogBaseUrl}/programs/`;
const catalogUrl = `${catalogBaseUrl}/`;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&rsquo;|&#39;|&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function slugFromFile(fileName) {
  return fileName.replace(/\.php$/i, "");
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Catalog fetch failed (${response.status}): ${url}`);
  return response.text();
}

const catalogHtml = await fetchText(catalogUrl);
const indexHtml = await fetchText(indexUrl);
const versionMatch = catalogHtml.match(/Academic Catalog\s+(\d{4}-\d{4})/i);
const catalogYear = versionMatch?.[1] || "unknown";
const catalogDir = path.join(root, "data/raw/hanover/catalog", catalogYear);
const normalizedDir = path.join(root, "data/normalized/catalogs", catalogYear);
const reviewDir = path.join(root, "data/review");
const manifestPath = path.join(root, "data/manifests/source-manifest.json");

await Promise.all([
  mkdir(catalogDir, { recursive: true }),
  mkdir(normalizedDir, { recursive: true }),
  mkdir(reviewDir, { recursive: true }),
  mkdir(path.dirname(manifestPath), { recursive: true })
]);

const files = [
  { role: "catalog_home", url: catalogUrl, fileName: "catalog.html", html: catalogHtml },
  { role: "program_index", url: indexUrl, fileName: "programs.html", html: indexHtml }
];

const programLinks = [...indexHtml.matchAll(/href="([^"]+\.php)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map(match => ({ fileName: match[1], name: stripHtml(match[2]) }))
  .filter(item => item.fileName && item.name);

for (const program of programLinks) {
  const url = new URL(program.fileName, indexUrl).toString();
  const html = await fetchText(url);
  files.push({ role: "program_page", url, fileName: program.fileName, html });
}

for (const file of files) {
  await writeFile(path.join(catalogDir, file.fileName), file.html, "utf8");
}

const programs = programLinks.map(program => {
  const id = slugFromFile(program.fileName);
  const sourceUrl = new URL(program.fileName, indexUrl).toString();
  return {
    id,
    name: program.name,
    catalogYear,
    sourceUrl,
    sourceStatus: "DRAFT_REVIEW_REQUIRED",
    programType: "undergraduate_major",
    variants: [`${id}-base`],
    requirementMapping: "not_published_until_review"
  };
});

const variants = programs.map(program => ({
  id: `${program.id}-base`,
  programId: program.id,
  label: program.name,
  degree: null,
  concentration: null,
  track: null,
  sourceStatus: "DRAFT_REVIEW_REQUIRED",
  sourceUrl: program.sourceUrl
}));

const requirements = programs.map(program => ({
  programId: program.id,
  catalogYear,
  sourceUrl: program.sourceUrl,
  sourceStatus: "DRAFT_REVIEW_REQUIRED",
  requirementTree: null,
  sourceNote: "Catalog source captured; requirement tree requires human review before runtime use."
}));

const courses = [...new Set([...catalogHtml.matchAll(/\b[A-Z]{2,5}\s?\d{3}\b/g)].map(match => match[0]))]
  .sort()
  .map(code => ({ code, catalogYear, sourceStatus: "DRAFT_REVIEW_REQUIRED", sourceUrl: catalogUrl }));

await writeFile(path.join(normalizedDir, "programs.json"), `${JSON.stringify(programs, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "program-variants.json"), `${JSON.stringify(variants, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "requirements.json"), `${JSON.stringify(requirements, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "courses.json"), `${JSON.stringify(courses, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "prerequisites.json"), `${JSON.stringify([], null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "global-rules.json"), `${JSON.stringify({
  catalogYear,
  sourceUrl: catalogUrl,
  sourceStatus: "VERIFIED_SOURCE_CAPTURE",
  rules: [
    "General degree requirements use the student's entry catalog year.",
    "Major requirements use the catalog in place when the student declares the major.",
    "At least 50 percent of courses in a major area of study must be taken at Hanover College.",
    "A major requires a minimum 2.0 GPA in major and cognate courses.",
    "No more than two D-range courses may count toward a major.",
    "All majors require a senior culminating experience."
  ]
}, null, 2)}\n`, "utf8");

await writeFile(
  path.join(reviewDir, `hanover_catalog_${catalogYear}_audit.csv`),
  [
    "program,program_variant,requirement_id,normalized_rule,source_url,source_excerpt,parser_confidence,reviewer_status,conflict_note,approved_by,approval_date",
    ...programs.map(program => `${JSON.stringify(program.name)},${JSON.stringify(`${program.id}-base`)},,,${JSON.stringify(program.sourceUrl)},,,DRAFT_REVIEW_REQUIRED,,,`)
  ].join("\n") + "\n",
  "utf8"
);

await writeFile(
  path.join(reviewDir, "source_conflicts.csv"),
  "source_a,source_b,field,conflict_note,status,reviewer,review_date\n",
  "utf8"
);

let existingManifest = { generatedAt: null, entries: [] };
try {
  existingManifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {}

const catalogEntries = files.map(file => ({
  role: file.role,
  source: file.url,
  catalogYear,
  path: path.relative(root, path.join(catalogDir, file.fileName)).replaceAll("\\", "/"),
  sha256: hash(file.html)
}));

const withoutCatalog = existingManifest.entries.filter(entry => entry.catalogYear !== catalogYear && !String(entry.path || "").includes(`data/raw/hanover/catalog/${catalogYear}/`));
await writeFile(
  manifestPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), entries: [...withoutCatalog, ...catalogEntries] }, null, 2)}\n`,
  "utf8"
);

console.log(`Captured Hanover catalog ${catalogYear}: ${programs.length} program pages.`);
