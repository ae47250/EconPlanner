import { createHash } from "node:crypto";

const PDF_ENDPOINT = "/api/v1/pdfs";
const REQUEST_TIMEOUT_MS = 115_000;

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

  const startedAt = Date.now();
  const idempotencyHash = createHash("sha256").update(html, "utf8").digest("hex");
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        html,
        filename,
        storeResult: true,
        storeHtml: true,
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
        retentionDays: 30,
        idempotencyKey: `econplanner:${idempotencyHash}`
      }),
      signal: timeoutSignal(startedAt)
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
  const stored = await response.json().catch(() => null);
  const downloadUrl = storedDownloadUrl(stored, endpoint);

  let downloadResponse;
  try {
    downloadResponse = await fetchImpl(downloadUrl, {
      headers: environment.PDF_CREATION_BYPASS_TOKEN
        ? { "x-vercel-protection-bypass": environment.PDF_CREATION_BYPASS_TOKEN }
        : {},
      signal: timeoutSignal(startedAt)
    });
  } catch (error) {
    const code = error?.name === "TimeoutError" ? "pdf_creation_timeout" : "pdf_creation_unavailable";
    throw new PdfCreationClientError("The stored PDF could not be downloaded.", { code, status: 503 });
  }

  if (!downloadResponse.ok || !downloadResponse.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
    throw new PdfCreationClientError("The PDF service returned an invalid response.");
  }

  const pdf = new Uint8Array(await downloadResponse.arrayBuffer());
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
  if (
    new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-" ||
    pdf.byteLength !== stored.pdfBytes ||
    pdfSha256 !== stored.sha256
  ) {
    throw new PdfCreationClientError("The stored PDF failed its integrity check.");
  }

  return {
    pdf,
    diagnostics: {
      "X-PDF-Request-Id": stored.requestId,
      "X-PDF-Caller": stored.caller,
      "X-PDF-Page-Count": String(stored.pageCount),
      "X-PDF-SHA256": stored.sha256,
      "X-PDF-Duration-Ms": String(stored.durationMs),
      "X-PDF-Report-Id": stored.reportId
    }
  };
}

function storedDownloadUrl(stored, endpoint) {
  if (
    stored?.status !== "complete" ||
    stored?.caller !== "econplanner" ||
    typeof stored?.reportId !== "string" ||
    typeof stored?.pdfBytes !== "number" ||
    !Number.isInteger(stored?.pageCount) ||
    !/^[0-9a-f]{64}$/.test(stored?.sha256 || "") ||
    typeof stored?.links?.download !== "string"
  ) {
    throw new PdfCreationClientError("The PDF service returned an invalid stored result.");
  }

  let downloadUrl;
  try {
    downloadUrl = new URL(stored.links.download);
  } catch {
    throw new PdfCreationClientError("The PDF service returned an invalid stored result.");
  }
  if (
    downloadUrl.origin !== endpoint.origin ||
    !/^\/reports\/r(?:1|7|30)_[0-9a-f-]+\/download$/i.test(downloadUrl.pathname)
  ) {
    throw new PdfCreationClientError("The PDF service returned an invalid stored result.");
  }
  return downloadUrl;
}

function timeoutSignal(startedAt) {
  return AbortSignal.timeout(Math.max(1, REQUEST_TIMEOUT_MS - (Date.now() - startedAt)));
}
