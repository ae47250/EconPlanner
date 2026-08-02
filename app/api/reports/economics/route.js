import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildEconomicsReportFromStudent } from "../../../../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../../../../lib/reports/economics-html.js";
import { createPdfFromHtml, PdfCreationClientError } from "../../../../lib/pdf-creation-client.js";

export const runtime = "nodejs";

export async function handleEconomicsReportRequest(request, dependencies = {}) {
  try {
    const body = await request.json();
    const report = await buildEconomicsReportFromStudent(
      body?.student || body || {},
      body?.preparedDate,
      body?.selectedPlan || null
    );
    if (body?.format === "json") return Response.json(report);

    const template = await readFile(path.join(process.cwd(), "templates/econplannertemplate.html"), "utf8");
    const html = renderEconomicsHtml(report, template);
    if (body?.format === "pdf") {
      const result = await createPdfFromHtml(
        { html, filename: "EconPlanner_Report.pdf" },
        dependencies
      );
      return new Response(result.pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="EconPlanner_Report.pdf"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...result.diagnostics
        }
      });
    }
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  } catch (error) {
    if (error instanceof PdfCreationClientError) {
      return Response.json(
        { error: "The Economics report PDF could not be created.", code: error.code },
        { status: error.status, headers: { "Cache-Control": "no-store" } }
      );
    }
    console.error(error);
    return Response.json({ error: "The Economics report could not be generated from the supplied student data." }, { status: 422 });
  }
}

export async function POST(request) {
  return handleEconomicsReportRequest(request);
}
