import { createHash, randomUUID } from "node:crypto";

const PDF_ENDPOINT = "/api/v1/pdfs";
const REQUEST_TIMEOUT_MS = 115_000;
const ADMISSION_DEADLINE_MS = 15_000;
const MAX_CREATION_ATTEMPTS = 5;

export class PdfCreationClientError extends Error {
  constructor(message, {
    code = "PDF_CREATION_FAILED",
    status = 502,
    diagnostics = {},
    responseHeaders = {}
  } = {}) {
    super(message);
    this.name = "PdfCreationClientError";
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
    this.responseHeaders = responseHeaders;
  }
}

export function parseRetryAfterSeconds(value) {
  if (!/^\d+$/.test(value || "")) throw new Error("invalid-retry-after");
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1_000)) {
    throw new Error("invalid-retry-after");
  }
  return seconds;
}

export function busyRetryDelayMs(retryNumber, retryAfterSeconds, randomValue) {
  if (!Number.isInteger(retryNumber) || retryNumber < 1) throw new Error("invalid-retry-number");
  if (typeof randomValue !== "number" || randomValue < 0 || randomValue > 1) {
    throw new Error("invalid-random-value");
  }
  const jitterCeilingMs = Math.min(4_000, (2 ** (retryNumber - 1)) * 1_000);
  const jitterMs = Math.floor(randomValue * jitterCeilingMs);
  return Math.max(retryAfterSeconds * 1_000, jitterMs);
}

export async function createPdfFromHtml(
  {
    html,
    filename = "EconPlanner-Economics-Plan.pdf",
    storeResult = true,
    retentionDays = 30,
    downloadOperationId = null
  },
  {
    environment = process.env,
    fetchImpl = fetch,
    nowImpl = Date.now,
    sleepImpl = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
    randomImpl = Math.random,
    randomUUIDImpl = randomUUID
  } = {}
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
    if (endpoint.protocol !== "https:") throw new Error("insecure-pdf-creation-url");
  } catch {
    throw new PdfCreationClientError("PDF downloads are not configured.", {
      code: "PDF_CREATION_NOT_CONFIGURED",
      status: 503
    });
  }

  const startedAt = nowImpl();
  const admissionDeadline = startedAt + ADMISSION_DEADLINE_MS;
  const operationIdempotencyKey = storeResult ? `econplanner:${downloadOperationId || randomUUIDImpl()}` : null;
  const correlationId = randomUUIDImpl();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  if (environment.PDF_CREATION_BYPASS_TOKEN) {
    headers["x-vercel-protection-bypass"] = environment.PDF_CREATION_BYPASS_TOKEN;
  }

  const requestBody = {
    html,
    filename,
    storeResult,
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
    correlationId,
    ...(storeResult ? { retentionDays, idempotencyKey: operationIdempotencyKey } : {})
  };

  const response = await createWithAdmissionRetry({
    endpoint,
    headers,
    requestBody,
    correlationId,
    startedAt,
    admissionDeadline,
    fetchImpl,
    nowImpl,
    sleepImpl,
    randomImpl
  });

  if (!storeResult) return directPdfResult(response, correlationId);

  const stored = await response.json().catch(() => null);
  const downloadUrl = storedDownloadUrl(stored, endpoint, correlationId);

  let downloadResponse;
  try {
    downloadResponse = await fetchImpl(downloadUrl, {
      headers: environment.PDF_CREATION_BYPASS_TOKEN
        ? { "x-vercel-protection-bypass": environment.PDF_CREATION_BYPASS_TOKEN }
        : {},
      redirect: "error",
      signal: timeoutSignal(startedAt, nowImpl)
    });
  } catch (error) {
    throw unavailableError(error, correlationId, "The stored PDF could not be downloaded.", {
      phase: "stored-download"
    });
  }

  if (!downloadResponse.ok || !isPdfResponse(downloadResponse)) {
    throw new PdfCreationClientError("The PDF service returned an invalid response.", {
      diagnostics: { correlationId, phase: "stored-download", upstreamStatus: downloadResponse.status }
    });
  }

  const pdf = new Uint8Array(await downloadResponse.arrayBuffer());
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
  if (
    pdfSignature(pdf) !== "%PDF-" ||
    pdf.byteLength !== stored.pdfBytes ||
    pdfSha256 !== stored.sha256
  ) {
    throw new PdfCreationClientError("The stored PDF failed its integrity check.", {
      diagnostics: { correlationId, phase: "stored-download", reportId: stored.reportId }
    });
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

async function createWithAdmissionRetry({
  endpoint,
  headers,
  requestBody,
  correlationId,
  startedAt,
  admissionDeadline,
  fetchImpl,
  nowImpl,
  sleepImpl,
  randomImpl
}) {
  for (let attempt = 1; attempt <= MAX_CREATION_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        redirect: "error",
        signal: timeoutSignal(startedAt, nowImpl)
      });
    } catch (error) {
      throw unavailableError(error, correlationId, undefined, {
        phase: "creation",
        attemptCount: attempt,
        elapsedAdmissionMs: elapsedMs(startedAt, nowImpl)
      });
    }

    if (response.ok) return response;

    const serviceError = await response.json().catch(() => null);
    const upstreamCode = serviceError?.error?.code || null;
    const diagnostics = {
      correlationId,
      phase: "creation",
      attemptCount: attempt,
      elapsedAdmissionMs: elapsedMs(startedAt, nowImpl),
      upstreamStatus: response.status,
      requestId: response.headers.get("x-request-id") || serviceError?.error?.requestId || null,
      upstreamCode
    };

    if (response.status === 429 && upstreamCode === "rate_limited") {
      const retryAfter = response.headers.get("retry-after");
      throw new PdfCreationClientError("PDF creation is temporarily rate limited. Please try again in about a minute.", {
        code: "PDF_CREATION_RATE_LIMITED",
        status: 429,
        diagnostics,
        responseHeaders: retryAfter ? { "Retry-After": retryAfter } : {}
      });
    }

    if (response.status !== 429 || upstreamCode !== "renderer_busy") {
      if (response.status === 409 && upstreamCode === "idempotency_conflict") {
        throw new PdfCreationClientError("The report changed since the previous attempt. Download again to create the updated PDF.", {
          code: "PDF_REPORT_CHANGED", status: 409, diagnostics
        });
      }
      throw new PdfCreationClientError("The PDF could not be created.", { diagnostics });
    }

    if (attempt === MAX_CREATION_ATTEMPTS) {
      throw busyError({ ...diagnostics, retryFailure: "maximum-attempts-exhausted" });
    }

    let retryAfterSeconds;
    try {
      retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    } catch {
      throw new PdfCreationClientError("The PDF service returned an unusable busy response.", {
        diagnostics: { ...diagnostics, retryFailure: "invalid-retry-after" }
      });
    }

    let delayMs;
    try {
      delayMs = busyRetryDelayMs(attempt, retryAfterSeconds, randomImpl());
    } catch {
      throw new PdfCreationClientError("The PDF retry policy could not be applied.", {
        diagnostics: { ...diagnostics, retryFailure: "invalid-jitter-source" }
      });
    }

    const now = nowImpl();
    if (now >= admissionDeadline || now + delayMs >= admissionDeadline) {
      throw busyError({
        ...diagnostics,
        elapsedAdmissionMs: Math.max(0, now - startedAt),
        retryAfterSeconds,
        retryDelayMs: delayMs,
        retryFailure: "admission-deadline-exhausted"
      });
    }

    await sleepImpl(delayMs);
    const resumedAt = nowImpl();
    if (resumedAt >= admissionDeadline) {
      throw busyError({
        ...diagnostics,
        elapsedAdmissionMs: Math.max(0, resumedAt - startedAt),
        retryAfterSeconds,
        retryDelayMs: delayMs,
        retryFailure: "admission-deadline-exhausted"
      });
    }
  }

  throw busyError({ correlationId, retryFailure: "maximum-attempts-exhausted" });
}

async function directPdfResult(response, correlationId) {
  if (!isPdfResponse(response)) {
    throw new PdfCreationClientError("The PDF service returned an invalid response.", {
      diagnostics: { correlationId, phase: "creation", upstreamStatus: response.status }
    });
  }
  const pdf = new Uint8Array(await response.arrayBuffer());
  if (pdfSignature(pdf) !== "%PDF-") {
    throw new PdfCreationClientError("The PDF service returned an invalid response.", {
      diagnostics: { correlationId, phase: "creation" }
    });
  }
  return { pdf, diagnostics: {} };
}

function storedDownloadUrl(stored, endpoint, correlationId) {
  if (
    stored?.status !== "complete" ||
    stored?.caller !== "econplanner" ||
    typeof stored?.requestId !== "string" ||
    !/^r(?:1|7|30)_[0-9a-f-]+$/i.test(stored?.reportId || "") ||
    !Number.isSafeInteger(stored?.durationMs) || stored.durationMs < 0 ||
    !Number.isSafeInteger(stored?.pdfBytes) || stored.pdfBytes < 5 ||
    !Number.isInteger(stored?.pageCount) || stored.pageCount < 1 || stored.pageCount > 25 ||
    !/^[0-9a-f]{64}$/.test(stored?.sha256 || "") ||
    typeof stored?.links?.download !== "string"
  ) {
    throw invalidStoredResult(correlationId);
  }

  let downloadUrl;
  try {
    downloadUrl = new URL(stored.links.download);
  } catch {
    throw invalidStoredResult(correlationId);
  }
  if (
    downloadUrl.origin !== endpoint.origin ||
    downloadUrl.username ||
    downloadUrl.password ||
    downloadUrl.pathname !== `/reports/${stored.reportId}/download` ||
    downloadUrl.search ||
    downloadUrl.hash
  ) {
    throw invalidStoredResult(correlationId);
  }
  return downloadUrl;
}

function invalidStoredResult(correlationId) {
  return new PdfCreationClientError("The PDF service returned an invalid stored result.", {
    diagnostics: { correlationId, phase: "stored-metadata" }
  });
}

function busyError(diagnostics) {
  return new PdfCreationClientError("PDF creation is temporarily busy. Please try again.", {
    code: "PDF_CREATION_BUSY",
    status: 503,
    diagnostics
  });
}

function unavailableError(error, correlationId, message = "The PDF service could not be reached.", diagnostics = {}) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  return new PdfCreationClientError(
    timedOut ? "The PDF service took too long to respond." : message,
    {
      status: 502,
      diagnostics: { ...diagnostics, correlationId, failure: timedOut ? "timeout" : "network" }
    }
  );
}

function isPdfResponse(response) {
  return response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf");
}

function pdfSignature(pdf) {
  return new TextDecoder().decode(pdf.subarray(0, 5));
}

function elapsedMs(startedAt, nowImpl) {
  return Math.max(0, nowImpl() - startedAt);
}

function timeoutSignal(startedAt, nowImpl) {
  return AbortSignal.timeout(Math.max(1, REQUEST_TIMEOUT_MS - (nowImpl() - startedAt)));
}
