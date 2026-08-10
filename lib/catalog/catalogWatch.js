import { createHash } from "node:crypto";

export const CATALOG_WATCH_END = "2026-09-15T23:59:59.999Z";
export const TARGET_CATALOG_YEAR = "2026-2027";

export const CATALOG_WATCH_SOURCES = Object.freeze([
  { id: "registrar", role: "DISCOVERY", url: "https://www.hanover.edu/academics/registrar/" },
  { id: "catalog-root", role: "DISCOVERY", url: "https://catalog.hanover.edu/" },
  { id: "resources", role: "DISCOVERY", url: "https://www.hanover.edu/academics/resources/" },
  { id: "economics-program", role: "PROGRAM", url: "https://catalog.hanover.edu/programs/economics.php" }
]);

const REJECTED_PATH = /(?:academic[-_/ ]?calendar|course[-_/ ]?schedule|registration|graduate|draft|cache|search)/i;
const YEAR_PATTERN = /20\d{2}\s*[–—-]\s*(?:20)?\d{2}/g;

function normalizedYear(value) {
  const numbers = String(value || "").match(/20\d{2}|\d{2}/g) || [];
  if (numbers.length < 2) return null;
  const start = Number(numbers[0]);
  const end = numbers[1].length === 2 ? Math.floor(start / 100) * 100 + Number(numbers[1]) : Number(numbers[1]);
  return `${start}-${end}`;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function officialUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (!["www.hanover.edu", "hanover.edu", "catalog.hanover.edu"].includes(url.hostname.toLowerCase())) return null;
    if (REJECTED_PATH.test(`${url.pathname}${url.search}`)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function catalogYearsIn(value) {
  const text = decodeHtml(value);
  if (!/catalog/i.test(text) || /\bgraduate\s+(?:academic\s+)?catalog/i.test(text)) return [];
  const years = [];
  for (const match of text.matchAll(YEAR_PATTERN)) {
    const start = Math.max(0, match.index - 80);
    const end = Math.min(text.length, match.index + match[0].length + 80);
    const context = text.slice(start, end);
    if (!/(?:undergraduate\s+)?(?:academic\s+)?catalog/i.test(context)) continue;
    if (/\bgraduate\s+(?:academic\s+)?catalog/i.test(context)) continue;
    const year = normalizedYear(match[0]);
    if (year && !years.includes(year)) years.push(year);
  }
  return years.sort();
}

function authoritativeCatalogEvidence({ url, body }) {
  if (!officialUrl(url, url) || REJECTED_PATH.test(new URL(url).pathname)) return [];
  const evidence = [];
  const anchors = String(body || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const anchor of anchors) {
    const href = officialUrl(anchor[1], url);
    if (!href) continue;
    for (const catalogYear of catalogYearsIn(`${anchor[2]} ${href}`)) {
      evidence.push({ catalogYear, sourceUrl: url, catalogUrl: href, evidenceKind: "OFFICIAL_CATALOG_LINK" });
    }
  }
  const identityHtml = [
    ...(String(body || "").match(/<title\b[^>]*>[\s\S]*?<\/title>/gi) || []),
    ...(String(body || "").match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || [])
  ].join(" ");
  for (const catalogYear of catalogYearsIn(identityHtml)) {
    evidence.push({ catalogYear, sourceUrl: url, catalogUrl: url, evidenceKind: "OFFICIAL_CATALOG_PAGE_IDENTITY" });
  }
  return evidence.filter((item, index, items) => (
    items.findIndex(candidate => candidate.catalogYear === item.catalogYear && candidate.catalogUrl === item.catalogUrl) === index
  ));
}

function courseCodes(value) {
  const text = decodeHtml(value).toUpperCase();
  const codes = new Set([...text.matchAll(/\b(?:ECO|MAT|PSY|BUSN)\s*\d{3}\b/g)].map(match => match[0].replace(/\s+/, " ")));
  const economicsSegment = text.match(/ECONOMICS COURSES?\s*[-–—:]?\s*([\s\S]*?)(?:COGNATE|TOTAL OF|$)/)?.[1] || "";
  for (const match of economicsSegment.matchAll(/\b\d{3}\b/g)) codes.add(`ECO ${match[0]}`);
  return [...codes].sort();
}

function structuralLines(value, keyword) {
  return decodeHtml(value)
    .split(/(?<=[.;])\s+/)
    .filter(line => line.toLowerCase().includes(keyword))
    .map(line => line.replace(/\s+/g, " ").trim())
    .sort();
}

export function extractEconomicsStructure(value) {
  const text = decodeHtml(value);
  return {
    courseCodes: courseCodes(text),
    alternatives: structuralLines(text, " or "),
    prerequisites: structuralLines(text, "prerequisite"),
    normalizedText: text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  };
}

export function compareEconomicsStructure(active, discovered) {
  const activeCourses = new Set(active?.courseCodes || []);
  const discoveredCourses = new Set(discovered?.courseCodes || []);
  const activeAlternatives = new Set(active?.alternatives || []);
  const discoveredAlternatives = new Set(discovered?.alternatives || []);
  const activePrerequisites = new Set(active?.prerequisites || []);
  const discoveredPrerequisites = new Set(discovered?.prerequisites || []);
  return {
    unchangedRequirements: [...activeCourses].filter(code => discoveredCourses.has(code)).sort(),
    additions: [...discoveredCourses].filter(code => !activeCourses.has(code)).sort(),
    removals: [...activeCourses].filter(code => !discoveredCourses.has(code)).sort(),
    changedAlternatives: [
      ...[...activeAlternatives].filter(line => !discoveredAlternatives.has(line)).map(line => ({ change: "REMOVED", value: line })),
      ...[...discoveredAlternatives].filter(line => !activeAlternatives.has(line)).map(line => ({ change: "ADDED", value: line }))
    ],
    changedPrerequisites: [
      ...[...activePrerequisites].filter(line => !discoveredPrerequisites.has(line)).map(line => ({ change: "REMOVED", value: line })),
      ...[...discoveredPrerequisites].filter(line => !activePrerequisites.has(line)).map(line => ({ change: "ADDED", value: line }))
    ],
    otherMaterialDifferences: active?.normalizedText === discovered?.normalizedText
      ? []
      : ["The official Economics program text differs from the active 2025–2026 source text and requires owner review."]
  };
}

async function checkedSource(source, fetchImpl, checkedAt) {
  try {
    const response = await fetchImpl(source.url);
    const body = await response.text();
    const evidence = response.ok ? authoritativeCatalogEvidence({ url: response.url || source.url, body }) : [];
    return {
      ...source,
      checkedAt,
      httpStatus: response.status,
      resultStatus: response.ok ? "REACHABLE" : "HTTP_ERROR",
      finalUrl: response.url || source.url,
      contentSha256: createHash("sha256").update(body).digest("hex"),
      detectedCatalogYears: [...new Set(evidence.map(item => item.catalogYear))].sort(),
      evidence,
      body
    };
  } catch (error) {
    return {
      ...source,
      checkedAt,
      httpStatus: null,
      resultStatus: "UNREACHABLE",
      finalUrl: source.url,
      contentSha256: null,
      detectedCatalogYears: [],
      evidence: [],
      error: String(error?.message || error),
      body: ""
    };
  }
}

export async function runCatalogWatch({
  now = new Date(),
  fetchImpl = fetch,
  sources = CATALOG_WATCH_SOURCES,
  activeEconomicsStructure = extractEconomicsStructure("")
} = {}) {
  const checkedAt = new Date(now).toISOString();
  if (new Date(now).getTime() > new Date(CATALOG_WATCH_END).getTime()) {
    return {
      schemaVersion: 1,
      status: "STOPPED_AFTER_END_DATE",
      checkedAt,
      targetCatalogYear: TARGET_CATALOG_YEAR,
      stopDate: CATALOG_WATCH_END,
      externalLookupsPerformed: false,
      checkedSources: [],
      message: "The 2026–2027 catalog watch ended after September 15, 2026. No external catalog lookup was performed."
    };
  }

  const sourceById = new Map(sources.map(source => [source.id, source]));
  const checked = [];
  for (const id of ["registrar", "catalog-root"]) {
    if (sourceById.has(id)) checked.push(await checkedSource(sourceById.get(id), fetchImpl, checkedAt));
  }
  const discovery = checked.filter(item => item.role === "DISCOVERY");
  const discoveryYears = new Set(discovery.flatMap(item => item.detectedCatalogYears));
  if (!discoveryYears.has(TARGET_CATALOG_YEAR) && discovery.every(item => item.resultStatus !== "REACHABLE") && sourceById.has("resources")) {
    const resources = await checkedSource(sourceById.get("resources"), fetchImpl, checkedAt);
    checked.push(resources);
    resources.detectedCatalogYears.forEach(year => discoveryYears.add(year));
  }

  let program = null;
  if (discoveryYears.has(TARGET_CATALOG_YEAR) && sourceById.has("economics-program")) {
    program = await checkedSource(sourceById.get("economics-program"), fetchImpl, checkedAt);
    checked.push(program);
  }
  const reachableDiscovery = checked.filter(item => item.role === "DISCOVERY" && item.resultStatus === "REACHABLE");
  const currentAndTargetConflict = discoveryYears.has(TARGET_CATALOG_YEAR)
    && [...discoveryYears].some(year => year !== TARGET_CATALOG_YEAR);
  const programConfirmsTarget = program?.detectedCatalogYears.includes(TARGET_CATALOG_YEAR) === true;
  const status = !reachableDiscovery.length
    ? "SOURCE_UNAVAILABLE"
    : discoveryYears.has(TARGET_CATALOG_YEAR)
      ? currentAndTargetConflict || !programConfirmsTarget
        ? "REVIEW_CONFLICT"
        : "DETECTED"
      : "NO_CHANGE";
  const publicSources = checked.map(({ body: _body, ...source }) => source);
  return {
    schemaVersion: 1,
    status,
    checkedAt,
    targetCatalogYear: TARGET_CATALOG_YEAR,
    stopDate: CATALOG_WATCH_END,
    externalLookupsPerformed: true,
    detectedCatalogYear: discoveryYears.has(TARGET_CATALOG_YEAR) ? TARGET_CATALOG_YEAR : null,
    checkedSources: publicSources,
    authoritativeEvidence: publicSources.flatMap(source => source.evidence),
    economicsStructure: program?.body
      ? compareEconomicsStructure(activeEconomicsStructure, extractEconomicsStructure(program.body))
      : null,
    activationPerformed: false,
    message: {
      NO_CHANGE: "The official sources do not yet identify a 2026–2027 undergraduate Academic Catalog.",
      DETECTED: "Official 2026–2027 undergraduate Academic Catalog evidence was detected and requires reviewed activation.",
      REVIEW_CONFLICT: "Official sources conflict or the Economics program page does not yet confirm the detected catalog. Review is required.",
      SOURCE_UNAVAILABLE: "The official catalog discovery sources were unavailable. No catalog conclusion was made."
    }[status]
  };
}
