import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { reportPlanCount } from "../lib/reports/economics.js";
import { POST as reportPost } from "../app/api/reports/economics/route.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/economics-report-student.json", import.meta.url), "utf8"));
const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");

test("canonical Economics report renders the same assignment data to HTML", async () => {
  const report = await buildEconomicsReportFromStudent(fixture.student, "2026-07-28");
  const html = renderEconomicsHtml(report, template);

  assert.equal(report.schemaVersion, "econmapper-economics-report-v1");
  assert.equal(report.preparedDate, "2026-07-28");
  assert.ok(report.requirements.some(item => item.label === "ECO 113" && item.strict === "ECO 113"));
  assert.ok(html.includes("HANOVER COLLEGE"));
  assert.ok(html.includes("ECO 113"));
  assert.ok(html.includes(String(report.remaining.strict)));
  assert.equal(html.includes("{{"), false);
  assert.equal(reportPlanCount(report) > 0, true);
});

test("Economics report API returns canonical JSON or populated HTML", async () => {
  const jsonResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, format: "json" })
  }));
  const json = await jsonResponse.json();
  assert.equal(jsonResponse.status, 200);
  assert.equal(json.schemaVersion, "econmapper-economics-report-v1");

  const htmlResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixture)
  }));
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get("content-type"), /text\/html/);
  assert.ok(html.includes("EconMapper"));
  assert.equal(html.includes("{{"), false);
});
