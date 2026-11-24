import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { POST as majorPost } from "../app/api/majors/map/route.js";
import {
  handleEconomicsReportRequest,
  POST as reportPost
} from "../app/api/reports/economics/route.js";
import {
  courseOccurrences,
  economics257Roles,
  projectPdfCreatorRequestArtifact,
  projectReportHtmlArtifact,
  projectReportJsonArtifact,
  projectSelectedPlanArtifact,
  projectionMetrics,
  projectionMismatches
} from "./oracle/economics-artifact-projection.js";

const PREPARED_DATE = "2026-07-30";
const PDF_ENVIRONMENT = Object.freeze({
  PDF_CREATION_ENABLED: "true",
  PDF_CREATION_API_URL: "https://pdf-creator.example",
  PDF_CREATION_API_KEY: "a".repeat(43)
});

function completed(codes) {
  return codes.map(code => ({ code, status: "completed", units: 1, source: "manual_code" }));
}

const LARGE_SELECTED_STUDENT = Object.freeze({
  displayName: "Artifact Parity Student",
  academicStanding: "senior",
  planCreationDate: PREPARED_DATE,
  courses: completed(["ECO 113", "ECO 114", "MAT 113", "ECO 213"])
});

const PROJECTED_STUDENT = Object.freeze({
  displayName: "Non-default Plan Student",
  academicStanding: "sophomore",
  planCreationDate: PREPARED_DATE,
  courses: completed([
    "ECO 113", "ECO 114", "MAT 113", "MAT 217", "BUSN 323",
    "ECO 161", "ECO 221", "ECO 234", "ECO 260"
  ])
});

function statisticsCompletedStudent(statisticsCourse) {
  return {
    displayName: `${statisticsCourse} Statistics Student`,
    academicStanding: "senior",
    planCreationDate: PREPARED_DATE,
    courses: completed([
      "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113",
      statisticsCourse, "BUSN 323"
    ])
  };
}

const FUTURE_ECO257_STUDENT = Object.freeze({
  displayName: "ECO 257 Statistics Student",
  academicStanding: "senior",
  planCreationDate: "2027-07-30",
  courses: completed([
    "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "BUSN 323",
    "ECO 161", "ECO 221", "ECO 234", "ECO 260"
  ])
});

async function postJson(handler, url, body, dependencies) {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const response = dependencies
    ? await handler(request, dependencies)
    : await handler(request);
  const data = await response.json();
  return { response, data };
}

async function generateEconomics(student) {
  const { response, data } = await postJson(
    majorPost,
    "http://localhost/api/majors/map",
    { student }
  );
  assert.equal(response.status, 200, JSON.stringify(data));
  const economics = data.programs.find(program => program.program?.id === "economics-base");
  assert.ok(economics?.economicsPlans?.length, "Expected at least one generated Economics plan.");
  return economics;
}

async function validateEditedPlan(student, economics, editedPlan) {
  const plans = economics.economicsPlans.map(plan => plan.id === editedPlan.id ? editedPlan : plan);
  const { response, data } = await postJson(
    majorPost,
    "http://localhost/api/majors/map",
    { action: "validate-plan", student, plan: editedPlan, plans }
  );
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.plan.validation.valid, true);
  return data.plan;
}

function replaceElective(plan, replacementCode) {
  const edited = structuredClone(plan);
  for (const term of edited.terms) {
    const course = term.courses.find(item => (
      item.alternativeOptions?.some(option => option.course === replacementCode)
      && item.course !== replacementCode
    ));
    if (!course) continue;
    const replacement = course.alternativeOptions.find(option => option.course === replacementCode);
    Object.assign(course, replacement, {
      requirementId: course.requirementId,
      selectedOptionId: replacement.id,
      alternativeOptions: course.alternativeOptions
    });
    return edited;
  }
  throw new Error(`No ${replacementCode} elective alternative was available.`);
}

async function reportJson(student, selectedPlan) {
  const { response, data } = await postJson(
    reportPost,
    "http://localhost/api/reports/economics",
    { student, preparedDate: PREPARED_DATE, selectedPlan, format: "json" }
  );
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

async function reportHtml(student, selectedPlan) {
  const response = await reportPost(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student, preparedDate: PREPARED_DATE, selectedPlan, format: "html" })
  }));
  const html = await response.text();
  assert.equal(response.status, 200, html);
  return html;
}

function validStoredPdfResult(pdf) {
  return {
    status: "complete",
    requestId: "task-17-request",
    reportId: "r30_00000000-0000-4000-8000-000000000017",
    caller: "econplanner",
    durationMs: 1700,
    pdfBytes: pdf.byteLength,
    pageCount: 2,
    sha256: createHash("sha256").update(pdf).digest("hex"),
    links: {
      download: "https://pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000017/download"
    }
  };
}

async function reportPdf(student, selectedPlan) {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x37]);
  let submitted = null;
  const response = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student, preparedDate: PREPARED_DATE, selectedPlan, format: "pdf" })
  }), {
    environment: PDF_ENVIRONMENT,
    fetchImpl: async (url, options) => {
      if (url.pathname === "/api/v1/pdfs") {
        submitted = JSON.parse(options.body);
        return Response.json(validStoredPdfResult(pdf));
      }
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    }
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(submitted, "The mocked PDF creator did not receive a request.");
  return submitted;
}

async function changedElectiveArtifacts() {
  const student = { ...LARGE_SELECTED_STUDENT, isTransferStudent: true,
    transferEntryAcademicYear: "2025-2026", transferExpectedGraduationYear: "2027" };
  const economics = await generateEconomics(student);
  const replaceable = economics.economicsPlans.find(plan => plan.terms.some(term => term.courses.some(course => (
    course.course !== "ECO 224" && course.alternativeOptions?.some(option => option.course === "ECO 224")
  ))));
  assert.ok(replaceable, "Expected a plan with an ECO 224 elective alternative.");
  const edited = replaceElective(replaceable, "ECO 224");
  const selectedPlan = await validateEditedPlan(student, economics, edited);
  const json = await reportJson(student, selectedPlan);
  const html = await reportHtml(student, selectedPlan);
  const pdfRequest = await reportPdf(student, selectedPlan);
  return { selectedPlan, json, html, pdfRequest };
}

test("Task 17 keeps a non-default selected plan selected in JSON, HTML, and the mocked PDF request", async () => {
  const economics = await generateEconomics(PROJECTED_STUDENT);
  const defaultPlanId = economics.economicsPlans[0].id;
  const selectedPlan = structuredClone(economics.economicsPlans.find(plan => plan.id !== defaultPlanId));
  assert.ok(selectedPlan);
  const json = await reportJson(PROJECTED_STUDENT, selectedPlan);
  const html = await reportHtml(PROJECTED_STUDENT, selectedPlan);
  const pdfRequest = await reportPdf(PROJECTED_STUDENT, selectedPlan);

  assert.equal(json.selectedPlan.id, selectedPlan.id);
  assert.notEqual(json.selectedPlan.id, defaultPlanId);
  const expected = projectSelectedPlanArtifact(selectedPlan, {
    advisorNotices: json.catalog?.advisorAttention || []
  });
  const jsonProjection = projectReportJsonArtifact(json);
  assert.deepEqual(projectionMismatches(expected, jsonProjection), []);
  assert.deepEqual(projectionMismatches(expected, projectReportHtmlArtifact(html)), []);
  assert.deepEqual(projectionMismatches(expected, projectPdfCreatorRequestArtifact(pdfRequest)), []);
  assert.equal(pdfRequest.html, html);
});

test("Task 17 canonical projection has full JSON, HTML, and mocked PDF parity after an elective change", async () => {
  const { selectedPlan, json, html, pdfRequest } = await changedElectiveArtifacts();
  const expected = projectSelectedPlanArtifact(selectedPlan, {
    advisorNotices: json.catalog?.advisorAttention || []
  });
  const projections = {
    json: projectReportJsonArtifact(json),
    html: projectReportHtmlArtifact(html),
    pdfRequest: projectPdfCreatorRequestArtifact(pdfRequest)
  };

  assert.deepEqual(projectionMismatches(expected, projections.json), []);
  for (const projection of Object.values(projections)) {
    assert.equal(courseOccurrences(projection, "ECO 224"), 1);
    assert.equal(courseOccurrences(projection, "ECO 222"), 0);
  }
  assert.equal(expected.feasibilityStatus, "CONDITIONALLY_FEASIBLE");
  assert.equal(expected.terms.flatMap(term => term.courses).filter(course => course.requirementRole).length, 8);
  assert.ok(expected.warnings.some(message => /unknown date|availability|seat/i.test(message)));
  assert.equal(expected.advisorAttention.length, 0);
  assert.ok(expected.terms.some(term => term.courses.some(course => (
    ["ECO 321", "BUSN 323"].includes(course.code) && course.requirementRole === "finance"
  ))));
  assert.ok(!expected.warnings.some(message => /petition with the Student Academic Assistance Committee/.test(message)));
  assert.ok(!expected.advisorAttention.some(notice => notice.code.startsWith("PLAN_EDIT_OPTIONS_")));
  assert.ok(expected.terms.some(term => term.courses.some(course => course.approvals.length > 0)));

  for (const projection of [projections.html, projections.pdfRequest]) {
    assert.deepEqual(projection.warnings, expected.warnings);
    assert.equal(new Set(projection.warnings).size, projection.warnings.length);
    assert.deepEqual(projection.advisorAttention, expected.advisorAttention);
  }
  assert.deepEqual({
    html: projectionMismatches(expected, projections.html),
    pdfRequest: projectionMismatches(expected, projections.pdfRequest)
  }, { html: [], pdfRequest: [] });
  const metricProjection = Object.fromEntries(Object.entries({ expected, ...projections }).map(([name, projection]) => [
    name,
    projectionMetrics(projection)
  ]));
  assert.deepEqual(metricProjection.expected, metricProjection.json);
  assert.deepEqual(metricProjection.expected, metricProjection.html);
  assert.deepEqual(metricProjection.expected, metricProjection.pdfRequest);
  if (process.env.ECONPLANNER_PARITY_METRICS === "1") {
    console.log(JSON.stringify({ event: "ECONPLANNER_REPORT_PARITY_METRICS", projections: metricProjection }));
  }
});

test("Task 17 preserves ECO 257 as statistics in every artifact role", async () => {
  const economics = await generateEconomics(FUTURE_ECO257_STUDENT);
  const edited = structuredClone(economics.economicsPlans[0]);
  const statistics = edited.terms.flatMap(term => term.courses)
    .find(course => course.requirementId === "statistics");
  assert.ok(statistics, "Expected a projected statistics placement.");
  Object.assign(statistics, {
    course: "ECO 257",
    title: "Statistics for Economists",
    source: "projected-offering",
    offeringStatus: "projected",
    verificationStatus: "unverified"
  });
  const selectedPlan = await validateEditedPlan(FUTURE_ECO257_STUDENT, economics, edited);
  const json = await reportJson(FUTURE_ECO257_STUDENT, selectedPlan);
  const html = await reportHtml(FUTURE_ECO257_STUDENT, selectedPlan);
  const pdfRequest = await reportPdf(FUTURE_ECO257_STUDENT, selectedPlan);
  const roles = {
    selectedPlan: economics257Roles(projectSelectedPlanArtifact(selectedPlan)),
    json: economics257Roles(projectReportJsonArtifact(json)),
    html: economics257Roles(projectReportHtmlArtifact(html)),
    pdfRequest: economics257Roles(projectPdfCreatorRequestArtifact(pdfRequest))
  };
  assert.deepEqual(roles, {
    selectedPlan: ["statistics"],
    json: ["statistics"],
    html: ["statistics"],
    pdfRequest: ["statistics"]
  });
});

test("Task 17 rejects forged ECO 257 electives and omits ECO 257 when MAT 217 or PSY 217 fills statistics", async () => {
  for (const statisticsCourse of ["MAT 217", "PSY 217"]) {
    const student = statisticsCompletedStudent(statisticsCourse);
    const economics = await generateEconomics(student);
    const selectedPlan = structuredClone(economics.economicsPlans[0]);
    const json = await reportJson(student, selectedPlan);
    const html = await reportHtml(student, selectedPlan);
    const pdfRequest = await reportPdf(student, selectedPlan);
    for (const projection of [
      projectSelectedPlanArtifact(selectedPlan),
      projectReportJsonArtifact(json),
      projectReportHtmlArtifact(html),
      projectPdfCreatorRequestArtifact(pdfRequest)
    ]) {
      assert.equal(courseOccurrences(projection, "ECO 257"), 0, statisticsCourse);
    }

    const forged = structuredClone(selectedPlan);
    const elective = forged.terms.flatMap(term => term.courses)
      .find(course => String(course.requirementId || "").startsWith("eco-elective"));
    elective.course = "ECO 257";
    elective.title = "Applied Statistics";
    elective.section = "";
    elective.source = "requirement-placeholder";
    elective.verificationStatus = "unverified";
    elective.availability = { status: "unknown", seatsOpen: null, capacity: null, asOf: null };
    elective.meeting = { days: [], startMinutes: null, endMinutes: null };
    delete elective.alternativeOptions;
    delete elective.selectedOptionId;

    const invalid = await postJson(
      reportPost,
      "http://localhost/api/reports/economics",
      { student, preparedDate: PREPARED_DATE, selectedPlan: forged, format: "json" }
    );
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.data.code, "SELECTED_PLAN_INVALID");

    let pdfCalls = 0;
    const invalidPdf = await handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ student, preparedDate: PREPARED_DATE, selectedPlan: forged, format: "pdf" })
    }), {
      environment: PDF_ENVIRONMENT,
      fetchImpl: async () => {
        pdfCalls += 1;
        throw new Error("Invalid selected plans must not reach PDF creation.");
      }
    });
    assert.equal(invalidPdf.status, 422);
    assert.equal((await invalidPdf.json()).code, "SELECTED_PLAN_INVALID");
    assert.equal(pdfCalls, 0);
  }
});

test("Task 17 rejects malformed PDF results and preserves stable service error mapping", async () => {
  const economics = await generateEconomics(PROJECTED_STUDENT);
  const selectedPlan = economics.economicsPlans[0];
  async function pdfWith(fetchImpl) {
    return handleEconomicsReportRequest(new Request("http://localhost/api/reports/economics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ student: PROJECTED_STUDENT, preparedDate: PREPARED_DATE, selectedPlan, format: "pdf" })
    }), { environment: PDF_ENVIRONMENT, fetchImpl });
  }

  const malformed = await pdfWith(async () => Response.json({ status: "complete" }));
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json()).code, "PDF_CREATION_FAILED");

  const upstream = await pdfWith(async () => Response.json(
    { error: { code: "UPSTREAM_BUSY" } },
    { status: 503, headers: { "x-request-id": "task-17-upstream" } }
  ));
  assert.equal(upstream.status, 502);
  assert.equal((await upstream.json()).code, "PDF_CREATION_FAILED");

  const network = await pdfWith(async () => {
    throw new TypeError("network unavailable");
  });
  assert.equal(network.status, 502);
  assert.equal((await network.json()).code, "PDF_CREATION_FAILED");
});

for (const authority of ["ECO 213 instructor", "Economics Department"]) {
  test(`approval badges preserve ${authority} evidence across the edited plan and reports`, async () => {
    const instructor = authority === "ECO 213 instructor";
    const student = instructor
      ? { academicStanding: "freshman", planCreationDate: "2026-10-19", courses: [] }
      : { academicStanding: "junior", planCreationDate: PREPARED_DATE, courses: completed(["MAT 113", "MAT 217", "ECO 161", "ECO 221"]) };
    const economics = await generateEconomics(student);
    let selectedPlan = economics.economicsPlans.find(plan => plan.id === "balanced");
    if (instructor) {
      const { response, data } = await postJson(majorPost, "http://localhost/api/majors/map", {
        action: "validate-plan", student, plan: selectedPlan, plans: economics.economicsPlans,
        edit: { type: "move", fromTermId: "winter-2028", courseId: "eco-213", toTermId: "fall-2027" }
      });
      assert.equal(response.status, 200, JSON.stringify(data));
      selectedPlan = data.plan;
    } else {
      const { response, data } = await postJson(majorPost, "http://localhost/api/majors/map", {
        action: "validate-plan", student, plan: selectedPlan, plans: economics.economicsPlans,
        edit: { type: "move", fromTermId: "winter-2027", courseId: "eco-214", toTermId: "winter-2028" }
      });
      assert.equal(response.status, 200, JSON.stringify(data));
      selectedPlan = data.plan;
    }
    const courseCode = instructor ? "ECO 213" : "ECO 461";
    const prerequisite = instructor ? "MAT 113" : "ECO 214";
    const term = instructor ? "Fall 2027" : "Winter 2028";
    const approver = /instructor/i.test(authority) ? `the ${courseCode} instructor` : `the ${authority}`;
    const message = `Taking ${prerequisite} and ${courseCode} together in ${term} needs approval from ${approver} before you register.`;
    assert.equal(selectedPlan.feasibilityStatus, "CONDITIONALLY_FEASIBLE");
    const course = selectedPlan.terms.flatMap(term => term.courses).find(course => course.course === courseCode);
    assert.ok(course.approvalRequired.some(item => item.authority === authority && item.prerequisite === prerequisite));
    const condition = selectedPlan.planConditions.find(item => item.kind === "approval" && item.course === courseCode);
    assert.equal(condition.message, message);
    assert.equal(condition.authority, authority);
    assert.equal(condition.prerequisite, prerequisite);
    assert.ok(selectedPlan.majorRequirementsChecklist.rows.find(row => row.course === courseCode || row.id === course.requirementId).markers.includes("Approval needed"));
    const original = structuredClone(selectedPlan);
    const json = await reportJson(student, selectedPlan);
    const html = await reportHtml(student, selectedPlan);
    const pdfRequest = await reportPdf(student, selectedPlan);
    assert.ok(json.planConditions.some(item => item.message === message));
    assert.match(html, new RegExp(`data-approval-authority="${authority}" data-approval-prerequisite="${prerequisite}">Approval needed</span>`));
    assert.ok(html.includes(message));
    assert.ok(!html.includes("Advisor approval needed"));
    const expected = projectSelectedPlanArtifact(selectedPlan, { advisorNotices: json.catalog?.advisorAttention || [] });
    assert.deepEqual(projectionMismatches(expected, projectReportJsonArtifact(json)), []);
    assert.deepEqual(projectionMismatches(expected, projectReportHtmlArtifact(html)), []);
    assert.deepEqual(projectionMismatches(expected, projectPdfCreatorRequestArtifact(pdfRequest)), []);
    assert.equal(pdfRequest.html, html);
    assert.deepEqual(selectedPlan, original, "Presentation must not mutate approval evidence or academic decisions.");
  });
}
