import { createHash } from "node:crypto";
import { canonicalJson } from "../policy/canonical-json.js";
import { loadPolicyBundle } from "../policy/load-bundle.js";
import { evaluatePlan } from "./plan.js";
import { decisionTraceId } from "./contracts.js";
import { normalizeStudentFacts, studentFactsHash } from "./student-facts.js";

const EXPECTED_REVIEW_RULES = new Set([
  "HISTORY-COMPLETED-ADVANCED-PRESERVED",
  "SCHEDULE-AVAILABILITY-BEHAVIOR"
]);

function hash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function classifyShadowDisagreement(production, engine, oracle = null) {
  const productionValid = Boolean(production?.valid);
  const engineValid = Boolean(engine?.academicallyValid);
  const productionErrors = production?.errors || [];
  const planningContextError = error => /graduation planning horizon|authoritative projected standing|invalid senior-standing basis|planning-horizon placeholder|final permitted planning slot|resolved planning horizon|authoritative planning slot/i.test(error);
  const softStrategyError = error => /distribution|yearly design/i.test(error);
  const reviewRules = engine.decisions.filter(decision => decision.status === "REVIEW_REQUIRED").flatMap(decision => decision.ruleIds);
  if (reviewRules.some(ruleId => EXPECTED_REVIEW_RULES.has(ruleId))) return "KNOWN_REVIEW_STATE";
  if (!productionValid && engineValid && productionErrors.length && productionErrors.every(softStrategyError)) return "KNOWN_SOFT_STRATEGY_DIFFERENCE";
  if (!productionValid && engineValid && productionErrors.length && productionErrors.every(error => /canonical verified schedule/i.test(error))) return "KNOWN_SCHEDULE_INTEGRITY_DIFFERENCE";
  if (!productionValid && engineValid
    && productionErrors.some(planningContextError)
    && productionErrors.every(error => planningContextError(error) || softStrategyError(error))) return "KNOWN_PLANNING_CONTEXT_DIFFERENCE";
  if (productionValid === engineValid && (oracle === null || Boolean(oracle.valid) === engineValid)) return productionValid ? "AGREEMENT_ALLOW" : "AGREEMENT_BLOCK";
  if (productionValid && !engineValid) return "UNEXPECTED_PRODUCTION_ACCEPT_ENGINE_BLOCK";
  if (!productionValid && engineValid) return "UNEXPECTED_PRODUCTION_BLOCK_ENGINE_ACCEPT";
  if (oracle && Boolean(oracle.valid) !== engineValid) return "UNEXPECTED_ENGINE_ORACLE_DISAGREEMENT";
  return "UNEXPECTED_UNCLASSIFIED_DISAGREEMENT";
}

export async function runDecisionEngineShadow({ student, plan, productionValidation, catalogYear = "2025-2026", context = {}, oracle = null, bundle = null, source = "unknown" }) {
  const policyBundle = bundle || await loadPolicyBundle({ catalogYear, allowPending: true });
  const facts = normalizeStudentFacts(student);
  const traceId = decisionTraceId({ profile: studentFactsHash(facts), plan: hash(plan), source, bundle: policyBundle.contentHash });
  const engine = evaluatePlan(plan, facts, { ...context, traceId }, policyBundle);
  const classification = classifyShadowDisagreement(productionValidation, engine, oracle);
  return Object.freeze({
    schemaVersion: "1.0.0",
    mode: "SHADOW_NONAUTHORITATIVE",
    source,
    traceId,
    profileHash: studentFactsHash(facts),
    planHash: hash(plan),
    productionValid: Boolean(productionValidation?.valid),
    engineStatus: engine.status,
    completionStatus: engine.completionStatus,
    evidenceStatus: engine.evidenceStatus,
    engineAcademicallyValid: engine.academicallyValid,
    oracleValid: oracle === null ? null : Boolean(oracle.valid),
    classification,
    unexpected: classification.startsWith("UNEXPECTED_"),
    ruleIds: [...new Set(engine.decisions.flatMap(decision => decision.ruleIds))].sort(),
    reasonCodes: [...new Set(engine.decisions.map(decision => decision.reasonCode))].sort(),
    decisionCount: engine.decisions.length,
    latencyMs: engine.latencyMs,
    policyBundleVersion: policyBundle.bundleVersion,
    policyBundleHash: policyBundle.contentHash
  });
}

export function recordShadowEvaluation(record, sink = console.info) {
  sink(`ECONPLANNER_DECISION_SHADOW ${JSON.stringify(record)}`);
  return record;
}

export async function runShadowSafely(args, { sink = console.info, errorSink = console.warn } = {}) {
  try {
    return recordShadowEvaluation(await runDecisionEngineShadow(args), sink);
  } catch (error) {
    const failure = { mode: "SHADOW_NONAUTHORITATIVE", source: args.source || "unknown", classification: "SHADOW_EXECUTION_ERROR", errorCode: error.code || "SHADOW_ERROR" };
    errorSink(`ECONPLANNER_DECISION_SHADOW_ERROR ${JSON.stringify(failure)}`);
    return failure;
  }
}
