import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";

const root = process.cwd();
const args = process.argv.slice(2).filter(argument => argument !== "--");
const inputPath = args[0];
const outputRoot = path.resolve(root, args[1] || "output");

if (!inputPath) {
  throw new Error("Usage: pnpm report:economics -- path/to/student.json [output-directory]");
}

const input = JSON.parse(await readFile(path.resolve(root, inputPath), "utf8"));
const student = input.student || input;
const report = await buildEconomicsReportFromStudent(student);
const reportDir = path.join(outputRoot, "reports");
const pdfDir = path.join(outputRoot, "pdf");
await Promise.all([mkdir(reportDir, { recursive: true }), mkdir(pdfDir, { recursive: true })]);

const jsonPath = path.join(reportDir, "economics-plan.json");
const htmlPath = path.join(reportDir, "economics-plan.html");
const pdfPath = path.join(pdfDir, "economics-plan.pdf");
const template = await readFile(path.join(root, "templates/econplannertemplate.html"), "utf8");

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const html = renderEconomicsHtml(report, template);
await writeFile(htmlPath, html, "utf8");

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: pdfPath, format: "Letter", printBackground: true, preferCSSPageSize: true, tagged: true });
} finally {
  await browser.close();
}

console.log(`Generated ${htmlPath}`);
console.log(`Generated ${pdfPath}`);
