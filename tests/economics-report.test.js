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
  assert.ok(html.includes("Hanover College · Economics"));
  assert.match(html, /Class standing: Senior<\/p>/);
  assert.doesNotMatch(html, /Study abroad:/);
  assert.ok(html.includes("ECO 113"));
  assert.ok(html.includes(String(report.remaining.strict)));
  assert.equal(html.includes("{{"), false);
  assert.equal(reportPlanCount(report) > 0, true);
  assert.equal(
    (html.match(/class="course"/g) || []).length,
    report.terms.reduce((total, term) => total + term.courses.length, 0)
  );
});

test("explicit junior Winter and May study abroad reservations appear in the standard report without major credit", async () => {
  const student = {
    academicStanding: "sophomore", planCreationDate: "2026-11-21", courses: [],
    studyAbroadTerm: "winter-2028", studyAbroadMayOverlap: true,
    reservedCourseUnits: { "winter-2028": 4, "spring-2028": 1 },
    studyAbroadDestination: "Australia is one possible destination.",
    studyAbroadAdvisingNote: "Some courses taken abroad, especially Economics electives, may count toward Hanover’s Economics major. Check with your advisor or the Economics department once your course list is available."
  };
  const report = await buildEconomicsReportFromStudent(student, "2026-11-21");
  const html = renderEconomicsHtml(report, template);
  for (const id of ["winter-2028", "spring-2028"]) {
    const term = report.terms.find(item => item.slotId === id);
    assert.equal(term.studyAbroad, true);
    assert.deepEqual(term.courses, []);
  }
  assert.equal((html.match(/class="study-abroad">Study abroad<\/td>/g) || []).length, 2);
  assert.equal(report.student.studyAbroadLabel, "Winter 2028 and Spring/May 2028");
  assert.match(html, /Class standing: Sophomore \| Study abroad: Winter 2028 and Spring\/May 2028/);
  assert.deepEqual(report.studentAdvisorContext, [student.studyAbroadAdvisingNote]);
  assert.match(html, /<h2>For your advisor<\/h2>/);
  assert.ok(!html.includes(student.studyAbroadDestination));
  assert.ok(html.includes(student.studyAbroadAdvisingNote));

  const winterOnly = await buildEconomicsReportFromStudent({
    ...student, studyAbroadMayOverlap: false, reservedCourseUnits: { "winter-2028": 4 }
  }, "2026-11-21");
  assert.equal(winterOnly.terms.find(item => item.slotId === "winter-2028").studyAbroad, true);
  assert.equal(winterOnly.terms.find(item => item.slotId === "spring-2028").studyAbroad, false);
  assert.equal(winterOnly.terms.find(item => item.slotId === "spring-2028").courses.length, 1);
  assert.equal(report.remaining.strict, winterOnly.remaining.strict);
});

test("Taking now fixed occupancy is identical in the validated plan, JSON projection, and HTML", async () => {
  const student = {
    ...fixture.student,
    academicStanding: "freshman",
    planCreationDate: "2026-08-24",
    courses: [{ code: "ECO 113", status: "in_progress" }],
    scheduleSetByTerm: { "fall-2026": true }
  };
  const report = await buildEconomicsReportFromStudent(student, "2026-08-24");
  const html = renderEconomicsHtml(report, template);
  const planCurrent = report.selectedPlan.terms.find(term => term.slotId === "fall-2026");
  const reportCurrent = report.terms.find(term => term.slotId === "fall-2026");

  assert.deepEqual(planCurrent.courses.map(course => course.course), ["ECO 113"]);
  assert.deepEqual(reportCurrent.courses.map(course => course.code), ["ECO 113"]);
  assert.equal(planCurrent.courses[0].fixedInProgress, true);
  assert.equal(reportCurrent.courses[0].fixedInProgress, true);
  assert.match(html, /Taking now/);
  assert.equal((html.match(/>Taking now</g) || []).length, 1);
});

test("an eligible early comparison request preserves the selected normal-horizon report", async () => {
  const student = {
    ...fixture.student,
    academicStanding: "sophomore",
    planningPace: "one_year_early",
    planCreationDate: "2026-07-28"
  };
  const report = await buildEconomicsReportFromStudent(student, "2026-07-28");
  const html = renderEconomicsHtml(report, template);

  assert.equal(report.student.planningPace, "standard");
  assert.equal(report.student.classStandingSummary, "Sophomore (graduating one year early)");
  assert.equal(report.student.expectedGraduationTerm, "Spring/May 2029");
  assert.equal(report.selectedPlan.id, "balanced");
  assert.ok(report.candidateOutcomes.some(item => item.id === "one-year-early" && item.displayed));
  assert.equal(report.acceleratedPlanningResult.status, "POSSIBLE");
  assert.match(html, /data-planning-pace="standard"/);
  assert.match(html, /Class standing: Sophomore \(graduating one year early\)/);
  assert.match(html, /data-accelerated-planning-result="POSSIBLE"/);
  assert.match(html, /Graduate one year early: Possible/);

  const selectedReport = await buildEconomicsReportFromStudent(student, "2026-07-28", structuredClone(report.selectedPlan));
  assert.equal(selectedReport.selectedPlan.id, "balanced");
  assert.deepEqual(selectedReport.candidateOutcomes, []);
  assert.equal(selectedReport.acceleratedPlanningResult, null);
});

test("a custom graduation target remains separate in the advisor report", async () => {
  const student = {
    ...fixture.student,
    academicStanding: "sophomore",
    customGraduationEnabled: true,
    customExpectedGraduationYear: "2030",
    planningPace: "standard",
    planCreationDate: "2026-07-28"
  };
  const report = await buildEconomicsReportFromStudent(student, "2026-07-28");
  const html = renderEconomicsHtml(report, template);

  assert.equal(report.student.planType, "custom-graduation-horizon");
  assert.equal(report.student.classStandingSummary, "Sophomore (custom graduation year)");
  assert.match(html, /Class standing: Sophomore \(custom graduation year\)/);
  assert.equal(report.student.expectedGraduationTerm, "Spring/May 2030");
  assert.equal(report.acceleratedPlanningResult, null);
  assert.match(report.inputSummary, /student-selected Spring\/May 2030 target/);
});

test("Economics report API returns canonical JSON or populated HTML", async () => {
  const preparedDate = "2026-07-28";
  const jsonResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate, format: "json" })
  }));
  const json = await jsonResponse.json();
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("cache-control"), "no-store");
  assert.equal(json.schemaVersion, "econmapper-economics-report-v1");
  assert.equal(json.preparedDate, preparedDate);

  const htmlResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate })
  }));
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get("content-type"), /text\/html/);
  assert.ok(html.includes("<title>EconPlanner - Economics Major Course Plan</title>"));
  assert.equal(html.includes("{{"), false);
});

test("Economics report API sends inactive completed HTML to pdf-creator", async () => {
  let submitted;
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
  const response = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate: "2026-07-28", format: "pdf", storeResult: false, retentionDays: 1,
      downloadOperationId: "00000000-0000-4000-8000-000000000001" })
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
        assert.equal(options.redirect, "error");
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
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["x-vercel-protection-bypass"], "preview-bypass");
      assert.equal(options.headers.Authorization, undefined);
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    }
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/pdf/);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal(submitted.storeResult, true);
  assert.equal(submitted.storeHtml, false);
  assert.equal(submitted.retentionDays, 30);
  assert.equal(submitted.idempotencyKey, "econplanner:00000000-0000-4000-8000-000000000001");
  assert.match(submitted.idempotencyKey, /^econplanner:[A-Za-z0-9._:-]{8,128}$/);
  assert.match(submitted.html, /^<!doctype html>/i);
  assert.equal(/<script\b/i.test(submitted.html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(submitted.html), false);
  assert.equal(submitted.html.includes("{{"), false);
  assert.match(submitted.html, /<span class="course"[^>]*>ECO 461(?:-[^<]+)?<\/span>/);
  assert.match(submitted.correlationId, /^[A-Za-z0-9._:-]+$/);
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

test("PDF rollback flag leaves planner JSON and HTML reports available", async () => {
  const disabledEnvironment = { PDF_CREATION_ENABLED: "false" };
  const jsonResponse = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate: "2026-07-28", format: "json" })
  }), { environment: disabledEnvironment });
  const json = await jsonResponse.json();
  assert.equal(jsonResponse.status, 200);
  assert.equal(json.selectedPlan.id, "balanced");

  const htmlResponse = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture, preparedDate: "2026-07-28", format: "html" })
  }), { environment: disabledEnvironment });
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /data-selected-plan-id="balanced"/);
  assert.match(html, /Economics Major Course Plan/);
});

test("Economics PDF API returns rate limiting without retrying or logging secrets and report contents", async () => {
  const apiKey = "qualification-api-key-".padEnd(43, "x");
  const bypassToken = "qualification-preview-bypass";
  const logs = [];
  const originalConsoleError = console.error;
  let attempts = 0;
  console.error = value => { logs.push(String(value)); };
  let response;
  try {
    response = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fixture, preparedDate: "2026-07-28", format: "pdf" })
    }), {
      environment: {
        PDF_CREATION_ENABLED: "true",
        PDF_CREATION_API_URL: "https://pdf-creator.example",
        PDF_CREATION_API_KEY: apiKey,
        PDF_CREATION_BYPASS_TOKEN: bypassToken
      },
      fetchImpl: async () => {
        attempts += 1;
        return Response.json({
          error: { code: "rate_limited", message: "Caller limit reached.", requestId: "request-rate-1" }
        }, { status: 429, headers: { "Retry-After": "60", "X-Request-Id": "request-rate-1" } });
      },
      randomUUIDImpl: (() => {
        const values = ["operation-rate-limit", "correlation-rate-limit"];
        return () => values.shift();
      })()
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  const body = await response.json();
  assert.equal(body.code, "PDF_CREATION_RATE_LIMITED");
  assert.match(body.error, /try again in about a minute/i);
  assert.equal(attempts, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"upstreamCode":"rate_limited"/);
  assert.match(logs[0], /"attemptCount":1/);
  assert.doesNotMatch(logs[0], new RegExp(apiKey));
  assert.doesNotMatch(logs[0], new RegExp(bypassToken));
  assert.doesNotMatch(logs[0], new RegExp(fixture.student.displayName));
  assert.doesNotMatch(logs[0], /<!doctype html>/i);
});

test("transfer reports use the selected graduation and Hanover entry years", async () => {
  const report = await buildEconomicsReportFromStudent({
    ...fixture.student,
    isTransferStudent: true,
    transferExpectedGraduationYear: "2027",
    transferEntryAcademicYear: "2025-2026",
    planCreationDate: "2026-07-28",
    projectedSeniorStandingConfirmation: {
      status: "STUDENT_REPORTED_REGISTRAR_OR_ADVISOR_CONFIRMATION",
      academicYear: "2026/2027"
    }
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
  selectedPlan.search = { complete: false, solutionFound: false, terminationReason: "NODE_LIMIT" };
  selectedPlan.feasibility.search = selectedPlan.search;
  const response = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: fixture.student, preparedDate: "2026-07-28", selectedPlan, format: "json" })
  }));
  const report = await response.json();
  assert.equal(response.status, 200);
  assert.equal(report.selectedPlan.id, selectedPlan.id);
  assert.equal(report.selectedPlan.search, null);
  assert.equal(report.selectedPlan.feasibility.search, null);
  assert.notEqual(report.selectedPlan.feasibilityStatus, "SEARCH_INCOMPLETE");
  assert.deepEqual(report.candidateOutcomes, []);
  assert.equal(report.acceleratedPlanningResult, null);
  assert.deepEqual(
    report.terms.flatMap(term => term.courses.map(course => course.code)),
    selectedPlan.terms.flatMap(term => term.courses.map(course => course.course))
  );

  const htmlResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: fixture.student, preparedDate: "2026-07-28", selectedPlan, format: "html" })
  }));
  assert.equal(htmlResponse.status, 200);
  assert.match(await htmlResponse.text(), /data-selected-plan-id="balanced"/);

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

test("report and PDF validation reject a selected plan that exceeds authoritative reserved capacity", async () => {
  const generated = await buildEconomicsReportFromStudent(fixture.student, "2026-07-28");
  const selectedPlan = structuredClone(generated.selectedPlan);
  const fall = selectedPlan.terms.find(term => term.slotId === "fall-2026");
  assert.ok(fall.courses.length > 2);
  fall.reservedCourseUnits = 0;
  fall.reservedOutsideCourseUnits = 0;
  const student = {
    ...fixture.student,
    planCreationDate: "2026-07-28",
    reservedCourseUnits: { "fall-2026": 2 }
  };

  const reportResponse = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student, preparedDate: "2026-07-28", selectedPlan, format: "json" })
  }));
  assert.equal(reportResponse.status, 422);
  assert.equal((await reportResponse.json()).code, "SELECTED_PLAN_INVALID");

  let pdfCreatorCalls = 0;
  const pdfResponse = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student, preparedDate: "2026-07-28", selectedPlan, format: "pdf" })
  }), {
    environment: {
      PDF_CREATION_ENABLED: "true",
      PDF_CREATION_API_URL: "https://pdf-creator.example",
      PDF_CREATION_API_KEY: "a".repeat(43)
    },
    fetchImpl: async () => {
      pdfCreatorCalls += 1;
      throw new Error("PDF creation must not run for an invalid selected plan.");
    }
  });
  assert.equal(pdfResponse.status, 422);
  assert.equal((await pdfResponse.json()).code, "SELECTED_PLAN_INVALID");
  assert.equal(pdfCreatorCalls, 0);
});
