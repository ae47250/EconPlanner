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
const targetDir = runningCheck ? await mkdtemp(path.join(os.tmpdir(), "econplanner-panel-")) : path.join(root, "tests/panel");
const snapshotsDir = path.join(targetDir, "snapshots");
await mkdir(snapshotsDir, { recursive: true });
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
const sortedSentences = values => [...values].sort((a, b) => a.localeCompare(b, "en-US", { numeric: true }));

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

function textFromHtml(html) {
  return html.replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|header|footer|article|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
}

function toSentences(value) {
  return value.split(/\r?\n/).flatMap(line => line.split(/(?<=[.!?])\s+(?=[A-Z0-9“])/))
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => /[.!?]["'’”)}\]]?$/.test(line)
      && !/^—\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(line)
      && !/\bSection\s+[A-Z]\s*:[^;]*;\s*Section\s+[A-Z]\s*:/i.test(line))
    .filter(Boolean);
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
  const port = process.env.PANEL_PORT || "3137";
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", port], {
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
  await page.goto(baseURL);
  const stepStatus = [];
  try {
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
    const screenText = await page.locator(".comparison-page").innerText();
    const screen = sortedSentences(toSentences(screenText));
    const plans = [...new Map((payload.programs || []).flatMap(item => item.economicsPlans || []).map(plan => [plan.id, plan])).values()];
    const pdfSentences = [];
    for (const plan of plans) {
      const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, plans);
      const html = renderEconomicsHtml(report, template);
      pdfSentences.push(...toSentences(textFromHtml(html)));
    }
    const pdf = sortedSentences(pdfSentences);
    const evidence = policyEvidence(payload, plans);
    for (const sentence of screen) recordTrace("SCREEN", sentence, evidence, profile.id);
    for (const sentence of pdf) recordTrace("PDF", sentence, evidence, profile.id);
    return { student, text: [`SCREEN`, ...screen, `PDF`, ...pdf].join("\n") + "\n", stepStatus };
  } catch (error) {
    const reason = error?.message || String(error);
    couldNotDrive.push({ studentId: profile.id, completedSteps: stepStatus, reason });
    const line = `Could not drive student ${profile.id} through the planner: ${reason}`;
    return { student, text: `SCREEN\n${line}\nPDF\n${line}\n`, stepStatus };
  } finally {
    await context.close();
  }
}

async function generate() {
  const { child, url } = await bootServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const profile of data.students) {
      const result = await runStudent(browser, url, profile);
      await writeFile(path.join(snapshotsDir, `${profile.id}.txt`), result.text);
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
  const counts = text => {
    const result = new Map();
    for (const line of text.split(/\r?\n/).filter(Boolean)) result.set(line, (result.get(line) || 0) + 1);
    return result;
  };
  const left = counts(expected);
  const right = counts(actual);
  const lines = [];
  for (const line of [...new Set([...right.keys(), ...left.keys()])].sort()) {
    for (let index = left.get(line) || 0; index < (right.get(line) || 0); index++) lines.push(`+ ${line}`);
    for (let index = right.get(line) || 0; index < (left.get(line) || 0); index++) lines.push(`- ${line}`);
  }
  return lines;
}

try {
  await generate();
  const traces = traceArtifacts();
  await writeFile(path.join(targetDir, "trace.json"), traces.json);
  await writeFile(path.join(targetDir, "trace.md"), traces.markdown);
  if (runningCheck) {
    const expectedDir = path.join(root, "tests/panel");
    const expectedFiles = [...(await readdir(path.join(expectedDir, "snapshots"))).filter(file => file.endsWith(".txt")).map(file => `snapshots/${file}`), "trace.json", "trace.md"].sort();
    const actualFiles = [...(await readdir(snapshotsDir)).filter(file => file.endsWith(".txt")).map(file => `snapshots/${file}`), "trace.json", "trace.md"].sort();
    let failed = JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles);
    if (failed) console.error(`Panel file list differs. Expected ${expectedFiles.length} files; generated ${actualFiles.length}.`);
    for (const file of expectedFiles) {
      const expected = await readFile(path.join(expectedDir, file), "utf8").catch(() => "");
      const actual = await readFile(path.join(targetDir, file), "utf8").catch(() => "");
      if (expected === actual) continue;
      failed = true;
      console.error(`\n${file} differs:`);
      for (const line of diffText(expected, actual)) console.error(line);
    }
    if (failed) process.exitCode = 1;
    else console.log(`Panel check passed: ${data.students.length} students, ${expectedFiles.length - 2} snapshots and current trace.`);
  } else {
    console.log(`Generated ${data.students.length} student snapshots under ${snapshotsDir}.`);
  }
} finally {
  if (runningCheck) await rm(targetDir, { recursive: true, force: true });
}
