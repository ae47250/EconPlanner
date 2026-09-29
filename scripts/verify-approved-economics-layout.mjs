// Local verification of the application's PDF route/client with Chromium transport.
// The injected transport renders the submitted HTML; it never calls a hosted service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { POST as mapPost } from "../app/api/majors/map/route.js";
import { handleEconomicsReportRequest } from "../app/api/reports/economics/route.js";

const directory = "output/economics-pdf-verification/approved-portrait";
await mkdir(directory, { recursive: true });
await mkdir("output/pdf", { recursive: true });
const sample = { displayName: "Fictional Economics Student", academicStanding: "sophomore", entryCatalogYear: "2025-2026", planningPace: "one_year_early", planCreationDate: "2026-09-28", courses: [] };
const profiles = [
  ["sample", sample],
  ["mixed", { ...sample, courses: ["ECO 113", "MAT 113", "BUSN 323", "ECO 161"].map(code => ({ code, status: "completed" })).concat({ code: "ECO 114", status: "in_progress" }) }],
  ["long", { ...sample, displayName: "Fictional Student With A Longer Name For Portrait Wrapping And Four Remaining Academic Years", academicStanding: "freshman", entryCatalogYear: "2024-2025" }],
  ["incomplete", { ...sample, academicStanding: "senior", customGraduationEnabled: true, customExpectedGraduationYear: "2028", planCreationDate: "2027-08-24", courses: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"].map(code => ({ code, status: "completed" })) }]
];
const normalize = value => String(value).replace(/\s+/g, " ").trim();
const request = (url, body) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const [profile, student] of profiles) {
    const generated = await mapPost(request("/api/majors/map", { student }));
    assert.equal(generated.status, 200);
    const plans = (await generated.json()).programs.find(program => program.economicsPlans).economicsPlans;
    if (profile !== "incomplete") assert.equal(plans.length, 3);
    for (const plan of plans.length ? plans : [null]) {
      const id = plan?.id || "candidate";
      const body = { student, selectedPlan: plan, plans, preparedDate: "2026-09-28" };
      const response = await handleEconomicsReportRequest(request("/api/reports/economics", { ...body, format: "json" }));
      assert.equal(response.status, 200);
      const report = await response.json();
      let pdf, html, measured, pages;
      const exported = await handleEconomicsReportRequest(request("/api/reports/economics", { ...body, format: "pdf" }), {
        environment: { PDF_CREATION_ENABLED: "true", PDF_CREATION_API_URL: "https://pdf-creator.example", PDF_CREATION_API_KEY: "a".repeat(43) },
        fetchImpl: async (url, options) => {
          if (url.pathname === "/api/v1/pdfs") {
            const submitted = JSON.parse(options.body);
            assert.equal(submitted.storeHtml, false);
            assert.equal(submitted.retentionDays, 30);
            assert.deepEqual(submitted.page, { format: "Letter", orientation: "portrait", marginsInches: { top: .42, right: .42, bottom: .42, left: .42 } });
            html = submitted.html;
            const page = await browser.newPage({ viewport: { width: 736, height: 976 } });
            await page.emulateMedia({ media: "print" });
            await page.setContent(html, { waitUntil: "networkidle" });
            await page.evaluate(() => document.fonts.ready);
            measured = await page.evaluate(() => ({
              blocks: [...document.querySelectorAll('.report-header,.schedule-card,.plan-conditions,.checklist-section,[data-plan-note]')].map(node => ({ name: node.dataset.planNote || node.className, height: node.getBoundingClientRect().height, fontSize: getComputedStyle(node).fontSize })),
              indentation: [...document.querySelectorAll('.offerings')].map(node => parseFloat(getComputedStyle(node).paddingLeft)),
              notes: [...document.querySelectorAll('[data-plan-note]')].map(node => ({ id: node.dataset.planNote, text: node.innerText })),
              legend: document.querySelector('.checklist-legend')?.innerText,
              clipped: [...document.querySelectorAll('td,th,.card')].filter(node => node.scrollWidth > node.clientWidth + 2).length
            }));
            assert.deepEqual(measured.indentation, measured.indentation.map(() => 16));
            assert.equal(measured.clipped, 0);
            assert.ok(!/Still needed|Not yet planned/.test(measured.legend));
            assert.deepEqual(measured.notes.map(note => note.id), report.planNotes.map(note => note.id));
            const file = profile === "sample" ? `output/pdf/fictional-${id}-revised.pdf` : `${directory}/${profile}-${id}.pdf`;
            pdf = await page.pdf({ path: file, format: "Letter", margin: { top: ".42in", right: ".42in", bottom: ".42in", left: ".42in" }, printBackground: true, preferCSSPageSize: true, tagged: true });
            await page.close();
            pages = execFileSync("pdftotext", [file, "-"], { encoding: "utf8" }).split("\f").filter(value => value.trim());
            for (const year of new Set(report.terms.map(term => term.academicYear))) assert.ok(normalize(pages[0]).includes(year), `${profile}/${id}: missing page-one year ${year}`);
            for (const term of report.terms) for (const course of term.courses) assert.ok(normalize(pages.join(" ")).includes(normalize(course.title)));
            const assigned = report.majorRequirementsChecklist.rows.filter(row => row.status !== "still_needed");
            const checklistPage = pages.find(value => value.includes("Major requirements checklist"));
            for (const row of assigned) assert.ok(normalize(checklistPage).includes(normalize(row.courseTerm)), `${profile}/${id}: checklist split/lost ${row.id}`);
            for (const condition of report.planConditions) assert.equal(normalize(pages.join(" ")).split(normalize(condition.message)).length, 2);
            for (const note of report.planNotes) for (const item of note.items) for (const line of item.lines || [item.text]) assert.ok(normalize(pages.join(" ")).includes(normalize(line)));
            if (profile === "mixed") assert.ok(assigned.some(row => row.status === "completed") && assigned.some(row => row.status === "in_progress") && assigned.some(row => row.status === "planned"));
            if (profile === "incomplete") assert.ok(html.includes("Incomplete candidate") && report.majorRequirementsChecklist.unmetRequirements.length > 0 && report.economicsPlanResult.conclusion === "UNKNOWN");
            results.push({ profile, plan: id, file, pageCount: pages.length, allYearsPageOne: true, checklistIntact: true, conditionsOnce: true, measured, sha256: createHash("sha256").update(pdf).digest("hex") });
            return Response.json({ status: "complete", requestId: "local-layout-request", reportId: "r30_00000000-0000-4000-8000-000000000017", caller: "econplanner", durationMs: 1, pdfBytes: pdf.length, pageCount: pages.length, sha256: createHash("sha256").update(pdf).digest("hex"), links: { download: "https://pdf-creator.example/reports/r30_00000000-0000-4000-8000-000000000017/download" } });
          }
          return new Response(pdf, { headers: { "content-type": "application/pdf" } });
        }
      });
      assert.equal(exported.status, 200, await exported.clone().text());
      assert.deepEqual(Buffer.from(await exported.arrayBuffer()), pdf);
      await writeFile(`${directory}/${profile}-${id}.json`, JSON.stringify(report, null, 2) + "\n");
      await writeFile(`${directory}/${profile}-${id}.html`, html);
    }
  }
} finally { await browser.close(); }
await writeFile(`${directory}/layout-results.json`, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results.map(({ profile, plan, pageCount, allYearsPageOne, checklistIntact, sha256 }) => ({ profile, plan, pageCount, allYearsPageOne, checklistIntact, sha256 })), null, 2));
