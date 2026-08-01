import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildEconomicsReportFromStudent } from "../../../../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../../../../lib/reports/economics-html.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const report = await buildEconomicsReportFromStudent(
      body?.student || body || {},
      body?.preparedDate,
      body?.selectedPlan || null
    );
    if (body?.format === "json") return Response.json(report);

    const template = await readFile(path.join(process.cwd(), "templates/econplannertemplate.html"), "utf8");
    return new Response(renderEconomicsHtml(report, template), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "The Economics report could not be generated from the supplied student data." }, { status: 422 });
  }
}
