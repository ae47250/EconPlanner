const PDF_ENDPOINT = "/api/v1/pdfs";

export class PdfCreationClientError extends Error {
  constructor(message, { code = "pdf_creation_failed", status = 502 } = {}) {
    super(message);
    this.name = "PdfCreationClientError";
    this.code = code;
    this.status = status;
  }
}

export async function createPdfFromHtml(
  { html, filename = "EconPlanner_Report.pdf" },
  { environment = process.env, fetchImpl = fetch } = {}
) {
  if (environment.PDF_CREATION_ENABLED !== "true") {
    throw new PdfCreationClientError("PDF downloads are not enabled.", {
      code: "pdf_creation_disabled",
      status: 503
    });
  }

  const apiUrl = environment.PDF_CREATION_API_URL;
  const apiKey = environment.PDF_CREATION_API_KEY;
  if (!apiUrl || !apiKey || apiKey.length < 32) {
    throw new PdfCreationClientError("PDF downloads are not configured.", {
      code: "pdf_creation_unavailable",
      status: 503
    });
  }

  let endpoint;
  try {
    endpoint = new URL(PDF_ENDPOINT, apiUrl);
  } catch {
    throw new PdfCreationClientError("PDF downloads are not configured.", {
      code: "pdf_creation_unavailable",
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
        }
      }),
      signal: AbortSignal.timeout(115_000)
    });
  } catch (error) {
    const code = error?.name === "TimeoutError" ? "pdf_creation_timeout" : "pdf_creation_unavailable";
    throw new PdfCreationClientError("The PDF service could not be reached.", { code, status: 503 });
  }

  if (!response.ok) {
    const serviceError = await response.json().catch(() => null);
    const code = serviceError?.error?.code || "pdf_creation_failed";
    throw new PdfCreationClientError("The PDF could not be created.", { code, status: 502 });
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
    throw new PdfCreationClientError("The PDF service returned an invalid response.");
  }

  return {
    pdf: new Uint8Array(await response.arrayBuffer()),
    diagnostics: Object.fromEntries(
      [...response.headers.entries()].filter(([name]) => name.toLowerCase().startsWith("x-pdf-"))
    )
  };
}
