import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildEconomicsReportFromStudent } from "../../../../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../../../../lib/reports/economics-html.js";
import { createPdfFromHtml, PdfCreationClientError } from "../../../../lib/pdf-creation-client.js";

export const runtime = "nodejs";
export const maxDuration = 120;

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
        { html, filename: "EconPlanner-Economics-Plan.pdf" },
        dependencies
      );
      return new Response(result.pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="EconPlanner-Economics-Plan.pdf"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...result.diagnostics
        }
      });
    }
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof PdfCreationClientError) {
      console.error(JSON.stringify({
        event: "econplanner_pdf_failed",
        code: error.code,
        status: error.status,
        correlationId: error.diagnostics?.correlationId || null,
        upstreamStatus: error.diagnostics?.upstreamStatus || null,
        upstreamCode: error.diagnostics?.upstreamCode || null,
        requestId: error.diagnostics?.requestId || null,
        phase: error.diagnostics?.phase || null,
        attemptCount: error.diagnostics?.attemptCount || null,
        elapsedAdmissionMs: error.diagnostics?.elapsedAdmissionMs ?? null,
        retryFailure: error.diagnostics?.retryFailure || null
      }));
      return Response.json(
        { error: error.message, code: error.code },
        {
          status: error.status,
          headers: { "Cache-Control": "no-store", ...error.responseHeaders }
        }
      );
    }
    const selectedPlanInvalid = /selected Economics plan no longer passes server validation/i.test(error?.message || "");
    return Response.json({
      error: selectedPlanInvalid
        ? "The selected plan changed or no longer passes validation. Regenerate the plan before downloading it."
        : "The Economics report could not be generated from the supplied student data.",
      code: selectedPlanInvalid ? "SELECTED_PLAN_INVALID" : "ECONOMICS_REPORT_INVALID"
    }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request) {
  return handleEconomicsReportRequest(request);
}
