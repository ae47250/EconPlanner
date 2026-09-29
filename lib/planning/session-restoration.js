import { economicsResultFromReport, replaceEconomicsPlan, restoreGeneratedPlannerSession } from "./uiState.js";
import { compactEconomicsPlanForValidation } from "./validation-payload.js";

// Saved presentation is never authority. Restore only after current-policy and
// complete academic validation; transport failures leave the original recoverable.
export async function validateSavedPlannerSession({ rawSession, inputSignature, student,
  signal, fetchImpl = fetch, onProgress = () => {}, fingerprintTimeoutMs = 5000, validationTimeoutMs = 30000 }) {
  if (!rawSession) return { kind: "empty" };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  async function request(options, timeoutMs) {
    const requestController = new AbortController();
    const abort = () => requestController.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl("/api/majors/map", { ...options, signal: requestController.signal });
      if ([400, 422].includes(response.status)) return { kind: "invalid" };
      if (response.status === 409) return { kind: "obsolete" };
      if (!response.ok) throw new Error("Validation unavailable");
      return { kind: "response", data: await response.json() };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
    }
  }
  try {
    onProgress("Checking current policy…");
    const fingerprint = await request({ cache: "no-store" }, fingerprintTimeoutMs);
    if (fingerprint.kind !== "response") return fingerprint;
    if (typeof fingerprint.data?.plannerFingerprint !== "string" || !fingerprint.data.plannerFingerprint) throw new Error("Policy verification unavailable");
    const session = restoreGeneratedPlannerSession(rawSession, inputSignature, fingerprint.data.plannerFingerprint);
    if (!session) return { kind: "obsolete" };
    const plans = economicsResultFromReport(session.report)?.economicsPlans || [];
    const inputs = plans.map(compactEconomicsPlanForValidation);
    const total = plans.length + (session.planEditUndo ? 1 : 0);
    let step = 0;
    async function validate(plan) {
      onProgress(`Checking saved plans: ${++step} of ${total}…`);
      const result = await request({ method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate-plan", student, plan: compactEconomicsPlanForValidation(plan), plans: inputs }) }, validationTimeoutMs);
      if (result.kind !== "response") return result;
      if (result.data.plan?.validation?.valid === false || result.data.planSetValidation?.valid === false) return { kind: "invalid" };
      if (!result.data.plan?.validation?.valid || result.data.plan.id !== plan.id
        || result.data.planSetValidation?.valid !== true) throw new Error("Incomplete validation response");
      return result;
    }
    // The hosted validator rebuilds controls synchronously. Concurrent requests
    // unnecessarily overlap expensive work. Each bounded step still validates
    // the full comparison set and reports progress.
    for (const savedPlan of plans) {
      const result = await validate(savedPlan);
      if (result.kind !== "response") return result;
      const { plan, planSetValidation } = result.data;
      session.report = replaceEconomicsPlan(session.report, savedPlan.id, plan, planSetValidation);
    }
    if (session.planEditUndo) {
      const undo = await validate(session.planEditUndo.plan);
      if (undo.kind === "response") session.planEditUndo = { ...session.planEditUndo, plan: undo.data.plan, planSetValidation: undo.data.planSetValidation };
      else if (undo.kind === "invalid" || undo.kind === "obsolete") session.planEditUndo = null;
      else return undo;
    }
    if (controller.signal.aborted) throw new Error("Validation interrupted");
    return { kind: "restored", session };
  } catch {
    return { kind: "unavailable" };
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", cancel);
  }
}
