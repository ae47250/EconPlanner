import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("A command is required after --.");
  const options = argv.slice(0, separator);
  const command = argv.slice(separator);
  const values = { expectedArtifacts: [] };
  for (let index = 0; index < options.length; index += 1) {
    const key = options[index];
    if (key === "--optional") {
      values.required = false;
      continue;
    }
    const value = options[index + 1];
    if (!key.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid phase option: ${key}`);
    if (key === "--expect-artifact") values.expectedArtifacts.push(value);
    else values[key.slice(2)] = value;
    index += 1;
  }
  return {
    phaseId: values.phase,
    output: values.output,
    log: values.log,
    timeoutMs: Number(values["timeout-ms"] || 900_000),
    required: values.required !== false,
    expectedArtifacts: values.expectedArtifacts,
    executable: command[1],
    commandArguments: command.slice(2)
  };
}

function rootPath(value) {
  return path.resolve(ROOT, value);
}

function tapCounts(log) {
  const match = [...String(log).matchAll(/(?:^|\n)(?:#|ℹ)\s*(tests|pass|fail|skipped|cancelled)\s+(\d+)/gi)];
  const counts = {};
  for (const [, name, value] of match) counts[name.toLowerCase()] = Number(value);
  return counts;
}

async function artifactState(expectedArtifacts) {
  const present = [];
  const missing = [];
  const { access } = await import("node:fs/promises");
  for (const artifact of expectedArtifacts) {
    try {
      await access(rootPath(artifact));
      present.push(artifact);
    } catch {
      missing.push(artifact);
    }
  }
  return { expected: expectedArtifacts, present, missing };
}

export async function runPhase(argv = process.argv.slice(2)) {
  const configuration = parseArguments(argv);
  if (!configuration.phaseId || !configuration.output || !configuration.executable) throw new Error("--phase, --output, and a command are required.");
  if (!Number.isFinite(configuration.timeoutMs) || configuration.timeoutMs <= 0) throw new Error("--timeout-ms must be positive.");
  const output = rootPath(configuration.output);
  const logFile = rootPath(configuration.log || `${configuration.output}.log`);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.dirname(logFile), { recursive: true });
  const startedAt = new Date().toISOString();
  const base = {
    schemaVersion: 2,
    kind: "econplanner-nightly-phase",
    phaseId: configuration.phaseId,
    required: configuration.required,
    status: "NOT_ATTEMPTED",
    startedAt,
    durationMs: 0,
    timeoutMs: configuration.timeoutMs,
    command: [configuration.executable, ...configuration.commandArguments],
    exitCode: null,
    signal: null,
    tap: {},
    artifacts: { expected: configuration.expectedArtifacts, present: [], missing: configuration.expectedArtifacts }
  };
  await writeFile(output, `${JSON.stringify(base, null, 2)}\n`);
  const start = performance.now();
  let log = "";
  let timedOut = false;
  const child = spawn(configuration.executable, configuration.commandArguments, {
    cwd: ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["inherit", "pipe", "pipe"]
  });
  const forward = (stream, target) => stream.on("data", chunk => {
    const text = chunk.toString();
    log += text;
    target.write(text);
  });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, configuration.timeoutMs);
  let spawnError = null;
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).catch(error => {
    spawnError = error;
    log += `\nPHASE_SPAWN_ERROR: ${error.message}\n`;
    return { exitCode: null, signal: null };
  }).finally(() => clearTimeout(timeout));
  await writeFile(logFile, log);
  const artifacts = await artifactState(configuration.expectedArtifacts);
  const commandStatus = timedOut ? "TIMED_OUT" : !spawnError && result.exitCode === 0 ? "PASSED" : "FAILED";
  const status = commandStatus === "PASSED" && configuration.required && artifacts.missing.length
    ? "FAILED"
    : commandStatus;
  const record = {
    ...base,
    status,
    commandStatus,
    completedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError: spawnError ? spawnError.message : null,
    tap: tapCounts(log),
    artifacts
  };
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
  if (status !== "PASSED" || (configuration.required && artifacts.missing.length)) process.exitCode = 1;
  return record;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await runPhase();
  } catch (error) {
    process.stderr.write(`PHASE_WRAPPER_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
