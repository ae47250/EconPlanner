import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const snapshotFlag = process.argv.indexOf("--snapshots-dir");
const snapshotDir = snapshotFlag >= 0
  ? path.resolve(process.argv[snapshotFlag + 1] || "")
  : path.join(root, "tests/panel/snapshots");
const banned = JSON.parse(await readFile(path.join(root, "tests/panel/banned-terms.json"), "utf8"));
const files = (await readdir(snapshotDir)).filter(name => name.endsWith(".txt")).sort();
const counts = { semicolon: 0, wordLimit: 0, bannedTerm: 0, placeholder: 0, duplicate: 0, inconsistentFact: 0, statusContradiction: 0 };
const normalize = value => String(value).replace(/\s+/g, " ").trim();
const words = value => value.match(/[\p{L}\p{N}]+(?:[’'/-][\p{L}\p{N}]+)*/gu) || [];
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bannedPatterns = banned.map(term => [term, new RegExp(`\\b${escapePattern(term)}\\b`, "i")]);

function visibleText(line) {
  return line.replace(/^(?:STATUS|NOTE|GRID ROW|TERM|CHECKLIST ROW):\s*/, "");
}

function factFamily(value) {
  if (/\b(?:approv(?:al|e|ed)|permission)\b/i.test(value)) return "approval";
  if (/\b(?:before taking|prerequisite|finish|done before|completed before)\b/i.test(value)) return "prerequisite";
  if (/\b(?:seats?|enrollment)\b/i.test(value)) return "seats";
  if (/\b(?:offered|offering|schedule)\b/i.test(value)) return "offering";
  if (/\b(?:catalog.*(?:count|accept)|petition)\b/i.test(value)) return "catalog";
  return null;
}

function normalizedFact(value) {
  return normalize(value.toLowerCase()
    .replace(/\b(?:ECO|MAT|BUSN|PSY)\s*\d{3}\b/gi, " ")
    .replace(/\b(?:fall|winter|spring\/may|spring|may)\s+\d{4}\b/gi, " ")
    .replace(/\b(?:19|20)\d{2}(?:[–-]\d{2,4})?\b/g, " "));
}

function factKey(value) {
  const family = factFamily(value);
  const codes = [...new Set((value.match(/\b(?:ECO|MAT|BUSN|PSY)\s*\d{3}\b/gi) || []).map(code => code.toUpperCase()))].sort();
  return family && codes.length ? `${family}:${codes.join(",")}` : null;
}

let total = 0;
for (const file of files) {
  const lines = (await readFile(path.join(snapshotDir, file), "utf8")).split(/\r?\n/);
  const scopes = new Map();
  const violations = [];
  let surface = "";
  let scope = "";
  const flag = (type, line, currentScope = scope) => {
    counts[type]++;
    violations.push({ type, line, scope: currentScope || surface || "unscoped" });
  };

  for (const original of lines) {
    const line = normalize(original);
    if (!line) continue;
    if (line === "SCREEN" || line === "PDF") { surface = line; scope = ""; continue; }
    const section = line.match(/^(SCREEN|PDF) > Plan: (.*?)(?: > .*)?$/);
    if (section) {
      surface = section[1];
      scope = `${section[1]} / ${section[2]}`;
      if (!scopes.has(scope)) scopes.set(scope, { lines: [], seen: new Set(), facts: new Map() });
      continue;
    }
    if (/^(?:SCREEN|PDF) > /.test(line)) { scope = ""; continue; }

    const text = visibleText(line);
    const isGridRow = /^GRID ROW:/.test(line);
    const isMeetingTime = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*\b[^\n]*\b\d{1,2}:\d{2}\b/i.test(text);
    if (text.includes(";")) flag("semicolon", line);
    if (!isGridRow && !isMeetingTime) {
      for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z0-9“])/).map(normalize).filter(Boolean)) {
        if (words(sentence).length > 25) flag("wordLimit", sentence === text ? line : `${line} [sentence: ${sentence}]`);
      }
    }
    for (const [term, pattern] of bannedPatterns) if (pattern.test(text)) flag("bannedTerm", `${line} [term: ${term}]`);
    if (/[{}]/.test(text)) flag("placeholder", line);

    if (!scope) continue;
    const record = scopes.get(scope);
    record.lines.push(line);
    if (record.seen.has(line)) flag("duplicate", line);
    record.seen.add(line);
    if (isGridRow || isMeetingTime) continue;
    const key = factKey(text);
    if (!key) continue;
    const normalized = normalizedFact(text);
    const prior = record.facts.get(key);
    if (prior && prior.normalized !== normalized && !prior.variants.has(normalized)) {
      flag("inconsistentFact", `${line} [also: ${prior.first}]`);
    }
    if (prior) prior.variants.add(normalized);
    else record.facts.set(key, { first: line, normalized, variants: new Set([normalized]) });
  }

  for (const [planScope, record] of scopes) {
    const status = record.lines.find(line => line.startsWith("STATUS: "))?.slice("STATUS: ".length);
    if (!status) continue;
    for (const line of record.lines) {
      if (line.startsWith("STATUS: ")) continue;
      const text = visibleText(line);
      if ((status === "Ready to plan" && /\b(?:Needs confirmation|Needs advisor attention|Not available)\b/i.test(text))
        || (status === "Needs advisor attention" && /\bReady to plan\b/i.test(text))
        || (status === "Not available" && /\bVerified feasible\b/i.test(text))) {
        flag("statusContradiction", line, planScope);
      }
    }
  }

  if (violations.length) {
    total += violations.length;
    console.log(`${file}: ${violations.length} violation(s)`);
    for (const { type, line, scope: location } of violations) console.log(`  [${type}] ${location}: ${line}`);
  }
}
console.log(`Panel sentence violations: ${total} (${Object.entries(counts).map(([type, count]) => `${type}=${count}`).join(", ")})`);
if (!files.length || total) process.exitCode = 1;
