import { economicsResultFromReport, replaceEconomicsPlan, restoreGeneratedPlannerSession } from "./uiState.js";

// Saved presentation is never authority. Restore only after current-policy and
// complete academic validation; transport failures leave the original recoverable.
export async function validateSavedPlannerSession({ rawSession, inputSignature, student,
  signal, fetchImpl = fetch, fingerprintTimeoutMs = 5000, validationTimeoutMs = 15000 }) {
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
    const fingerprint = await request({ cache: "no-store" }, fingerprintTimeoutMs);
    if (fingerprint.kind !== "response") return fingerprint;
    if (typeof fingerprint.data?.plannerFingerprint !== "string" || !fingerprint.data.plannerFingerprint) throw new Error("Policy verification unavailable");
    const session = restoreGeneratedPlannerSession(rawSession, inputSignature, fingerprint.data.plannerFingerprint);
    if (!session) return { kind: "obsolete" };
    const plans = economicsResultFromReport(session.report)?.economicsPlans || [];
    async function validate(plan) {
      const result = await request({ method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate-plan", student, plan, plans }) }, validationTimeoutMs);
      if (result.kind !== "response") return result;
      if (result.data.plan?.validation?.valid === false || result.data.planSetValidation?.valid === false) return { kind: "invalid" };
      if (!result.data.plan?.validation?.valid || result.data.plan.id !== plan.id
        || result.data.planSetValidation?.valid !== true) throw new Error("Incomplete validation response");
      return result;
    }
    // Each request still validates the full comparison set. Parallel restoration
    // avoids a shared deadline expiring while earlier plans are being checked.
    const results = await Promise.all(plans.map(validate));
    const rejected = results.find(result => result.kind !== "response");
    if (rejected) return rejected;
    for (let index = 0; index < plans.length; index += 1) {
      const { plan, planSetValidation } = results[index].data;
      session.report = replaceEconomicsPlan(session.report, plans[index].id, plan, planSetValidation);
    }
    if (session.planEditUndo) {
      const undo = await validate(session.planEditUndo.plan);
      if (undo.kind === "response") session.planEditUndo = { ...session.planEditUndo, plan: undo.data.plan, planSetValidation: undo.data.planSetValidation };
      else session.planEditUndo = null;
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
