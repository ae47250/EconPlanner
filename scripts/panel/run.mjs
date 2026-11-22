import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";
import { resolvePlanningContext, buildPlanningSlots } from "../../lib/planning/horizon.js";
import { runtimePolicyBundle } from "../../lib/policy/compat-normalized.js";
import { termLoadRule } from "../../lib/policy/term-load.js";
import { buildEconomicsReportFromStudent } from "../../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../../lib/reports/economics-html.js";

const root = process.cwd();
const data = JSON.parse(await readFile(path.join(root, "tests/panel/students.json"), "utf8"));
const template = await readFile(path.join(root, "templates/econplannertemplate.html"), "utf8");
const policyBundle = runtimePolicyBundle();
const storageKey = "econ-planner-ui-state";
const runningCheck = process.argv.includes("--check");
const generatedDirIndex = process.argv.indexOf("--generated-dir");
const suppliedGeneratedDir = generatedDirIndex >= 0 ? process.argv[generatedDirIndex + 1] : null;
if (generatedDirIndex >= 0 && (!runningCheck || !suppliedGeneratedDir)) throw new Error("--generated-dir requires --check and a directory");
const targetDir = suppliedGeneratedDir ? path.resolve(suppliedGeneratedDir)
  : runningCheck ? await mkdtemp(path.join(os.tmpdir(), "econplanner-panel-")) : path.join(root, "tests/panel");
const snapshotsDir = path.join(targetDir, "snapshots");
const plansDir = path.join(targetDir, "plans");
if (!suppliedGeneratedDir) {
  await mkdir(snapshotsDir, { recursive: true });
  await mkdir(plansDir, { recursive: true });
}
const traceRules = new Map();
const traceReasons = new Map();
const traceMessages = new Map();
const traceSources = new Map();
const untraced = new Map();
const couldNotDrive = [];
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("ECONPLANNER_DECISION_SHADOW ")) return;
  originalConsoleLog(...args);
};
const originalConsoleInfo = console.info.bind(console);
console.info = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("ECONPLANNER_DECISION_SHADOW ")) return;
  originalConsoleInfo(...args);
};
const sourceForSection = {
  SCREEN: { file: "app/page.js", function: "PlanComparisonScreen" },
  PDF: { file: "lib/reports/economics-html.js", function: "renderEconomicsHtml" }
};
const sorted = values => [...new Set(values)].sort((a, b) => a.localeCompare(b, "en-US", { numeric: true }));
const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();

function expandCodes(profile) {
  const base = profile.set ? data.courseSets[profile.set] : [];
  return sorted([...(base || []), ...(profile.courses || [])]);
}

function prepareProfile(profile) {
  const planDate = profile.planDate || "2026-11-22";
  const courses = expandCodes(profile).map(code => {
    const status = (profile.now || []).includes(code) ? "in_progress"
      : (profile.transfer || []).includes(code) ? "transfer" : "completed";
    return {
      code,
      title: code,
      status,
      units: "1",
      grade: "",
      source: (profile.ap || []).includes(code) ? "ap_credit"
        : (profile.transfer || []).includes(code) ? "transfer_credit" : "manual_code",
      notes: ""
    };
  });
  const student = {
    displayName: `Panel Student ${profile.id}`,
    academicStanding: profile.standing,
    planningPace: profile.pace || "standard",
    planCreationDate: planDate,
    planCreationDateEdited: true,
    isTransferStudent: Boolean(profile.transferStudent),
    customGraduationEnabled: Boolean(profile.customYear),
    customExpectedGraduationYear: profile.customYear ? String(profile.customYear) : "",
    transferExpectedGraduationYear: profile.transferYear ? String(profile.transferYear) : "",
    transferEntryAcademicYear: profile.entryYear ? String(profile.entryYear) : "",
    expectedGraduationTerm: "",
    courses,
    reservedCourseUnits: {},
    termLoadOverrides: {},
    reservationMemory: {},
    scheduleSetByTerm: {},
    studyAbroadTerm: profile.abroad || "",
    studyAbroadMayOverlap: Boolean(profile.abroadMay),
    studyAbroadDestination: "",
    studyAbroadAdvisingNote: "",
    advisorApprovals: ""
  };
  const context = resolvePlanningContext(student);
  const slots = buildPlanningSlots(context);
  if (profile.reserveWinter) student.reservedCourseUnits["winter-2027"] = Number(profile.reserveWinter);
  if (profile.reserveAll === "max") {
    for (const slot of slots) {
      const rule = termLoadRule(policyBundle, { termKey: slot.termKey });
      student.reservedCourseUnits[slot.id] = Number(rule?.effect?.normalCourseUnits ?? rule?.effect?.maxTotalCourses ?? 0);
    }
  }
  if (profile.overload) {
    const overloadTerm = String(profile.overload).toLowerCase().replace(/^(\d{4})-(winter|fall)$/, (_, year, term) => `${term}-${year}`);
    student.termLoadOverrides[overloadTerm] = {
      advisorApproval: "APPROVED",
      academicProbationStatus: "NOT_ON_ACADEMIC_PROBATION"
    };
  }
  if (profile.scheduleSet) {
    const current = slots.find(slot => slot.isCurrent || slot.status === "CURRENT") || slots[0];
    if (current) student.scheduleSetByTerm[current.id] = true;
  }
  return student;
}

function toSentences(value) {
  return value.split(/\r?\n/).flatMap(line => line.split(/(?<=[.!?])\s+(?=[A-Z0-9“])/))
    .map(normalize)
    .filter(Boolean);
}

function planStatus(plan) {
  const readiness = plan?.readinessStatus || plan?.validation?.readinessStatus || "";
  const disposition = plan?.planDisposition || plan?.validation?.planDisposition || "";
  if (readiness === "ADVISOR_ACTION_REQUIRED" || disposition.includes("ADVISOR_ACTION_REQUIRED")) return "Needs advisor attention";
  if (readiness === "READY_WITH_CONDITIONS" || disposition.includes("READY_WITH_CONDITIONS")) return "Needs confirmation";
  if (readiness === "STUDENT_READY" || disposition.includes("STUDENT_READY")) return "Ready to plan";
  return "Needs advisor attention";
}

function planArtifact(profile, overallStatus, plans, payload) {
  return {
    studentId: profile.id,
    planDate: profile.planDate || "2026-11-22",
    overallStatus,
    resultCategory: (payload.programs || []).find(item => item.economicsPlanResult)?.economicsPlanResult?.category || null,
    plans: plans.map(plan => ({
      id: plan.id,
      name: plan.label,
      status: planStatus(plan),
      feasibilityStatus: plan.feasibilityStatus || null,
      readinessStatus: plan.readinessStatus || null,
      terms: (plan.terms || []).map(term => ({
        termId: term.slotId || term.term,
        term: term.displayTerm || term.term,
        academicYear: term.academicYear || null,
        courses: (term.courses || []).map(course => ({
          course: course.course,
          title: course.title || null,
          section: course.section || null,
          status: course.fixedInProgress ? "Taking now" : "Planned",
          requirementId: course.requirementId || null
        }))
      }))
    }))
  };
}

async function captureScreen(page, statusById) {
  return page.evaluate(statuses => {
    const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
    const lines = node => String(node?.innerText || "").split(/\r?\n/).map(clean).filter(Boolean);
    const sections = [];
    const add = (heading, values) => sections.push({ heading, lines: values.filter(Boolean) });
    const root = document.querySelector(".comparison-page");
    if (!root) throw new Error("The comparison screen did not render");
    const summary = [
      ...lines(root.querySelector(".comparison-topbar")),
      ...lines(root.querySelector(".comparison-course-status")),
      ...lines(root.querySelector(".comparison-heading-row")),
      ...lines(root.querySelector(".accelerated-result")),
      ...lines(root.querySelector(".comparison-difference-key"))
    ];
    add("SCREEN > Summary box", summary);

    for (const card of root.querySelectorAll(".comparison-plan-card")) {
      const name = clean(card.querySelector(".plan-title-row h2")?.innerText || card.dataset.planId);
      const prefix = `SCREEN > Plan: ${name}`;
      add(prefix, [`STATUS: ${statuses[card.dataset.planId] || "Needs advisor attention"}`, ...lines(card.querySelector(".comparison-plan-summary"))]);
      for (const child of card.children) {
        if (child.classList.contains("comparison-plan-summary")) continue;
        if (child.matches("table.compact-schedule")) {
          const grid = ["Year | Term | Courses"];
          let year = "";
          for (const row of child.querySelectorAll("tbody tr")) {
            year = clean(row.querySelector(".comparison-academic-year")?.innerText || year);
            const cells = [...row.children];
            const termCell = cells.find(cell => cell !== row.querySelector(".comparison-academic-year"));
            const courseCell = cells.at(-1);
            grid.push(`TERM: ${year} ${clean(termCell?.innerText)}`);
            const courseEntries = courseCell?.querySelectorAll(".comparison-editable-course") || [];
            if (!courseEntries.length) grid.push(`GRID ROW: ${clean(courseCell?.innerText)}`);
            for (const entry of courseEntries) {
              const code = clean(entry.querySelector(".plan-course-actions > button, .comparison-fixed-course strong")?.innerText
                || entry.querySelector(".comparison-course-controls")?.innerText || "");
              const title = clean(entry.querySelector(".comparison-course-title")?.innerText || "");
              grid.push(`GRID ROW: ${code}${title ? ` | ${title}` : ""}`);
              for (const note of entry.querySelectorAll(":scope > .comparison-course-meta > *")) {
                if (note.classList.contains("comparison-course-title")) continue;
                for (const text of lines(note)) grid.push(`NOTE: ${text}`);
              }
              for (const extra of entry.querySelectorAll(":scope > .comparison-course-controls > small")) {
                for (const text of lines(extra)) grid.push(`NOTE: ${text}`);
              }
            }
          }
          add(`${prefix} > Grid`, grid);
          continue;
        }
        if (child.classList.contains("comparison-plan-details")) {
          for (const detail of child.children) {
            if (detail.classList.contains("major-checklist")) {
              const heading = clean(detail.querySelector("summary")?.innerText || "Checklist");
              const content = [heading, "Requirement | Course / term | Status"];
              for (const row of detail.querySelectorAll("tbody tr")) content.push(`CHECKLIST ROW: ${clean(row.innerText)}`);
              const body = detail.querySelector(".comparison-disclosure-content");
              for (const node of body?.children || []) {
                if (node.tagName === "TABLE") continue;
                content.push(...lines(node));
              }
              add(`${prefix} > Checklist`, content);
            } else if (detail.tagName === "DETAILS") {
              const heading = clean(detail.querySelector(":scope > summary")?.innerText || "Notes");
              const content = [heading];
              for (const node of detail.children) if (node.tagName !== "SUMMARY") content.push(...lines(node));
              add(`${prefix} > Notes: ${heading}`, content);
            } else add(`${prefix} > Details`, lines(detail));
          }
          continue;
        }
        if (child.matches("section.plan-notes")) {
          const heading = clean(child.querySelector("h2, h3")?.innerText || "Notes");
          add(`${prefix} > Notes: ${heading}`, lines(child));
          continue;
        }
        add(`${prefix} > More`, lines(child));
      }
    }

    for (const child of root.querySelector(".comparison-content")?.children || []) {
      if (child.matches(".comparison-course-status, .comparison-heading-row, .accelerated-result, .comparison-difference-key, .comparison-grid")) continue;
      if (child.querySelector(".comparison-plan-card")) continue;
      const heading = clean(child.querySelector("summary, h2, h3")?.innerText || "Other details");
      add(`SCREEN > ${heading}`, lines(child));
    }
    return { sections, overallStatus: clean(root.querySelector(".result-status-value")?.innerText || "Not available") };
  }, statusById);
}

async function capturePdf(reportPage, html, planName) {
  await reportPage.setContent(html, { waitUntil: "domcontentloaded" });
  return reportPage.evaluate(name => {
    const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
    const lines = node => {
      if (!node) return [];
      const output = [];
      let current = "";
      const flush = () => { const line = clean(current); if (line) output.push(line); current = ""; };
      const boundaries = new Set(["ARTICLE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "OL", "P", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
      const visit = item => {
        if (item.nodeType === Node.TEXT_NODE) { current += item.textContent; return; }
        if (item.nodeType !== Node.ELEMENT_NODE || item.hidden || getComputedStyle(item).display === "none") return;
        if (item.tagName === "BR") { flush(); return; }
        const boundary = boundaries.has(item.tagName);
        if (boundary) flush();
        for (const child of item.childNodes) visit(child);
        if (boundary) flush();
      };
      visit(node);
      flush();
      return output;
    };
    const sections = [];
    const prefix = `PDF > Plan: ${name}`;
    const add = (heading, values) => sections.push({ heading, lines: values.filter(Boolean) });
    const main = document.querySelector(".sheet .plan-main");
    if (!main) throw new Error(`The HTML report for ${name} did not render`);
    for (const block of main.children) {
      if (block.classList.contains("schedule-card")) {
        const grid = [clean(block.querySelector("h2")?.innerText || "Your plan by term")];
        for (const header of block.querySelectorAll(".schedule thead th")) grid.push(`TABLE HEADER: ${clean(header.innerText)}`);
        const headers = [...block.querySelectorAll(".schedule thead th")].slice(1).map(header => clean(header.innerText));
        for (const row of block.querySelectorAll(".schedule tbody tr")) {
          const year = clean(row.querySelector("th")?.innerText);
          for (const [index, cell] of [...row.querySelectorAll("td")].entries()) {
            const term = clean(cell.dataset.scheduleTerm || headers[index] || "Term");
            grid.push(`TERM: ${year} ${term}`);
            const courses = cell.querySelectorAll(".course-entry");
            if (!courses.length) grid.push(`GRID ROW: ${clean(cell.innerText)}`);
            for (const course of courses) {
              grid.push(`GRID ROW: ${clean(course.querySelector(".course")?.innerText)}`);
              for (const note of course.children) {
                if (note.classList.contains("course") || note.classList.contains("cell-note")) continue;
                for (const text of lines(note)) grid.push(`NOTE: ${text}`);
              }
            }
          }
        }
        for (const node of block.querySelectorAll(".course-titles > *")) grid.push(...lines(node));
        for (const node of block.querySelectorAll(".seat-note")) grid.push(...lines(node));
        add(`${prefix} > Grid`, grid);
      } else if (block.classList.contains("checklist-section")) {
        const heading = clean(block.querySelector("h2")?.innerText || "Checklist");
        const content = [heading];
        for (const header of block.querySelectorAll("thead th")) content.push(`TABLE HEADER: ${clean(header.innerText)}`);
        for (const row of block.querySelectorAll("tbody tr")) {
          for (const cell of row.children) content.push(`CHECKLIST CELL: ${clean(cell.innerText)}`);
        }
        for (const child of block.children) {
          if (child.tagName === "H2" || child.tagName === "TABLE") continue;
          content.push(...lines(child));
        }
        add(`${prefix} > Checklist`, content);
      } else {
        const heading = clean(block.querySelector("h1, h2, h3")?.innerText || (block.classList.contains("report-header") ? "Header" : "Notes"));
        add(`${prefix} > ${heading}`, lines(block));
      }
    }
    const notes = document.querySelector(".sheet .plan-notes-section");
    if (notes) {
      add(`${prefix} > Plan Notes`, lines(notes.querySelector(":scope > header")));
      for (const card of notes.querySelectorAll(":scope > .note-card")) {
        const heading = clean(card.querySelector("h2")?.innerText || "Notes");
        add(`${prefix} > Notes: ${heading}`, lines(card));
      }
    }
    return sections;
  }, planName);
}

function snapshotText(screenSections, pdfSections) {
  return ["SCREEN", ...screenSections.flatMap(section => [section.heading, ...section.lines]),
    "PDF", ...pdfSections.flatMap(section => [section.heading, ...section.lines])].join("\n") + "\n";
}

function policyEvidence(payload, plans) {
  const output = [];
  const candidates = [
    ...(payload?.programs || []).flatMap(item => [item.economicsPlan, ...(item.economicsPlans || [])].filter(Boolean)),
    ...plans
  ];
  const seen = new Set();
  for (const plan of candidates) {
    const decisions = plan.validation?.policyDecision?.decisions || [];
    for (const decision of decisions) {
      const rules = decision.ruleIds || [];
      const sentence = String(decision.message || decision.messageText || "").trim();
      const reasonCodes = [decision.reasonCode, ...(decision.reasonCodes || [])].filter(Boolean);
      const messageKeys = decision.messageKeys || {};
      if (!rules.length && !sentence && !reasonCodes.length && !Object.values(messageKeys).length) continue;
      const key = `${rules.join(",")}|${reasonCodes.join(",")}|${JSON.stringify(messageKeys)}|${sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ rules, reasonCodes, messageKeys, sentence });
    }
    for (const value of (plan.validation?.warnings || [])) {
      if (value) output.push({ rules: [], sentence: String(value).trim() });
    }
    for (const notice of [...(plan.validation?.studentNotices || []), ...(plan.studentNotices || [])]) {
      const messageKeys = notice.messageKey ? { student: notice.messageKey } : {};
      if (notice.message) output.push({
        rules: notice.ruleIds || (notice.ruleId ? [notice.ruleId] : []),
        reasonCodes: [notice.reasonCode].filter(Boolean),
        messageKeys,
        sentence: String(notice.message).trim()
      });
    }
  }
  return output;
}

function recordTrace(section, sentence, evidence, studentId) {
  const templateMatches = [];
  for (const [messageKey, templateText] of Object.entries(policyBundle.messages || {})) {
    for (const fragment of toSentences(String(templateText))) {
      const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\w+\\\}/g, ".+?");
      if (new RegExp(`^${escaped}$`, "i").test(sentence)) templateMatches.push(messageKey);
    }
  }
  const match = evidence.find(item => item.sentence && (item.sentence === sentence || item.sentence.includes(sentence) || sentence.includes(item.sentence))
    || Object.values(item.messageKeys || {}).some(key => templateMatches.includes(key)));
  const matchedKeys = sorted([...templateMatches, ...Object.values(match?.messageKeys || {}), match?.messageKey].filter(Boolean));
  const matchedRules = new Set(match?.rules || []);
  for (const rule of policyBundle.rules || []) {
    if (Object.values(rule.messageKeys || {}).some(key => matchedKeys.includes(key))) matchedRules.add(rule.ruleId);
  }
  if (matchedKeys.length && (matchedRules.size || match?.reasonCodes?.length)) {
    for (const rule of matchedRules) {
      const messageKeys = policyBundle.indexes?.byRuleId?.[rule]?.messageKeys || {};
      const key = `${rule}|${JSON.stringify(messageKeys)}`;
      const record = traceRules.get(key) || { ruleId: rule, messageKeys, studentIds: [] };
      record.studentIds.push(studentId);
      traceRules.set(key, record);
    }
    for (const reasonCode of match?.reasonCodes || []) {
      const key = `${reasonCode}|${JSON.stringify(matchedKeys)}`;
      const record = traceReasons.get(key) || { reasonCode, messageKeys: matchedKeys, studentIds: [] };
      record.studentIds.push(studentId);
      traceReasons.set(key, record);
    }
    for (const messageKey of matchedKeys) {
      const record = traceMessages.get(messageKey) || { messageKey, studentIds: [] };
      record.studentIds.push(studentId);
      traceMessages.set(messageKey, record);
    }
    return;
  }
  if (matchedKeys.length) {
    for (const messageKey of matchedKeys) {
      const record = traceMessages.get(messageKey) || { messageKey, studentIds: [] };
      record.studentIds.push(studentId);
      traceMessages.set(messageKey, record);
    }
    return;
  }
  const source = sourceForSection[section];
  const key = `${source.file}|${source.function}`;
  const record = traceSources.get(key) || { ...source, studentIds: [] };
  record.studentIds.push(studentId);
  traceSources.set(key, record);
  const sentenceKey = `${section}|${sentence}`;
  const item = untraced.get(sentenceKey) || { section, sentence, source, studentIds: [] };
  item.studentIds.push(studentId);
  untraced.set(sentenceKey, item);
}

async function bootServer() {
  await readFile(path.join(root, ".next/BUILD_ID"), "utf8").catch(() => {
    throw new Error("Build the production application with pnpm run build before running the student panel");
  });
  const port = process.env.PANEL_PORT || "3137";
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", port], {
    cwd: root,
    env: { ...process.env, ECONPLANNER_MCP_STATE_KEY: "panel-local-test-key-not-for-production" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let startupLog = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { startupLog = `${startupLog}${chunk}`.slice(-8000); });
  const url = `http://127.0.0.1:${port}/?layout=apple`;
  let ready = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`Next dev server exited with code ${child.exitCode}: ${startupLog}`);
    try {
      const response = await fetch(url);
      if (response.ok) { ready = true; break; }
    } catch { /* server is starting */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) { child.kill("SIGTERM"); throw new Error(`Next dev server did not become ready: ${startupLog}`); }
  return { child, url };
}

async function runStudent(browser, baseURL, profile) {
  const student = prepareProfile(profile);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(`${student.planCreationDate}T12:00:00`) });
  await page.addInitScript(({ key, formData }) => localStorage.setItem(key, JSON.stringify({ schemaVersion: 6, formData, courseSearch: "", intakeStep: 1 })), { key: storageKey, formData: student });
  const stepStatus = [];
  try {
    await page.goto(baseURL);
    await page.getByRole("heading", { name: "Where are you in your degree?" }).waitFor({ timeout: 30000 });
    stepStatus.push("About you");
    await page.getByRole("button", { name: "Continue to your courses" }).click();
    await page.getByRole("heading", { name: "Which courses have you finished or are taking now?" }).waitFor({ timeout: 15000 });
    stepStatus.push("Your courses");
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/majors/map") && response.request().method() === "POST" && response.request().postDataJSON()?.action !== "validate-plan", { timeout: 120000 });
    await page.getByRole("button", { name: "Generate my plans" }).click();
    const response = await responsePromise;
    const payload = await response.json();
    if (response.status() !== 200) throw new Error(`Generate returned HTTP ${response.status()}: ${payload.error || "no error message"}`);
    await page.locator(".comparison-page").waitFor({ timeout: 30000 });
    stepStatus.push("Generate");
    await page.locator(".comparison-page details").evaluateAll(items => items.forEach(item => { item.open = true; }));
    const plans = [...new Map((payload.programs || []).flatMap(item => item.economicsPlans || []).map(plan => [plan.id, plan])).values()];
    const screen = await captureScreen(page, Object.fromEntries(plans.map(plan => [plan.id, planStatus(plan)])));
    const reportPage = await context.newPage();
    const pdfSections = [];
    for (const plan of plans) {
      const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, plans);
      const html = renderEconomicsHtml(report, template);
      pdfSections.push(...await capturePdf(reportPage, html, plan.label));
    }
    const evidence = policyEvidence(payload, plans);
    for (const section of screen.sections) {
      for (const line of section.lines) for (const sentence of toSentences(line)) recordTrace("SCREEN", sentence, evidence, profile.id);
    }
    for (const section of pdfSections) {
      for (const line of section.lines) for (const sentence of toSentences(line)) recordTrace("PDF", sentence, evidence, profile.id);
    }
    return { student, text: snapshotText(screen.sections, pdfSections), plans: planArtifact(profile, screen.overallStatus, plans, payload), stepStatus };
  } catch (error) {
    const reason = error?.message || String(error);
    couldNotDrive.push({ studentId: profile.id, completedSteps: stepStatus, reason });
    const line = `Could not drive student ${profile.id} through the planner: ${reason}`;
    return { student, text: `SCREEN\nSCREEN > Drive failure\n${line}\nPDF\n`,
      plans: { studentId: profile.id, planDate: student.planCreationDate, overallStatus: "Drive failure", resultCategory: null, plans: [] }, stepStatus };
  } finally {
    await context.close();
  }
}

async function uniqueLinesArtifact() {
  const seenByLine = new Map();
  for (const profile of data.students) {
    const snapshot = await readFile(path.join(snapshotsDir, `${profile.id}.txt`), "utf8");
    for (const sourceLine of snapshot.split(/\r?\n/)) {
      if (!sourceLine || sourceLine === "SCREEN" || sourceLine === "PDF" || /^(?:SCREEN|PDF) > /.test(sourceLine)) continue;
      const line = normalize(sourceLine.replace(/^(?:STATUS|NOTE|GRID ROW|TERM|CHECKLIST ROW|CHECKLIST CELL|TABLE HEADER):\s*/, ""));
      if (!line) continue;
      if (!seenByLine.has(line)) seenByLine.set(line, new Set());
      seenByLine.get(line).add(profile.id);
    }
  }
  return [...seenByLine].sort(([a], [b]) => a.localeCompare(b, "en-US", { numeric: true }))
    .map(([line, ids]) => `${sorted(ids).join(", ")}\t${line}`).join("\n") + "\n";
}

async function generate() {
  const { child, url } = await bootServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const profile of data.students) {
      const result = await runStudent(browser, url, profile);
      await writeFile(path.join(snapshotsDir, `${profile.id}.txt`), result.text);
      await writeFile(path.join(plansDir, `${profile.id}.json`), JSON.stringify(result.plans, null, 2) + "\n");
      console.log(`Student ${profile.id}: ${result.stepStatus.join(" → ") || "not driven"}`);
    }
  } finally {
    await browser.close();
    child.kill("SIGTERM");
  }
}

function traceArtifacts() {
  const rules = [...traceRules.values()].map(item => ({ ...item, studentIds: sorted(item.studentIds) }))
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const reasons = [...traceReasons.values()].map(item => ({ ...item, studentIds: sorted(item.studentIds) }))
    .sort((a, b) => a.reasonCode.localeCompare(b.reasonCode));
  const messages = [...traceMessages.values()].map(item => ({ ...item, studentIds: sorted(item.studentIds) }))
    .sort((a, b) => a.messageKey.localeCompare(b.messageKey));
  const sources = [...traceSources.values()].map(item => ({ ...item, studentIds: sorted(item.studentIds) }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.function.localeCompare(b.function));
  const untracedSentences = [...untraced.values()].map(item => ({ ...item, studentIds: sorted(item.studentIds) }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.sentence.localeCompare(b.sentence));
  return {
    json: JSON.stringify({ rules, reasons, messages, sources, untracedSentences, couldNotDrive }, null, 2) + "\n",
    markdown: [
      "# Student panel decision trace", "",
      "Rule or reason code → policy message keys → panel students.", "",
      ...rules.map(item => `- **${item.ruleId}** → ${JSON.stringify(item.messageKeys)} → ${item.studentIds.join(", ")}`),
      ...reasons.map(item => `- **${item.reasonCode}** → ${JSON.stringify(item.messageKeys)} → ${item.studentIds.join(", ")}`),
      ...messages.map(item => `- **${item.messageKey}** → ${item.studentIds.join(", ")}`),
      "", "## Untraced sentences", "",
      ...(untracedSentences.length ? untracedSentences.map(item => `- **${item.section}** (${item.source.file}, ${item.source.function}; students ${item.studentIds.join(", ")}): ${item.sentence}`) : ["None."]),
      "", "## Students not driven through all screens", "",
      ...(couldNotDrive.length ? couldNotDrive.map(item => `- ${item.studentId}: ${item.reason} (completed: ${item.completedSteps.join(", ") || "none"})`) : ["None."]), ""
    ].join("\n")
  };
}

function diffText(expected, actual) {
  const left = expected.split(/\r?\n/);
  const right = actual.split(/\r?\n/);
  const lines = [];
  let before = 0;
  let after = 0;
  while (before < left.length || after < right.length) {
    if (left[before] === right[after]) { before++; after++; continue; }
    const nextBefore = left.slice(before + 1, before + 21).indexOf(right[after]);
    const nextAfter = right.slice(after + 1, after + 21).indexOf(left[before]);
    if (nextBefore >= 0 && (nextAfter < 0 || nextBefore <= nextAfter)) {
      lines.push(`- ${left[before++]}`);
    } else if (nextAfter >= 0) {
      lines.push(`+ ${right[after++]}`);
    } else {
      if (before < left.length) lines.push(`- ${left[before++]}`);
      if (after < right.length) lines.push(`+ ${right[after++]}`);
    }
  }
  return lines;
}

try {
  if (!suppliedGeneratedDir) {
    await generate();
    const traces = traceArtifacts();
    await writeFile(path.join(targetDir, "trace.json"), traces.json);
    await writeFile(path.join(targetDir, "trace.md"), traces.markdown);
    await writeFile(path.join(targetDir, "unique-lines.txt"), await uniqueLinesArtifact());
  }
  if (runningCheck) {
    const expectedDir = path.join(root, "tests/panel");
    const filesIn = async (directory, extension, prefix) => (await readdir(directory))
      .filter(file => file.endsWith(extension)).map(file => `${prefix}/${file}`);
    const expectedFiles = [
      ...await filesIn(path.join(expectedDir, "snapshots"), ".txt", "snapshots"),
      ...await filesIn(path.join(expectedDir, "plans"), ".json", "plans"), "trace.json", "trace.md", "unique-lines.txt"
    ].sort();
    const actualFiles = [
      ...await filesIn(snapshotsDir, ".txt", "snapshots"),
      ...await filesIn(plansDir, ".json", "plans"), "trace.json", "trace.md", "unique-lines.txt"
    ].sort();
    let failed = JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles);
    if (failed) console.error(`Panel file list differs. Expected ${expectedFiles.length} files; generated ${actualFiles.length}.`);
    for (const file of [...new Set([...expectedFiles, ...actualFiles])].sort()) {
      const expected = await readFile(path.join(expectedDir, file), "utf8").catch(() => "");
      const actual = await readFile(path.join(targetDir, file), "utf8").catch(() => "");
      if (expected === actual) continue;
      failed = true;
      console.error(`\n${file} differs:`);
      const changes = diffText(expected, actual);
      for (const line of changes.slice(0, 300)) console.error(line);
      if (changes.length > 300) console.error(`... ${changes.length - 300} more changed lines`);
    }
    if (failed) process.exitCode = 1;
    else console.log(`Panel check passed: ${data.students.length} students, ${data.students.length} snapshots, ${data.students.length} plan files and current trace.`);
  } else {
    console.log(`Generated ${data.students.length} student snapshots under ${snapshotsDir}.`);
  }
} finally {
  if (runningCheck && !suppliedGeneratedDir) await rm(targetDir, { recursive: true, force: true });
}
