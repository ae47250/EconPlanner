import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const snapshotDir = path.join(root, "tests/panel/snapshots");
const banned = JSON.parse(await readFile(path.join(root, "tests/panel/banned-terms.json"), "utf8"));
const courseData = JSON.parse(await readFile(path.join(root, "data/normalized/economics/courses.json"), "utf8"));
const files = (await readdir(snapshotDir)).filter(name => name.endsWith(".txt")).sort();
let total = 0;
const counts = { semicolon: 0, wordLimit: 0, bannedTerm: 0, placeholder: 0, duplicate: 0 };
const heading = /^(?:SCREEN|PDF|Plan Notes|Fall|Winter|Spring|May|Course|Requirement|Term|Credits?)\b/i;
const words = value => value.match(/[\p{L}\p{N}]+(?:[’'/-][\p{L}\p{N}]+)*/gu) || [];
const courseTitles = (courseData.courses || []).map(course => String(course.title || "")).filter(title => title.length > 5).sort((a, b) => b.length - a.length);

function wordCount(sentence) {
  let prose = sentence.replace(/\b(?:ECO|MAT|BUSN|PSY)\s*\d{3}\b/gi, " ");
  for (const title of courseTitles) prose = prose.replaceAll(title, " ");
  return words(prose).length;
}

for (const file of files) {
  const lines = (await readFile(path.join(snapshotDir, file), "utf8")).split(/\r?\n/);
  const seen = new Set();
  const violations = [];
  for (const line of lines) {
    const sentence = line.trim();
    if (!sentence || /^(?:SCREEN|PDF)$/.test(sentence)) continue;
    const exemptions = heading.test(sentence)
      || /^—\s*(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[\w/,:\s.–-]*)$/i.test(sentence);
    if (sentence.includes(";")) { counts.semicolon++; violations.push(["semicolon", sentence]); }
    if (!exemptions && wordCount(sentence) > 25) { counts.wordLimit++; violations.push(["wordLimit", sentence]); }
    for (const term of banned) if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i").test(sentence)) {
      counts.bannedTerm++; violations.push([`bannedTerm:${term}`, sentence]);
    }
    if (/[{}]/.test(sentence)) { counts.placeholder++; violations.push(["placeholder", sentence]); }
    if (seen.has(sentence)) { counts.duplicate++; violations.push(["duplicate", sentence]); }
    seen.add(sentence);
  }
  if (violations.length) {
    total += violations.length;
    console.log(`${file}: ${violations.length} violation(s)`);
    for (const [rule, sentence] of violations) console.log(`  [${rule}] ${sentence}`);
  }
}
console.log(`Panel sentence violations: ${total} (${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")})`);
if (!files.length) {
  console.error(`No panel snapshots found in ${snapshotDir}`);
  process.exitCode = 1;
} else if (total) process.exitCode = 1;
