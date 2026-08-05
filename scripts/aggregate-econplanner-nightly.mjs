import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAggregate,
  comparisonArtifact,
  renderSummaryMarkdown
} from "../lib/nightly/econplannerMetrics.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = path.join(ROOT, "test-results", "econplanner-nightly");
const DEFAULT_OUTPUT = path.join(DEFAULT_INPUT, "final");
const FIXTURES = path.join(ROOT, "tests", "fixtures");

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

function absolutePath(value, fallback) {
  return path.resolve(ROOT, value || fallback);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function jsonFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
    }
  }
  await visit(directory);
  return files.sort();
}

function firstByKind(items, kind) {
  return items.find(item => item.value?.kind === kind)?.value || null;
}

function phaseRecords(items) {
  return items.filter(item => item.value?.kind === "econplanner-nightly-phase").map(item => item.value);
}

function notificationRecords(items) {
  return items.filter(item => item.value?.kind === "econplanner-notification-delivery").map(item => item.value);
}

function combinedPdf(items) {
  const records = items.filter(item => item.value?.kind === "econplanner-nightly-pdf").map(item => item.value);
  if (!records.length) return null;
  const hosted = records.find(record => record.hosted?.configuration !== "NOT_APPLICABLE")?.hosted
    || records.find(record => record.hosted)?.hosted
    || null;
  const local = records.find(record => record.local?.status === "PASSED")?.local
    || records.find(record => record.local)?.local
    || null;
  return {
    schemaVersion: 2,
    kind: "econplanner-nightly-pdf",
    local,
    hosted,
    records
  };
}

function gitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

async function readInputs(directory, outputDirectory) {
  const files = (await jsonFiles(directory)).filter(file => !path.resolve(file).startsWith(`${path.resolve(outputDirectory)}${path.sep}`));
  const items = [];
  for (const file of files) {
    try {
      items.push({ file, value: await readJson(file) });
    } catch (error) {
      items.push({ file, value: null, parseError: error.message });
    }
  }
  return items;
}

function provenance(args) {
  const commitSha = args["commit-sha"] || process.env.GITHUB_SHA || gitValue(["rev-parse", "HEAD"]);
  const originMainSha = args["origin-main-sha"]
    || gitValue(["rev-parse", "origin/main"])
    || (process.env.GITHUB_REF_NAME === "main" ? process.env.GITHUB_SHA || null : null);
  const worktreeOutput = gitValue(["status", "--porcelain"]);
  return {
    repository: process.env.GITHUB_REPOSITORY || gitValue(["config", "--get", "remote.origin.url"]),
    commitSha,
    originMainSha,
    headMatchesOriginMain: commitSha && originMainSha ? commitSha === originMainSha : null,
    branch: process.env.GITHUB_REF_NAME || gitValue(["branch", "--show-current"]),
    workflowName: process.env.GITHUB_WORKFLOW || null,
    workflowRunId: Number(process.env.GITHUB_RUN_ID) || null,
    workflowAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || null,
    startedAt: args["started-at"] || process.env.ECONPLANNER_NIGHTLY_START_TIME || null,
    completedAt: args["completed-at"] || new Date().toISOString(),
    worktreeStatus: worktreeOutput === null ? "UNKNOWN" : worktreeOutput ? "DIRTY" : "CLEAN",
    provenanceSource: process.env.GITHUB_SHA ? "GITHUB_ACTIONS" : "LOCAL_GIT",
    nodeVersion: process.version,
    metricSchemaVersion: 2
  };
}

export async function aggregateNightly(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const inputDirectory = absolutePath(args.input, path.relative(ROOT, DEFAULT_INPUT));
  const outputDirectory = absolutePath(args.output, path.relative(ROOT, DEFAULT_OUTPUT));
  const baseline = await readJson(absolutePath(args.baseline, path.relative(ROOT, path.join(FIXTURES, "econplanner-nightly-baseline.v1.json"))));
  const baselineCases = await readJson(absolutePath(args["baseline-cases"], path.relative(ROOT, path.join(FIXTURES, "econplanner-nightly-baseline-cases.v1.json"))));
  const observabilityPolicy = await readJson(absolutePath(args.policy, path.relative(ROOT, path.join(FIXTURES, "econplanner-observability-policy.v1.json"))));
  const oraclePolicy = await readJson(absolutePath(args["oracle-policy"], path.relative(ROOT, path.join(ROOT, "tests", "oracle", "economics-policy.v1.json"))));
  const mutationRegistry = await readJson(absolutePath(args.mutations, path.relative(ROOT, path.join(FIXTURES, "economics-validator-disagreements.v1.json"))));
  const items = await readInputs(inputDirectory, outputDirectory);
  const shards = items.filter(item => item.value?.kind === "econplanner-nightly-generated-matrix").map(item => item.value);
  const previous = args.previous ? await readJson(absolutePath(args.previous)) : null;
  const prerequisite = firstByKind(items, "econplanner-nightly-prerequisites");
  const browser = firstByKind(items, "econplanner-nightly-browser");
  const pdf = combinedPdf(items);
  const sourceEvidence = firstByKind(items, "econplanner-source-evidence");
  const phases = phaseRecords(items);
  const notifications = notificationRecords(items);
  let aggregate;
  try {
    const malformed = items.filter(item => item.parseError);
    if (malformed.length) {
      const error = new Error(`Malformed JSON artifacts: ${malformed.map(item => path.relative(ROOT, item.file)).join(", ")}`);
      error.code = "MALFORMED_ARTIFACT";
      throw error;
    }
    aggregate = buildAggregate({
      shards,
      prerequisite,
      browser,
      pdf,
      phases,
      notifications,
      baseline,
      baselineCases,
      previous,
      observabilityPolicy,
      oraclePolicy,
      mutationRegistry,
      sourceEvidence,
      provenance: provenance(args)
    });
  } catch (error) {
    aggregate = failedAggregate({ error, args, items, phases, notifications });
  }
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "econplanner-nightly-aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`),
    writeFile(path.join(outputDirectory, "econplanner-nightly-comparison.json"), `${JSON.stringify(comparisonArtifact(aggregate), null, 2)}\n`),
    writeFile(path.join(outputDirectory, "econplanner-nightly-summary.md"), renderSummaryMarkdown(aggregate))
  ]);
  process.stdout.write(`${JSON.stringify({ outputDirectory: path.relative(ROOT, outputDirectory), gateStatus: aggregate.gateStatus })}\n`);
  return aggregate;
}

function failedAggregate({ error, args, items, phases, notifications }) {
  const runProvenance = provenance(args);
  return {
    schemaVersion: 2,
    kind: "econplanner-nightly-aggregate",
    generatedAt: new Date().toISOString(),
    dataClassification: "fictional-test-only",
    gateStatus: "RED",
    provenance: runProvenance,
    governance: {
      baselineSnapshotReview: "UNKNOWN_DUE_TO_AGGREGATION_FAILURE",
      ruleRegistryReview: "UNKNOWN_DUE_TO_AGGREGATION_FAILURE",
      ownerApprovalComplete: false
    },
    artifactCompleteness: {
      expected: null,
      present: items.length,
      missing: ["AGGREGATION_INPUT_INVALID"],
      presentKinds: [...new Set(items.map(item => item.value?.kind).filter(Boolean))]
    },
    coverage: { profiles: { tested: 0, withPlans: 0, noPlans: 0, failures: 0, acceptedPlans: 0 } },
    noPlan: { total: 0, explained: 0, unexplained: 0, reasons: {}, rows: [] },
    solver: { acceptedPlanNodes: { total: 0, p50: 0, p95: 0, maximum: 0 }, slowestProfiles: [] },
    validation: { aggregationFailure: { code: error.code || "AGGREGATION_FAILED", message: error.message } },
    browser: null,
    pdf: null,
    workflow: { phases, notifications, wallTimeMs: null, computeTimeMs: 0 },
    comparison: {
      approvedBaseline: { availability: "NOT_AVAILABLE_DUE_TO_AGGREGATION_FAILURE", metrics: {} },
      previousSuccessful: { availability: "NOT_AVAILABLE_DUE_TO_AGGREGATION_FAILURE" }
    },
    gates: {
      overall: "RED",
      red: [{ code: error.code || "AGGREGATION_FAILED", message: error.message }],
      amber: []
    }
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await aggregateNightly();
  } catch (error) {
    process.stderr.write(`${error.code || "AGGREGATION_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
