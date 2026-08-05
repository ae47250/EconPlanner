import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { POST as majorPost } from "../app/api/majors/map/route.js";
import {
  handleEconomicsReportRequest,
  POST as reportPost
} from "../app/api/reports/economics/route.js";
import { createPdfFromHtml } from "../lib/pdf-creation-client.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import {
  economics257Roles,
  projectReportHtmlArtifact,
  projectReportJsonArtifact,
  projectSelectedPlanArtifact,
  projectionMismatches
} from "../tests/oracle/economics-artifact-projection.js";

const ROOT = process.cwd();
const FIXTURE_PATH = path.join(ROOT, "tests", "fixtures", "pdf-layout-profiles.v1.json");
const TEMPLATE_PATH = path.join(ROOT, "templates", "econplannertemplate.html");
const FAILURE_ARTIFACT_ROOT = path.join(ROOT, "output", "economics-pdf-verification");
const cli = parseCliArguments(process.argv.slice(2));
const liveRequested = cli.mode === "live";
const outputPath = cli.output ? path.resolve(ROOT, cli.output) : null;
const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
const template = await readFile(TEMPLATE_PATH, "utf8");
const poppler = {
  pdftotext: resolveCommand("pdftotext"),
  pdftoppm: resolveCommand("pdftoppm")
};

const summary = {
  schemaVersion: 2,
  kind: "econplanner-nightly-pdf",
  generatedAt: new Date().toISOString(),
  command: "pnpm run verify:pdf:economics",
  classification: "external-contract-test",
  fixtureVersion: fixture.fixtureVersion,
  profiles: [],
  eco257: {},
  live: { requested: liveRequested, status: "not-run" },
  poppler: {
    pdftotext: Boolean(poppler.pdftotext),
    pdftoppm: Boolean(poppler.pdftoppm)
  },
  local: {
    configuration: "NOT_APPLICABLE",
    attempted: true,
    status: "NOT_ATTEMPTED"
  },
  hosted: {
    configuration: liveRequested ? "NOT_CONFIGURED" : "NOT_APPLICABLE",
    attempted: false,
    status: "SKIPPED",
    gateStatus: liveRequested ? "AMBER" : "GREEN"
  },
  retainedArtifacts: []
};

const verificationStartedAt = performance.now();

try {
  validateFixture(fixture);
  console.log(`[fixture] PASS ${fixture.profiles.length} fictional PDF layout profiles validated`);

  const preparedProfiles = new Map();
  for (const profile of fixture.profiles) {
    const prepared = await prepareProfile(profile, fixture.preparedDate, template);
    validateProfileExpectations(profile, prepared.projection);
    preparedProfiles.set(profile.id, prepared);
    summary.profiles.push({
      id: profile.id,
      status: "pass",
      planId: prepared.projection.selectedPlanId,
      academicYears: new Set(prepared.projection.terms.map(term => term.academicYear)).size,
      courses: prepared.projection.terms.flatMap(term => term.courses).length,
      warnings: prepared.projection.warnings.length,
      approvals: prepared.projection.terms.flatMap(term => term.courses.flatMap(course => course.approvals)).length
    });
    console.log(`[projection] PASS ${profile.id}`);
  }

  validateEco257Profiles(preparedProfiles);
  summary.eco257.validStatistics = "pass";
  console.log("[ECO 257] PASS valid fixtures identify ECO 257 only as statistics");

  await validateInvalidSelectedPlans(fixture, preparedProfiles);
  summary.eco257.invalidElective = "rejected-before-hosted-call";
  summary.local = {
    ...summary.local,
    status: "PASSED",
    durationMs: roundDuration(performance.now() - verificationStartedAt),
    profiles: summary.profiles.length,
    textParity: "PASSED",
    invalidSelectedPlanChecks: "PASSED"
  };
  console.log("[ECO 257] PASS invalid elective fixture rejected with 422 SELECTED_PLAN_INVALID before PDF service access");

  if (!liveRequested) {
    summary.live = {
      requested: false,
      status: "skipped",
      reason: "Use --live with explicitly configured PDF_CREATION_* test credentials."
    };
    summary.hosted = {
      configuration: "NOT_APPLICABLE",
      attempted: false,
      status: "SKIPPED",
      gateStatus: "GREEN"
    };
  } else {
    const configuration = liveConfiguration(process.env);
    if (!configuration.valid) {
      summary.live = {
        requested: true,
        status: "skipped",
        reason: `Missing or invalid configuration: ${configuration.missing.join(", ")}`
      };
      summary.hosted = {
        configuration: "NOT_CONFIGURED",
        attempted: false,
        status: "SKIPPED",
        gateStatus: "AMBER",
        missingConfiguration: configuration.missing
      };
    } else if (!poppler.pdftotext || !poppler.pdftoppm) {
      summary.live = {
        requested: true,
        status: "skipped",
        reason: `Poppler tools required before the hosted call: ${[
          !poppler.pdftotext ? "pdftotext" : null,
          !poppler.pdftoppm ? "pdftoppm" : null
        ].filter(Boolean).join(", ")}`
      };
      summary.hosted = {
        configuration: "CONFIGURED",
        attempted: false,
        status: "SKIPPED",
        gateStatus: "AMBER",
        missingTools: [!poppler.pdftotext ? "pdftotext" : null, !poppler.pdftoppm ? "pdftoppm" : null].filter(Boolean)
      };
    } else {
      summary.hosted = {
        configuration: "CONFIGURED",
        attempted: true,
        status: "NOT_ATTEMPTED",
        gateStatus: "RED"
      };
      const liveResults = [];
      for (const profile of fixture.profiles) {
        const result = await runLiveProfile(profile, preparedProfiles.get(profile.id), poppler);
        liveResults.push(result);
        console.log(`[live] PASS ${profile.id}: ${result.pageCount} pages, ${result.pdfBytes} bytes`);
      }
      summary.live = { requested: true, status: "pass", profiles: liveResults };
      summary.hosted = {
        configuration: "CONFIGURED",
        attempted: true,
        status: "PASSED",
        gateStatus: "GREEN",
        profiles: liveResults,
        durationMs: liveResults.reduce((sum, profile) => sum + profile.durationMs, 0),
        pdfBytes: liveResults.reduce((sum, profile) => sum + profile.pdfBytes, 0),
        pages: liveResults.reduce((sum, profile) => sum + profile.pageCount, 0),
        textParity: "PASSED",
        clipping: "PASSED"
      };
    }
  }

  if (summary.live.status === "skipped") console.log(`[live] SKIPPED ${summary.live.reason}`);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (error?.artifactDirectory) summary.retainedArtifacts.push(error.artifactDirectory);
  console.error(`[external-contract] FAIL ${safeErrorMessage(error)}`);
  if (summary.retainedArtifacts.length) {
    console.error(`[artifacts] Retained failure evidence: ${summary.retainedArtifacts.join(", ")}`);
  }
  summary.failure = { message: safeErrorMessage(error), evidence: summary.retainedArtifacts };
  if (summary.hosted.attempted) {
    summary.hosted.status = "FAILED";
    summary.hosted.gateStatus = "RED";
  } else {
    summary.local.status = "FAILED";
  }
  process.exitCode = 1;
} finally {
  summary.durationMs = roundDuration(performance.now() - verificationStartedAt);
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
}

async function prepareProfile(profile, defaultPreparedDate, htmlTemplate) {
  const preparedDate = profile.preparedDate || defaultPreparedDate;
  const economics = await generateEconomics(profile.student);
  const selectedPlan = structuredClone(economics.economicsPlans.find(plan => plan.id === profile.selectedPlanId));
  invariant(selectedPlan, `${profile.id}: selected plan ${profile.selectedPlanId} was not generated.`);
  applySelectedPlanMutations(selectedPlan, profile.selectedPlanMutations || [], profile.id);

  const report = await requestReportJson(profile.student, selectedPlan, preparedDate);
  let html = await requestReportHtml(profile.student, selectedPlan, preparedDate);
  let expected = projectSelectedPlanArtifact(selectedPlan, {
    advisorNotices: report.catalog?.advisorAttention || []
  });
  let jsonProjection = projectReportJsonArtifact(report);

  assertNoMismatches(`${profile.id}: selected plan to JSON`, expected, jsonProjection);

  if (profile.layoutMutations) {
    applyLayoutMutations(report, profile.layoutMutations);
    html = renderEconomicsHtml(report, htmlTemplate);
    expected = projectReportJsonArtifact(report);
    jsonProjection = expected;
  }

  const htmlProjection = projectReportHtmlArtifact(html);
  assertNoMismatches(`${profile.id}: JSON to HTML`, jsonProjection, htmlProjection);
  invariant(htmlProjection.selectedPlanId === profile.selectedPlanId, `${profile.id}: HTML selected a different plan.`);

  return { profile, economics, selectedPlan, report, html, projection: htmlProjection, preparedDate };
}

function applySelectedPlanMutations(selectedPlan, mutations, profileId) {
  for (const mutation of mutations) {
    const matches = selectedPlan.terms.flatMap(term => term.courses)
      .filter(course => course.requirementId === mutation.requirementId);
    invariant(matches.length === 1, `${profileId}: expected one ${mutation.requirementId} placement to mutate.`);
    const previousCourse = matches[0].course;
    Object.assign(matches[0], structuredClone(mutation.replacement), {
      requirementId: mutation.requirementId
    });
    for (const container of [selectedPlan, selectedPlan.feasibility]) {
      if (!container) continue;
      for (const field of ["warnings", "studentMessages"]) {
        container[field] = (container[field] || []).map(message => (
          String(message).replaceAll(previousCourse, mutation.replacement.course)
        ));
      }
    }
  }
}

async function generateEconomics(student) {
  const response = await majorPost(jsonRequest("http://localhost/api/majors/map", { student }));
  const data = await response.json();
  invariant(response.status === 200, `Planner generation failed with HTTP ${response.status}.`);
  const economics = data.programs?.find(program => program.program?.id === "economics-base");
  invariant(economics?.economicsPlans?.length, "Planner generation returned no Economics plans.");
  return economics;
}

async function requestReportJson(student, selectedPlan, preparedDate) {
  const response = await reportPost(jsonRequest("http://localhost/api/reports/economics", {
    student,
    selectedPlan,
    preparedDate,
    format: "json"
  }));
  const data = await response.json();
  invariant(response.status === 200, `Report JSON failed with HTTP ${response.status}.`);
  return data;
}

async function requestReportHtml(student, selectedPlan, preparedDate) {
  const response = await reportPost(jsonRequest("http://localhost/api/reports/economics", {
    student,
    selectedPlan,
    preparedDate,
    format: "html"
  }));
  const html = await response.text();
  invariant(response.status === 200, `Report HTML failed with HTTP ${response.status}.`);
  return html;
}

function applyLayoutMutations(report, mutations) {
  for (const mutation of mutations.availability || []) {
    const reportCourse = findCourse(report.terms, mutation, "code");
    const selectedCourse = findCourse(report.selectedPlan?.terms || [], mutation, "course");
    invariant(reportCourse && selectedCourse, `Layout mutation could not find ${mutation.course}-${mutation.section}.`);
    reportCourse.availability = structuredClone(mutation.value);
    selectedCourse.availability = structuredClone(mutation.value);
  }
  report.selectedPlan.warnings = [
    ...(report.selectedPlan.warnings || []),
    ...(mutations.warnings || [])
  ];
}

function findCourse(terms, expected, courseField) {
  const term = terms.find(item => (
    item.academicYear === expected.academicYear
    && normalizedTerm(item.termKey || item.term) === normalizedTerm(expected.term)
  ));
  return term?.courses?.find(course => (
    course[courseField] === expected.course
    && String(course.section || "") === String(expected.section || "")
  ));
}

function validateProfileExpectations(profile, projection) {
  const courses = projection.terms.flatMap(term => term.courses);
  const years = new Set(projection.terms.map(term => term.academicYear));
  const approvals = courses.flatMap(course => course.approvals);
  const expectations = profile.expectations;

  invariant(years.size >= expectations.minimumAcademicYears, `${profile.id}: too few academic years.`);
  invariant(courses.length >= expectations.minimumCourses, `${profile.id}: too few planned courses.`);
  invariant(projection.warnings.length >= expectations.minimumWarnings, `${profile.id}: too few warnings.`);
  invariant(approvals.length >= expectations.minimumApprovals, `${profile.id}: too few approvals.`);
  for (const status of expectations.requiredAvailabilityStates) {
    invariant(courses.some(course => course.availabilityState === status), `${profile.id}: missing ${status} availability.`);
  }
  for (const expected of expectations.requiredCourseRoles) {
    invariant(
      courses.some(course => course.code === expected.course && course.requirementRole === expected.role),
      `${profile.id}: ${expected.course} is not assigned to ${expected.role}.`
    );
  }
}

function validateEco257Profiles(preparedProfiles) {
  let foundStatisticsFixture = false;
  for (const prepared of preparedProfiles.values()) {
    const roles = economics257Roles(prepared.projection);
    if (roles.length) foundStatisticsFixture = true;
    invariant(roles.every(role => role === "statistics"), `${prepared.profile.id}: ECO 257 has a non-statistics role.`);
  }
  invariant(foundStatisticsFixture, "No valid ECO 257 statistics fixture was generated.");
}

async function validateInvalidSelectedPlans(currentFixture, preparedProfiles) {
  for (const invalidCase of currentFixture.invalidSelectedPlanCases) {
    const base = preparedProfiles.get(invalidCase.baseProfileId);
    invariant(base, `${invalidCase.id}: base profile is unavailable.`);
    const forged = structuredClone(base.selectedPlan);
    const target = forged.terms.flatMap(term => term.courses)
      .find(course => String(course.requirementId || "").startsWith(invalidCase.targetRequirementPrefix));
    invariant(target, `${invalidCase.id}: no target elective was available.`);
    Object.assign(target, structuredClone(invalidCase.replacement));
    delete target.alternativeOptions;
    delete target.selectedOptionId;

    let hostedCalls = 0;
    const response = await handleEconomicsReportRequest(jsonRequest("http://localhost/api/reports/economics", {
      student: base.profile.student,
      selectedPlan: forged,
      preparedDate: base.preparedDate,
      format: "pdf"
    }), {
      environment: {
        PDF_CREATION_ENABLED: "true",
        PDF_CREATION_API_URL: "https://pdf-creator.invalid",
        PDF_CREATION_API_KEY: "x".repeat(43)
      },
      fetchImpl: async () => {
        hostedCalls += 1;
        throw new Error("Invalid selected plans must not reach the hosted service.");
      }
    });
    const data = await response.json();
    invariant(response.status === invalidCase.expectedStatus, `${invalidCase.id}: expected HTTP ${invalidCase.expectedStatus}.`);
    invariant(data.code === invalidCase.expectedCode, `${invalidCase.id}: expected ${invalidCase.expectedCode}.`);
    invariant(hostedCalls === 0, `${invalidCase.id}: reached the hosted PDF service.`);
  }
}

async function runLiveProfile(profile, prepared, tools) {
  const workDirectory = await mkdtemp(path.join(tmpdir(), `econplanner-pdf-${safeFileName(profile.id)}-`));
  const startedAt = Date.now();
  const benchmark = { profileId: profile.id, startedAt: new Date(startedAt).toISOString() };
  try {
    let pdf;
    let headers;
    let httpResult;
    if (profile.executionMode === "report-route" && !profile.layoutMutations) {
      const response = await handleEconomicsReportRequest(jsonRequest("http://localhost/api/reports/economics", {
        student: profile.student,
        selectedPlan: prepared.selectedPlan,
        preparedDate: prepared.preparedDate,
        format: "pdf"
      }), { environment: process.env });
      invariant(response.status === 200, `${profile.id}: hosted route returned HTTP ${response.status}.`);
      httpResult = { status: response.status, contentType: response.headers.get("content-type") };
      headers = verifyHttpHeaders(response.headers);
      pdf = new Uint8Array(await response.arrayBuffer());
    } else {
      const result = await createPdfFromHtml(
        { html: prepared.html, filename: `EconPlanner-${safeFileName(profile.id)}.pdf` },
        { environment: process.env }
      );
      headers = verifyDiagnosticHeaders(result.diagnostics);
      pdf = result.pdf;
      httpResult = { status: 200, transport: "pdf-creation-client" };
    }

    const pdfPath = path.join(workDirectory, `${safeFileName(profile.id)}.pdf`);
    await writeFile(pdfPath, pdf);
    verifyPdfBytes(pdf, headers.sha256);
    const inspection = await inspectWithPoppler(pdfPath, workDirectory, prepared.projection, headers.pageCount, tools);
    Object.assign(benchmark, {
      status: "pass",
      durationMs: Date.now() - startedAt,
      pdfBytes: pdf.byteLength,
      pageCount: headers.pageCount,
      renderedPages: inspection.renderedPages
    });
    return {
      id: profile.id,
      pageCount: headers.pageCount,
      pdfBytes: pdf.byteLength,
      durationMs: benchmark.durationMs,
      httpResult,
      textProjection: "pass",
      clippingBounds: "pass",
      renderedPages: inspection.renderedPages
    };
  } catch (error) {
    Object.assign(benchmark, {
      status: "fail",
      durationMs: Date.now() - startedAt,
      failure: safeErrorMessage(error)
    });
    await writeFile(path.join(workDirectory, "benchmark.json"), `${JSON.stringify(benchmark, null, 2)}\n`);
    const artifactDirectory = await retainFailureArtifacts(profile.id, workDirectory);
    error.artifactDirectory = artifactDirectory;
    throw error;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function verifyHttpHeaders(headers) {
  invariant(headers.get("content-type")?.toLowerCase().startsWith("application/pdf"), "PDF content type is invalid.");
  invariant(headers.get("cache-control") === "no-store", "PDF response is missing Cache-Control: no-store.");
  invariant(headers.get("x-content-type-options") === "nosniff", "PDF response is missing nosniff protection.");
  invariant(/attachment/i.test(headers.get("content-disposition") || ""), "PDF response is not an attachment.");
  return verifyDiagnosticHeaders({
    "X-PDF-Request-Id": headers.get("x-pdf-request-id"),
    "X-PDF-Caller": headers.get("x-pdf-caller"),
    "X-PDF-Page-Count": headers.get("x-pdf-page-count"),
    "X-PDF-SHA256": headers.get("x-pdf-sha256"),
    "X-PDF-Duration-Ms": headers.get("x-pdf-duration-ms"),
    "X-PDF-Report-Id": headers.get("x-pdf-report-id")
  });
}

function verifyDiagnosticHeaders(diagnostics) {
  invariant(diagnostics?.["X-PDF-Request-Id"], "Missing X-PDF-Request-Id.");
  invariant(diagnostics?.["X-PDF-Caller"] === "econplanner", "Unexpected X-PDF-Caller.");
  invariant(/^\d+$/.test(diagnostics?.["X-PDF-Page-Count"] || ""), "Invalid X-PDF-Page-Count.");
  invariant(/^[0-9a-f]{64}$/.test(diagnostics?.["X-PDF-SHA256"] || ""), "Invalid X-PDF-SHA256.");
  invariant(/^\d+$/.test(diagnostics?.["X-PDF-Duration-Ms"] || ""), "Invalid X-PDF-Duration-Ms.");
  invariant(/^r(?:1|7|30)_[0-9a-f-]+$/i.test(diagnostics?.["X-PDF-Report-Id"] || ""), "Invalid X-PDF-Report-Id.");
  return {
    pageCount: Number(diagnostics["X-PDF-Page-Count"]),
    sha256: diagnostics["X-PDF-SHA256"]
  };
}

function verifyPdfBytes(pdf, expectedSha256) {
  invariant(pdf.byteLength > 5, "PDF response is empty.");
  invariant(new TextDecoder().decode(pdf.subarray(0, 5)) === "%PDF-", "PDF magic bytes are invalid.");
  const actualSha256 = createHash("sha256").update(pdf).digest("hex");
  invariant(actualSha256 === expectedSha256, "PDF SHA-256 does not match the integrity header.");
}

async function inspectWithPoppler(pdfPath, workDirectory, projection, expectedPageCount, tools) {
  const textPath = path.join(workDirectory, "extracted.txt");
  const bboxPath = path.join(workDirectory, "bounding-boxes.html");
  runCommand(tools.pdftotext, ["-layout", "-enc", "UTF-8", pdfPath, textPath], "pdftotext");
  runCommand(tools.pdftotext, ["-bbox-layout", "-enc", "UTF-8", pdfPath, bboxPath], "pdftotext bbox");
  const extractedText = await readFile(textPath, "utf8");
  compareExtractedText(extractedText, projection);
  detectOutOfBoundsText(await readFile(bboxPath, "utf8"));

  const pagePrefix = path.join(workDirectory, "page");
  runCommand(tools.pdftoppm, ["-png", "-r", "144", pdfPath, pagePrefix], "pdftoppm");
  const pageFiles = (await readdir(workDirectory))
    .filter(name => /^page-\d+\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  invariant(pageFiles.length === expectedPageCount, `Rendered ${pageFiles.length} pages; expected ${expectedPageCount}.`);
  for (const pageFile of pageFiles) {
    const dimensions = pngDimensions(await readFile(path.join(workDirectory, pageFile)));
    invariant(dimensions.width >= 600 && dimensions.height >= 600, `${pageFile} has implausible dimensions.`);
  }
  return { renderedPages: pageFiles.length };
}

function compareExtractedText(extractedText, projection) {
  const haystack = normalizedText(extractedText);
  for (const expected of expectedPdfText(projection)) {
    const found = haystack.includes(normalizedText(expected.value))
      || (expected.label === "title" && containsTokensInOrder(extractedText, expected.value));
    invariant(found, `PDF text is missing ${expected.label}: ${expected.value}`);
  }
  const eco257 = projection.terms.flatMap(term => term.courses).filter(course => course.code === "ECO 257");
  for (const course of eco257) {
    invariant(course.requirementRole === "statistics", "ECO 257 is not statistics in the expected projection.");
  }
  if (eco257.length) {
    invariant(
      /eco 257.{0,240}requirement: statistics requirement/i.test(haystack),
      "PDF text does not label ECO 257 as the statistics requirement."
    );
  }
}

function containsTokensInOrder(text, expected) {
  const textTokens = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const expectedTokens = String(expected || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  let expectedIndex = 0;
  for (const token of textTokens) {
    if (token === expectedTokens[expectedIndex]) expectedIndex += 1;
    if (expectedIndex === expectedTokens.length) return true;
  }
  return expectedTokens.length === 0;
}

function expectedPdfText(projection) {
  const expected = [
    { label: "selected plan ID", value: projection.selectedPlanId },
    { label: "graduation target", value: projection.graduationTarget },
    { label: "feasibility status", value: projection.feasibilityStatus.replaceAll("_", " ") }
  ];
  for (const term of projection.terms) {
    expected.push({ label: "academic year", value: term.academicYear });
    expected.push({ label: "term", value: term.term });
    for (const course of term.courses) {
      expected.push({ label: "course", value: course.code });
      if (course.section) expected.push({ label: "section", value: `${course.code}-${course.section}` });
      expected.push({ label: "title", value: course.title });
      expected.push({ label: "requirement role", value: requirementLabel(course.requirementRole) });
      if (course.availabilityState) expected.push({ label: "availability", value: course.availabilityState });
      for (const approval of course.approvals) {
        expected.push({
          label: "approval",
          value: `${approval.authority} approval for concurrent ${approval.prerequisite}`
        });
      }
    }
  }
  for (const warning of projection.warnings) expected.push({ label: "warning", value: warning });
  for (const notice of projection.advisorAttention) expected.push({ label: "advisor attention", value: notice.message });
  return expected.filter(item => item.value);
}

function requirementLabel(requirementId) {
  const value = String(requirementId || "").trim();
  if (!value) return "Requirement";
  if (value === "statistics") return "Statistics requirement";
  if (value === "finance") return "Finance requirement";
  if (value.startsWith("eco-elective")) return "ECO elective";
  if (value.startsWith("supporting-elective")) return "Supporting-course elective";
  const course = value.match(/^([a-z]+)-(\d{3})$/i);
  return course ? `${course[1].toUpperCase()} ${course[2]} requirement` : `${value.replaceAll("-", " ")} requirement`;
}

function detectOutOfBoundsText(bboxHtml) {
  const pagePattern = /<page[^>]+width="([0-9.]+)"[^>]+height="([0-9.]+)"[^>]*>([\s\S]*?)<\/page>/gi;
  let pages = 0;
  for (const page of String(bboxHtml).matchAll(pagePattern)) {
    pages += 1;
    const width = Number(page[1]);
    const height = Number(page[2]);
    const wordPattern = /<word[^>]+xMin="([0-9.-]+)"[^>]+yMin="([0-9.-]+)"[^>]+xMax="([0-9.-]+)"[^>]+yMax="([0-9.-]+)"/gi;
    for (const word of page[3].matchAll(wordPattern)) {
      const [xMin, yMin, xMax, yMax] = word.slice(1).map(Number);
      invariant(xMin >= -0.5 && yMin >= -0.5 && xMax <= width + 0.5 && yMax <= height + 0.5, "PDF text extends beyond a page boundary.");
    }
  }
  invariant(pages > 0, "pdftotext did not return page bounding boxes.");
}

function pngDimensions(bytes) {
  invariant(bytes.byteLength >= 24, "Rendered PNG is too small.");
  const signature = Buffer.from(bytes.subarray(0, 8)).toString("hex");
  invariant(signature === "89504e470d0a1a0a", "Rendered page is not a PNG.");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function retainFailureArtifacts(profileId, workDirectory) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const destination = path.join(FAILURE_ARTIFACT_ROOT, `${timestamp}-${safeFileName(profileId)}`);
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(workDirectory)) {
    await copyFile(path.join(workDirectory, name), path.join(destination, name));
  }
  return path.relative(ROOT, destination);
}

function validateFixture(value) {
  invariant(value?.schemaVersion === 1, "Fixture schemaVersion must be 1.");
  invariant(value?.fixtureVersion === "pdf-layout-profiles.v1", "Unexpected fixture version.");
  invariant(value?.dataClassification === "fictional-test-only", "Fixture is not marked fictional-test-only.");
  invariant(value?.externalContractTest === true, "Fixture is not marked as an external contract test.");
  invariant(Array.isArray(value.profiles) && value.profiles.length >= 3, "At least three fictional profiles are required.");
  invariant(Array.isArray(value.invalidSelectedPlanCases) && value.invalidSelectedPlanCases.length > 0, "An invalid selected-plan fixture is required.");
  invariant(!/@/.test(JSON.stringify(value)), "Fixture contains an email-like value.");
  const forbiddenKeys = /^(student_?id|email|transcript|real_?name|schedule)$/i;
  walk(value, (key) => invariant(!forbiddenKeys.test(key), `Fixture contains forbidden key: ${key}`));
  const ids = new Set();
  for (const profile of value.profiles) {
    invariant(profile.id && !ids.has(profile.id), "Profile IDs must be present and unique.");
    ids.add(profile.id);
    invariant(/^Fictional\b/.test(profile.student?.displayName || ""), `${profile.id}: displayName must be explicitly fictional.`);
    invariant(["report-route", "rendered-html"].includes(profile.executionMode), `${profile.id}: invalid executionMode.`);
    invariant(profile.selectedPlanId, `${profile.id}: selectedPlanId is required.`);
    invariant(profile.expectations, `${profile.id}: expectations are required.`);
    for (const mutation of profile.selectedPlanMutations || []) {
      invariant(mutation.requirementId, `${profile.id}: selected-plan mutation requirementId is required.`);
      invariant(mutation.replacement?.course, `${profile.id}: selected-plan mutation course is required.`);
    }
  }
}

function walk(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    visitor(key, item);
    walk(item, visitor);
  }
}

function liveConfiguration(environment) {
  const missing = [];
  if (environment.PDF_CREATION_ENABLED !== "true") missing.push("PDF_CREATION_ENABLED=true");
  if (!environment.PDF_CREATION_API_KEY || environment.PDF_CREATION_API_KEY.length < 32) missing.push("PDF_CREATION_API_KEY");
  try {
    const url = new URL(environment.PDF_CREATION_API_URL);
    if (url.protocol !== "https:") missing.push("PDF_CREATION_API_URL=https://...");
  } catch {
    missing.push("PDF_CREATION_API_URL");
  }
  return { valid: missing.length === 0, missing: [...new Set(missing)] };
}

function resolveCommand(command) {
  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", [command], { encoding: "utf8" });
  if (lookup.status !== 0) return null;
  const matches = lookup.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  return (process.platform === "win32" ? matches.find(item => /\.exe$/i.test(item)) : matches[0])
    || matches[0]
    || null;
}

function runCommand(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    windowsHide: true
  });
  invariant(result.status === 0, `${label} failed: ${String(result.stderr || "unknown error").trim()}`);
}

function assertNoMismatches(label, expected, actual) {
  const mismatches = projectionMismatches(expected, actual);
  invariant(mismatches.length === 0, `${label} mismatch: ${JSON.stringify(mismatches.slice(0, 5))}`);
}

function jsonRequest(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function normalizedTerm(value) {
  const term = String(value || "").toLowerCase();
  if (term.startsWith("spring") || term.startsWith("may")) return "spring";
  return term;
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function safeFileName(value) {
  return String(value || "profile").replace(/[^a-z0-9._-]+/gi, "-");
}

function safeErrorMessage(error) {
  return String(error?.message || "Unknown verification failure").replace(/[\r\n]+/g, " ");
}

function parseCliArguments(argv) {
  let requestedMode = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--dry-run" || argument === "--live") {
      const nextMode = argument.slice(2);
      invariant(!requestedMode || requestedMode === nextMode, "Choose either --dry-run or --live, not both.");
      requestedMode = nextMode;
      continue;
    }
    if (argument === "--output") {
      output = argv[index + 1];
      invariant(output && !output.startsWith("--"), "--output requires a path.");
      index += 1;
      continue;
    }
    invariant(false, `Unknown argument: ${argument}`);
  }
  return { mode: requestedMode || "dry-run", output };
}

function roundDuration(value) {
  return Math.round(Number(value) * 100) / 100;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
