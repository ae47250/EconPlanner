import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CATALOG_WATCH_SOURCES,
  extractEconomicsStructure,
  runCatalogWatch
} from "../lib/catalog/catalogWatch.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/hanover-catalog-watch.v1.json", import.meta.url), "utf8"));
const active = extractEconomicsStructure("Major: Economics courses – 113 and 114; 213; 214; 257 or MAT 217 or PSY 217; 321 or BUSN 323; 461. Cognate courses: MAT 113 or MAT 121.");

function responses(overrides = {}) {
  const bodies = {
    registrar: fixture.currentRegistrar,
    "catalog-root": fixture.currentRoot,
    resources: "<html><h1>Academic resources</h1></html>",
    "economics-program": fixture.targetEconomics,
    ...overrides
  };
  const calls = [];
  return {
    calls,
    fetchImpl: async url => {
      const source = CATALOG_WATCH_SOURCES.find(item => item.url === url);
      calls.push(source.id);
      const value = bodies[source.id];
      if (value instanceof Error) throw value;
      return new Response(value, { status: 200 });
    }
  };
}

test("2025–2026 only is a green no-change result", async () => {
  const request = responses();
  const report = await runCatalogWatch({ now: new Date("2026-08-10T12:00:00Z"), fetchImpl: request.fetchImpl, activeEconomicsStructure: active });
  assert.equal(report.status, "NO_CHANGE");
  assert.equal(report.detectedCatalogYear, null);
  assert.deepEqual(request.calls, ["registrar", "catalog-root"]);
  assert.equal(report.activationPerformed, false);
});

test("Registrar and catalog root plus Economics program detect the official target", async () => {
  const request = responses({ registrar: fixture.targetRegistrar, "catalog-root": fixture.targetRoot });
  const report = await runCatalogWatch({ now: new Date("2026-08-10T12:00:00Z"), fetchImpl: request.fetchImpl, activeEconomicsStructure: active });
  assert.equal(report.status, "DETECTED");
  assert.equal(report.detectedCatalogYear, "2026-2027");
  assert.deepEqual(request.calls, ["registrar", "catalog-root", "economics-program"]);
  assert.ok(report.economicsStructure.unchangedRequirements.includes("ECO 461"));
  assert.equal(report.activationPerformed, false);
});

test("a target catalog root is detected when the Registrar has no catalog identity", async () => {
  const request = responses({ registrar: "<html><h1>Registrar</h1><p>Academic records</p></html>", "catalog-root": fixture.targetRoot });
  const report = await runCatalogWatch({ now: new Date("2026-08-10T12:00:00Z"), fetchImpl: request.fetchImpl, activeEconomicsStructure: active });
  assert.equal(report.status, "DETECTED");
  assert.ok(report.authoritativeEvidence.some(item => item.sourceUrl === CATALOG_WATCH_SOURCES[1].url && item.catalogYear === "2026-2027"));
});

test("an academic calendar or graduate catalog never proves publication", async () => {
  for (const registrar of [fixture.calendarOnly, fixture.graduateOnly]) {
    const request = responses({ registrar });
    const report = await runCatalogWatch({ now: new Date("2026-08-10T12:00:00Z"), fetchImpl: request.fetchImpl, activeEconomicsStructure: active });
    assert.equal(report.status, "NO_CHANGE");
  }
});

test("unreachable primary sources use the official resources fallback", async () => {
  const request = responses({ registrar: new Error("offline"), "catalog-root": new Error("offline"), resources: fixture.resourcesTarget });
  const report = await runCatalogWatch({ now: new Date("2026-08-10T12:00:00Z"), fetchImpl: request.fetchImpl, activeEconomicsStructure: active });
  assert.equal(report.status, "DETECTED");
  assert.deepEqual(request.calls, ["registrar", "catalog-root", "resources", "economics-program"]);
});

test("conflicting official catalog years require review and never activate", async () => {
  const request = responses({ registrar: fixture.targetRegistrar, "catalog-root": fixture.currentRoot });
  const report = await runCatalogWatch({ now: new Date("2026-08-10T12:00:00Z"), fetchImpl: request.fetchImpl, activeEconomicsStructure: active });
  assert.equal(report.status, "REVIEW_CONFLICT");
  assert.equal(report.activationPerformed, false);
});

test("after September 15 the watcher performs no external lookup", async () => {
  const request = responses();
  const report = await runCatalogWatch({ now: new Date("2026-09-16T00:00:00Z"), fetchImpl: request.fetchImpl, activeEconomicsStructure: active });
  assert.equal(report.status, "STOPPED_AFTER_END_DATE");
  assert.equal(report.externalLookupsPerformed, false);
  assert.deepEqual(request.calls, []);
});

test("the repository workflow runs weekly with read-only permissions", async () => {
  const workflow = await readFile(new URL("../.github/workflows/econplanner-catalog-watch.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron:\s*["']17 14 \* \* 1["']/);
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/);
  assert.match(workflow, /node scripts\/watch-hanover-catalog\.mjs/);
  assert.doesNotMatch(workflow, /git\s+(?:commit|push)|compile:(?:policy|catalog-policy)/);
});
