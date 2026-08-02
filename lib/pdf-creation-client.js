import { randomUUID } from "node:crypto";

const PDF_ENDPOINT = "/api/v1/pdfs";

export class PdfCreationClientError extends Error {
  constructor(message, { code = "PDF_CREATION_FAILED", status = 502, diagnostics = {} } = {}) {
    super(message);
    this.name = "PdfCreationClientError";
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

export async function createPdfFromHtml(
  { html, filename = "EconPlanner-Economics-Plan.pdf" },
  { environment = process.env, fetchImpl = fetch } = {}
) {
  if (environment.PDF_CREATION_ENABLED !== "true") {
    throw new PdfCreationClientError("PDF downloads are not enabled.", {
      code: "PDF_CREATION_DISABLED",
      status: 503
    });
  }

  const apiUrl = environment.PDF_CREATION_API_URL;
  const apiKey = environment.PDF_CREATION_API_KEY;
  if (!apiUrl || !apiKey || apiKey.length < 32) {
    throw new PdfCreationClientError("PDF downloads are not configured.", {
      code: "PDF_CREATION_NOT_CONFIGURED",
      status: 503
    });
  }

  let endpoint;
  try {
    endpoint = new URL(PDF_ENDPOINT, apiUrl);
  } catch {
    throw new PdfCreationClientError("PDF downloads are not configured.", {
      code: "PDF_CREATION_NOT_CONFIGURED",
      status: 503
    });
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  if (environment.PDF_CREATION_BYPASS_TOKEN) {
    headers["x-vercel-protection-bypass"] = environment.PDF_CREATION_BYPASS_TOKEN;
  }

  let response;
  const correlationId = randomUUID();
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        html,
        filename,
        storeResult: false,
        storeHtml: false,
        page: {
          format: "Letter",
          orientation: "portrait",
          marginsInches: { top: 0.42, right: 0.42, bottom: 0.42, left: 0.42 }
        },
        metadata: {
          title: "EconPlanner Economics Major Course Plan",
          author: "EconPlanner",
          subject: "Economics major course planning report",
          keywords: ["economics", "course planning"]
        },
        correlationId
      }),
      signal: AbortSignal.timeout(115_000)
    });
  } catch (error) {
    throw new PdfCreationClientError(
      error?.name === "TimeoutError" ? "The PDF service took too long to respond." : "The PDF service could not be reached.",
      {
        code: "PDF_CREATION_FAILED",
        status: 502,
        diagnostics: { correlationId, failure: error?.name === "TimeoutError" ? "timeout" : "network" }
      }
    );
  }

  if (!response.ok) {
    const serviceError = await response.json().catch(() => null);
    throw new PdfCreationClientError("The PDF could not be created.", {
      code: "PDF_CREATION_FAILED",
      status: 502,
      diagnostics: {
        correlationId,
        upstreamStatus: response.status,
        requestId: response.headers.get("x-request-id"),
        upstreamCode: serviceError?.error?.code || null
      }
    });
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
    throw new PdfCreationClientError("The PDF service returned an invalid response.", {
      diagnostics: { correlationId, upstreamStatus: response.status }
    });
  }

  return {
    pdf: new Uint8Array(await response.arrayBuffer()),
    diagnostics: Object.fromEntries(
      [...response.headers.entries()].filter(([name]) => name.toLowerCase().startsWith("x-pdf-"))
    )
  };
}
