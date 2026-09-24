import { createHash } from "node:crypto";
import { canonicalJson } from "../policy/canonical-json.js";
import { loadPolicyBundle } from "../policy/load-bundle.js";
import { evaluatePlan } from "./plan.js";
import { decisionTraceId } from "./contracts.js";
import { normalizeStudentFacts, studentFactsHash } from "./student-facts.js";

const EXPECTED_REVIEW_RULES = new Set([
  "HISTORY-COMPLETED-ADVANCED-PRESERVED",
  "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
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
  // Review notices are independent of hard disagreements. Check the latter first.
  if (oracle && Boolean(oracle.valid) !== engineValid) return "UNEXPECTED_ENGINE_ORACLE_DISAGREEMENT";
  if (productionValid && !engineValid) return "UNEXPECTED_PRODUCTION_ACCEPT_ENGINE_BLOCK";
  const onlyReviewDifference = productionValid === engineValid || (
    !productionValid && engineValid && productionErrors.length > 0
    && productionErrors.every(error => /\bis full\b|\bwaitlist|availability.*(?:unknown|review)/i.test(error))
    && reviewRules.includes("SCHEDULE-AVAILABILITY-BEHAVIOR")
  );
  if (onlyReviewDifference && reviewRules.length
    && reviewRules.every(ruleId => EXPECTED_REVIEW_RULES.has(ruleId))) return "KNOWN_REVIEW_STATE";
  if (!productionValid && engineValid && productionErrors.length && productionErrors.every(softStrategyError)) return "KNOWN_SOFT_STRATEGY_DIFFERENCE";
  if (!productionValid && engineValid && productionErrors.length && productionErrors.every(error => /canonical verified schedule/i.test(error))) return "KNOWN_SCHEDULE_INTEGRITY_DIFFERENCE";
  if (!productionValid && engineValid
    && productionErrors.some(planningContextError)
    && productionErrors.every(error => planningContextError(error) || softStrategyError(error))) return "KNOWN_PLANNING_CONTEXT_DIFFERENCE";
  if (productionValid === engineValid && (oracle === null || Boolean(oracle.valid) === engineValid)) return productionValid ? "AGREEMENT_ALLOW" : "AGREEMENT_BLOCK";
  if (!productionValid && engineValid) return "UNEXPECTED_PRODUCTION_BLOCK_ENGINE_ACCEPT";
  return "UNEXPECTED_UNCLASSIFIED_DISAGREEMENT";
}

export function buildDecisionComparisonRecord({
  student,
  plan,
  productionValidation,
  engine,
  oracle = null,
  source = "unknown",
  mode = "AUTHORITATIVE_REUSED",
  latencyMs = null,
  scheduleReleaseId = null
}) {
  if (!engine?.decisions || !engine.policyBundleVersion || !engine.policyBundleHash) {
    throw new Error("A complete structured Production Decision Engine result is required for observability.");
  }
  const facts = normalizeStudentFacts(student);
  const traceId = engine.traceId || decisionTraceId({
    profile: studentFactsHash(facts),
    plan: hash(plan),
    source,
    bundle: engine.policyBundleHash
  });
  const classification = classifyShadowDisagreement(productionValidation, engine, oracle);
  const reviewFindings = (engine.reviewFindings || engine.decisions.filter(decision => decision.status === "REVIEW_REQUIRED"))
    .map(decision => ({
      decisionId: decision.decisionId,
      ruleIds: decision.ruleIds,
      reasonCode: decision.reasonCode,
      sourceRefs: decision.sourceRefs,
      ...(decision.policyDisposition ? { policyDisposition: decision.policyDisposition } : {}),
      ...(decision.provenance ? { provenance: decision.provenance } : {})
    }));
  return Object.freeze({
    schemaVersion: "1.0.0",
    mode,
    evaluationSource: mode === "AUTHORITATIVE_REUSED" ? "PLAN_VALIDATION_POLICY_DECISION" : "SEPARATE_SHADOW_EVALUATION",
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
    reviewFindings,
    decisionCount: engine.decisions.length,
    latencyMs: Number.isFinite(Number(latencyMs ?? engine.latencyMs)) ? Number(latencyMs ?? engine.latencyMs) : null,
    policyBundleVersion: engine.policyBundleVersion,
    policyBundleHash: engine.policyBundleHash,
    scheduleReleaseId
  });
}

export async function runDecisionEngineShadow({ student, plan, productionValidation, catalogYear = "2025-2026", context = {}, oracle = null, bundle = null, source = "unknown" }) {
  const policyBundle = bundle || await loadPolicyBundle({ catalogYear, allowPending: true });
  const facts = normalizeStudentFacts(student);
  const traceId = decisionTraceId({ profile: studentFactsHash(facts), plan: hash(plan), source, bundle: policyBundle.contentHash });
  const engine = evaluatePlan(plan, facts, { ...context, traceId }, policyBundle);
  return buildDecisionComparisonRecord({
    student,
    plan,
    productionValidation,
    engine,
    oracle,
    source,
    mode: "SHADOW_NONAUTHORITATIVE",
    latencyMs: engine.latencyMs,
    scheduleReleaseId: policyBundle.releaseRefs?.schedule || null
  });
}

export function recordShadowEvaluation(record, sink = console.info) {
  sink(`ECONPLANNER_DECISION_SHADOW ${JSON.stringify(record)}`);
  return record;
}

export function recordDecisionComparisonSafely(args, { sink = console.info, errorSink = console.warn } = {}) {
  try {
    return recordShadowEvaluation(buildDecisionComparisonRecord(args), sink);
  } catch (error) {
    const failure = { mode: args.mode || "AUTHORITATIVE_REUSED", source: args.source || "unknown", classification: "DECISION_OBSERVABILITY_ERROR", errorCode: error.code || "OBSERVABILITY_ERROR" };
    errorSink(`ECONPLANNER_DECISION_SHADOW_ERROR ${JSON.stringify(failure)}`);
    return failure;
  }
}
