import test from "node:test";
import assert from "node:assert/strict";
import { createGeneratedPlannerSession } from "../lib/planning/uiState.js";
import { validateSavedPlannerSession } from "../lib/planning/session-restoration.js";

const fingerprint = "sha256:current";
const plans = ["balanced", "explore-first", "one-year-early"].map(id => ({ id, validation: { valid: true }, terms: [{ term: "Winter 2027", courses: [{ course: "MAT 217" }] }] }));
const saved = () => JSON.stringify(createGeneratedPlannerSession({
  report: { plannerFingerprint: fingerprint, programs: [{ program: { name: "Economics" }, economicsPlans: plans }] },
  inputSignature: "student", selectedPlanId: "one-year-early", view: "plan", reportContextId: "report",
  planEditUndo: { reportContextId: "report", inputSignature: "student", planId: "one-year-early", plan: { ...plans[2], undo: true } }
}));
const run = (fetchImpl, options = {}) => validateSavedPlannerSession({ rawSession: saved(), inputSignature: "student", student: {}, fetchImpl, ...options });
const validFetch = async (_url, options) => options.method === "POST"
  ? Response.json({ plan: JSON.parse(options.body).plan, planSetValidation: { valid: true } })
  : Response.json({ plannerFingerprint: fingerprint });

test("all plans and undo are revalidated with the complete comparison set before restoring selection and edits", async () => {
  const checked = [];
  const rawSession = saved();
  const result = await run(async (url, options) => {
    if (options.method === "POST") checked.push(JSON.parse(options.body));
    return validFetch(url, options);
  }, { rawSession });
  assert.equal(result.kind, "restored");
  assert.equal(result.session.selectedPlanId, "one-year-early");
  assert.equal(result.session.planEditUndo.plan.undo, true);
  assert.equal(checked.length, 4);
  for (const body of checked) assert.deepEqual(body.plans, plans);
  assert.equal(rawSession, saved(), "restoration cannot mutate the original saved data");
});

test("interrupted and slow validation are recoverable, and a later retry validates the same data", async () => {
  for (const mode of ["timeout", "network", "server", "malformed"]) {
    const original = saved();
    const result = await run(async (url, options) => {
      if (options.method !== "POST") return validFetch(url, options);
      if (mode === "server") return new Response("unavailable", { status: 503 });
      if (mode === "malformed") return Response.json({ plan: {} });
      if (mode === "network") throw new TypeError("Failed to fetch");
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Interrupted", "AbortError")), { once: true }));
    }, { rawSession: original, validationTimeoutMs: 5 });
    assert.equal(result.kind, "unavailable", mode);
    assert.equal(original, saved());
    assert.equal((await run(validFetch, { rawSession: original })).kind, "restored");
  }
});

test("fingerprint interruption is unavailable; stale policy, mismatched inputs and malformed saved data are obsolete", async () => {
  assert.equal((await run(async () => new Response("", { status: 503 }))).kind, "unavailable");
  for (const options of [{ inputSignature: "new answers" }, { rawSession: "{" }, { rawSession: saved().replace(fingerprint, "sha256:old") }]) {
    assert.equal((await run(validFetch, options)).kind, "obsolete");
  }
});

test("academic rejection is distinct from interruption, including rejected undo", async () => {
  assert.equal((await run(async (url, options) => options.method === "POST" ? new Response("invalid academic plan", { status: 422 }) : validFetch(url, options))).kind, "invalid");
  const result = await run(async (url, options) => options.method === "POST" && JSON.parse(options.body).plan.undo
    ? new Response("invalid undo", { status: 422 }) : validFetch(url, options));
  assert.equal(result.kind, "restored");
  assert.equal(result.session.planEditUndo, null);
});

test("cancellation cannot authorize restoring a completed but outdated response", async () => {
  const controller = new AbortController();
  const result = await run(async (url, options) => {
    if (options.method === "POST") controller.abort();
    return validFetch(url, options);
  }, { signal: controller.signal });
  assert.equal(result.kind, "unavailable");
});
