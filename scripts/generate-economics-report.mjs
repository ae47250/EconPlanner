import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
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
await writeFile(htmlPath, renderEconomicsHtml(report, template), "utf8");

await new Promise((resolve, reject) => {
  const python = process.env.PYTHON_EXECUTABLE || "python";
  const child = spawn(python, [path.join(root, "scripts/render-economics-pdf.py"), jsonPath, pdfPath], { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`PDF renderer exited with code ${code}`)));
});

console.log(`Generated ${htmlPath}`);
console.log(`Generated ${pdfPath}`);
