import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_WATCH_END,
  CATALOG_WATCH_SOURCES,
  extractEconomicsStructure,
  runCatalogWatch
} from "../lib/catalog/catalogWatch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function activeEconomicsStructure() {
  const records = JSON.parse(await readFile(path.join(ROOT, "data/normalized/catalogs/2025-2026/requirements.json"), "utf8"));
  const economics = records.find(record => record.programId === "economics");
  if (!economics?.requirementText) throw new Error("The active 2025–2026 Economics requirement source is unavailable.");
  return extractEconomicsStructure(economics.requirementText);
}

async function fetchOfficial(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: { "user-agent": "EconPlanner-Catalog-Watch/1.0 (+https://github.com/ae47250/EconPlanner)" }
  });
  const body = (await response.text()).slice(0, 2_000_000);
  return new Response(body, { status: response.status, headers: response.headers });
}

function summary(report) {
  const rows = report.checkedSources.map(source => (
    `| ${source.id} | ${source.resultStatus} | ${source.httpStatus ?? "—"} | ${source.detectedCatalogYears.join(", ") || "none"} |`
  )).join("\n");
  const differences = report.economicsStructure
    ? `\n## Economics structural comparison\n\n- Unchanged requirements: ${report.economicsStructure.unchangedRequirements.join(", ") || "none"}\n- Additions: ${report.economicsStructure.additions.join(", ") || "none"}\n- Removals: ${report.economicsStructure.removals.join(", ") || "none"}\n- Changed alternatives: ${report.economicsStructure.changedAlternatives.length}\n- Changed prerequisites: ${report.economicsStructure.changedPrerequisites.length}\n- Other material differences: ${report.economicsStructure.otherMaterialDifferences.length}\n`
    : "";
  return `# Hanover 2026–2027 catalog watch\n\n- Status: **${report.status}**\n- Checked: ${report.checkedAt}\n- Stop date: ${CATALOG_WATCH_END}\n- External lookups performed: ${report.externalLookupsPerformed}\n- Automatic activation: **never**\n\n${report.message}\n\n| Source | Result | HTTP | Catalog years |\n| --- | --- | ---: | --- |\n${rows || "| none | stopped | — | none |"}\n${differences}`;
}

export async function main() {
  const now = option("--now", new Date().toISOString());
  const outputPath = path.resolve(ROOT, option("--output", "test-results/catalog-watch/catalog-watch-report.json"));
  const report = await runCatalogWatch({
    now: new Date(now),
    fetchImpl: fetchOfficial,
    sources: CATALOG_WATCH_SOURCES,
    activeEconomicsStructure: await activeEconomicsStructure()
  });
  const summaryPath = outputPath.replace(/\.json$/i, ".md");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, summary(report), "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${summary(report)}\n`, "utf8");
  process.stdout.write(`${summary(report)}\n\nReport: ${outputPath}\n`);
  if (["DETECTED", "REVIEW_CONFLICT", "SOURCE_UNAVAILABLE"].includes(report.status) && !process.argv.includes("--report-only")) {
    process.exitCode = 2;
  }
  return report;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await main();
