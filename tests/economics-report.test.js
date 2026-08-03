import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { reportPlanCount } from "../lib/reports/economics.js";
import { createPdfFromHtml } from "../lib/pdf-creation-client.js";
import {
  handleEconomicsReportRequest,
  POST as reportPost
} from "../app/api/reports/economics/route.js";

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
  assert.equal(
    (html.match(/class="course"/g) || []).length,
    report.terms.reduce((total, term) => total + term.courses.length, 0)
  );
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

test("Economics report API sends inactive completed HTML to pdf-creator", async () => {
  let submitted;
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
  const response = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate: "2026-07-28", format: "pdf" })
  }), {
    environment: {
      PDF_CREATION_ENABLED: "true",
      PDF_CREATION_API_URL: "https://pdf-creator.example",
      PDF_CREATION_API_KEY: "a".repeat(43),
      PDF_CREATION_BYPASS_TOKEN: "preview-bypass"
    },
    fetchImpl: async (url, options) => {
      if (url.pathname === "/api/v1/pdfs") {
        assert.equal(url.href, "https://pdf-creator.example/api/v1/pdfs");
        assert.equal(options.headers.Authorization, `Bearer ${"a".repeat(43)}`);
        assert.equal(options.headers["x-vercel-protection-bypass"], "preview-bypass");
        submitted = JSON.parse(options.body);
        return Response.json({
          status: "complete",
          requestId: "request-1",
          reportId: "r30_00000000-0000-4000-8000-000000000001",
          caller: "econplanner",
          durationMs: 2000,
          pdfBytes: pdf.byteLength,
          pageCount: 2,
          sha256: pdfSha256,
          links: {
            download: "https://pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000001/download"
          }
        });
      }
      assert.equal(url.href, "https://pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000001/download");
      assert.equal(options.headers["x-vercel-protection-bypass"], "preview-bypass");
      assert.equal(options.headers.Authorization, undefined);
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    }
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/pdf/);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal(submitted.storeResult, true);
  assert.equal(submitted.storeHtml, true);
  assert.equal(submitted.retentionDays, 30);
  assert.match(submitted.idempotencyKey, /^econplanner:[0-9a-f]{64}$/);
  assert.match(submitted.html, /^<!doctype html>/i);
  assert.equal(/<script\b/i.test(submitted.html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(submitted.html), false);
  assert.equal(submitted.html.includes("{{"), false);
  assert.match(submitted.html, /<span class="course">ECO 461(?:-[^<]+)?<\/span>/);
  assert.match(submitted.correlationId, /^[A-Za-z0-9._:-]+$/);
  assert.equal(/[^\x00-\x7F]/.test(submitted.html), false);
});

test("PDF client rejects a cross-origin stored download before forwarding the preview bypass", async () => {
  let fetchCount = 0;
  await assert.rejects(
    createPdfFromHtml({ html: "<!doctype html><html><body>safe</body></html>" }, {
      environment: {
        PDF_CREATION_ENABLED: "true",
        PDF_CREATION_API_URL: "https://pdf-creator.example",
        PDF_CREATION_API_KEY: "a".repeat(43),
        PDF_CREATION_BYPASS_TOKEN: "preview-bypass"
      },
      fetchImpl: async () => {
        fetchCount += 1;
        return Response.json({
          status: "complete",
          requestId: "request-2",
          reportId: "r30_00000000-0000-4000-8000-000000000002",
          caller: "econplanner",
          durationMs: 1000,
          pdfBytes: 6,
          pageCount: 1,
          sha256: "a".repeat(64),
          links: {
            download: "https://untrusted.example/reports/r30_00000000-0000-4000-8000-000000000002/download"
          }
        });
      }
    }),
    error => error.code === "PDF_CREATION_FAILED"
  );
  assert.equal(fetchCount, 1);
});

test("Economics PDF API returns stable disabled and configuration errors", async () => {
  const disabled = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate: "2026-07-28", format: "pdf" })
  }), { environment: { PDF_CREATION_ENABLED: "false" } });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).code, "PDF_CREATION_DISABLED");

  const missing = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate: "2026-07-28", format: "pdf" })
  }), { environment: { PDF_CREATION_ENABLED: "true" } });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "PDF_CREATION_NOT_CONFIGURED");
});

test("transfer reports use the selected graduation and Hanover entry years", async () => {
  const report = await buildEconomicsReportFromStudent({
    ...fixture.student,
    isTransferStudent: true,
    transferExpectedGraduationYear: "2027",
    transferEntryAcademicYear: "2025-2026",
    planCreationDate: "2026-07-28"
  }, "2026-07-28");

  assert.equal(report.student.academicStanding, "Transfer plan");
  assert.equal(report.student.planType, "transfer");
  assert.equal(report.student.transferEntryAcademicYear, "2025-2026");
  assert.equal(report.student.expectedGraduationTerm, "Spring/May 2027");
  assert.match(report.inputSummary, /transfer plan targeting Spring\/May 2027/);
});

test("selected report plan is revalidated and rendered exactly", async () => {
  const generated = await buildEconomicsReportFromStudent(fixture.student, "2026-07-28");
  const selectedPlan = structuredClone(generated.selectedPlan);
  const response = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: fixture.student, preparedDate: "2026-07-28", selectedPlan, format: "json" })
  }));
  const report = await response.json();
  assert.equal(response.status, 200);
  assert.equal(report.selectedPlan.id, selectedPlan.id);
  assert.deepEqual(
    report.terms.flatMap(term => term.courses.map(course => course.code)),
    selectedPlan.terms.flatMap(term => term.courses.map(course => course.course))
  );

  const tamperedMeetingPlan = structuredClone(selectedPlan);
  const verifiedCourse = tamperedMeetingPlan.terms
    .flatMap(term => term.courses)
    .find(course => course.source === "verified-offering" && course.meeting?.startTime);
  assert.ok(verifiedCourse);
  verifiedCourse.meeting.startTime = "1:00 PM";
  verifiedCourse.meeting.startMinutes = 780;
  const tamperedMeetingResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: fixture.student,
      preparedDate: "2026-07-28",
      selectedPlan: tamperedMeetingPlan,
      format: "json"
    })
  }));
  assert.equal(tamperedMeetingResponse.status, 422);

  selectedPlan.terms[0].courses.push({ course: "ECO 999", requirementId: "eco-113", source: "verified-offering" });
  const invalidResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: fixture.student, preparedDate: "2026-07-28", selectedPlan, format: "json" })
  }));
  assert.equal(invalidResponse.status, 422);
});
