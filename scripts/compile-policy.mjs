import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, canonicalSha256 } from "../lib/policy/canonical-json.js";
import { buildCompatibilityRepresentations } from "../lib/policy/compatibility-projection.js";
import { sourceEvidenceSha256 } from "../lib/source-evidence-hash.js";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "policy/manifest/econ-2025-2026.1.json";
const SCHEMA_PATHS = [
  "policy/schema/policy-record.v1.schema.json",
  "policy/schema/policy-manifest.v1.schema.json",
  "policy/schema/schedule-release.v1.schema.json",
  "policy/schema/preliminary-schedules.v1.schema.json",
  "policy/schema/offering-pattern.v1.schema.json",
  "policy/schema/historical-offering.v1.schema.json",
  "policy/schema/approval-instance.v1.schema.json",
  "policy/schema/message-catalog.v1.schema.json"
];
const NORMALIZED_COMPATIBILITY_PATH = "data/normalized/economics";

function fail(message) {
  throw new Error(`Policy compilation failed: ${message}`);
}

function repositoryPath(repositoryRoot, relativePath) {
  const resolved = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`path escapes repository: ${relativePath}`);
  return resolved;
}

async function readJson(repositoryRoot, relativePath) {
  return JSON.parse(await readFile(repositoryPath(repositoryRoot, relativePath), "utf8"));
}

async function writeCanonicalIfChanged(filePath, document) {
  const bytes = canonicalJson(document);
  try {
    const currentBytes = await readFile(filePath, "utf8");
    try {
      if (canonicalJson(JSON.parse(currentBytes)) === bytes) return;
    } catch {
      // Replace a malformed generated file with the canonical projection below.
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(filePath, bytes);
}

async function writeTextIfChanged(filePath, bytes, equivalent = current => current === bytes) {
  try {
    if (equivalent(await readFile(filePath, "utf8"))) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(filePath, bytes);
}

function createValidator(schemaEntries) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  for (const [, schema] of schemaEntries) ajv.addSchema(schema);
  return ajv;
}

function validateDocument(ajv, schema, document, label) {
  const validate = ajv.getSchema(schema.$id);
  if (!validate?.(document)) fail(`${label}: ${ajv.errorsText(validate?.errors, { separator: "; " })}`);
}

function flattenRecords(inputs) {
  return inputs.flatMap(input => input.document.records ?? []);
}

function indexRules(rules) {
  const byRuleId = Object.fromEntries(rules.map(rule => [rule.ruleId, rule]));
  const byCourse = {};
  const byRequirement = {};
  for (const rule of rules) {
    for (const course of rule.scope.courses) (byCourse[course] ??= []).push(rule.ruleId);
    for (const requirement of rule.scope.requirements) (byRequirement[requirement] ??= []).push(rule.ruleId);
  }
  for (const index of [byCourse, byRequirement]) {
    for (const key of Object.keys(index)) index[key].sort();
  }
  return { byRuleId, byCourse, byRequirement };
}

function prerequisiteClosure(rules) {
  const direct = Object.fromEntries(
    rules
      .filter(rule => rule.ruleType === "coursePrerequisite")
      .map(rule => [rule.condition.course, [...(rule.effect.allOf ?? []), ...(rule.effect.oneOfGroups ?? []).flat()]])
  );
  const closure = {};
  for (const course of Object.keys(direct).sort()) {
    const found = new Set();
    const visit = candidate => {
      for (const prerequisite of direct[candidate] ?? []) {
        if (found.has(prerequisite)) continue;
        found.add(prerequisite);
        visit(prerequisite);
      }
    };
    visit(course);
    closure[course] = [...found].sort();
  }
  return closure;
}

function offeringIndex(schedule) {
  return Object.fromEntries(schedule.terms.map(term => [term.termId, {
    canonicalTerm: term.canonicalTerm,
    coverage: term.coverage,
    displayLabel: term.displayLabel,
    sections: term.sections
  }]));
}

export function preliminaryOfferingIndex(preliminary, exactSchedule, provenance) {
  const sources = new Map(provenance.sources.map(source => [source.sourceId, source]));
  const index = {};
  const releaseIds = new Set();
  for (const release of preliminary.releases) {
    if (releaseIds.has(release.releaseId)) fail(`duplicate preliminary release ${release.releaseId}`);
    releaseIds.add(release.releaseId);
    for (const ref of release.sourceRefs) {
      const source = sources.get(ref.split("#")[0]);
      if (!source?.path || !source.sha256) fail(`preliminary release ${release.releaseId} needs archived, hashed schedule evidence for ${ref}`);
    }
    for (const term of release.terms) {
      const match = term.termId.match(/^(\d{4})-(FALL|WINTER|MAY|SUMMER)$/);
      const expectedYear = match[2] === "FALL" ? release.academicYear.slice(0, 4) : release.academicYear.slice(5);
      if (match[1] !== expectedYear) fail(`preliminary term ${term.termId} is outside ${release.academicYear}`);
      if (exactSchedule.terms.some(exact => exact.termId === term.termId)) fail(`preliminary term ${term.termId} overlaps the active exact schedule`);
      if (index[term.termId]) fail(`duplicate preliminary term ${term.termId}`);
      index[term.termId] = {
        releaseId: release.releaseId,
        issuedOn: release.issuedOn,
        sourceRefs: release.sourceRefs,
        courses: [...term.courses].sort()
      };
    }
  }
  return index;
}

function validateCriticalConflicts({ rules, schedule, unresolved, offeringPatterns, historicalOfferings }) {
  const unresolvedIds = new Set(unresolved.questions.map(question => question.ruleId));
  for (const rule of rules) if (unresolvedIds.has(rule.ruleId)) fail(`${rule.ruleId} is both active and unresolved`);

  const prerequisiteTargets = rules.filter(rule => rule.ruleType === "coursePrerequisite").map(rule => rule.condition.course);
  if (new Set(prerequisiteTargets).size !== prerequisiteTargets.length) fail("overlapping active prerequisite records require supersession");
  const termIds = schedule.terms.map(term => term.termId);
  if (new Set(termIds).size !== termIds.length) fail("duplicate schedule term ID");
  const sectionIds = schedule.terms.flatMap(term => term.sections.map(section => section.sectionId));
  if (new Set(sectionIds).size !== sectionIds.length) fail("duplicate schedule section ID");
  const patternIds = offeringPatterns.patterns.map(pattern => pattern.patternId);
  if (new Set(patternIds).size !== patternIds.length) fail("duplicate offering-pattern ID");
  const activeHistoricalRecords = historicalOfferings.records.filter(record => record.activationStatus === "ACTIVE_OWNER_APPROVED");
  if (historicalOfferings.activationStatus === "ACTIVE_OWNER_APPROVED" && historicalOfferings.ownerApproval.approved !== true) {
    fail("historical offerings cannot activate without owner approval");
  }
  if (activeHistoricalRecords.some(record => record.ownerApproval?.approved !== true)) {
    fail("an active historical offering record lacks owner approval");
  }
  const historicalCourses = activeHistoricalRecords.map(record => record.courseIdentity);
  if (new Set(historicalCourses).size !== historicalCourses.length) fail("duplicate active historical-offering course identity");
  const activeIds = new Set(rules.map(rule => rule.ruleId));
  for (const rule of rules) {
    const activeSuperseded = rule.supersedes.filter(ruleId => activeIds.has(ruleId));
    if (activeSuperseded.length) fail(`${rule.ruleId} supersedes still-active records: ${activeSuperseded.join(", ")}`);
  }
}

function validateReferences({ rules, provenance, messages, unresolved }) {
  const sourceIds = new Set(provenance.sources.map(source => source.sourceId));
  const messageKeys = new Set(Object.keys(messages.messages));
  const ruleIds = new Set();
  const unresolvedIds = new Set(unresolved.questions.map(question => question.ruleId));

  for (const rule of rules) {
    if (ruleIds.has(rule.ruleId)) fail(`duplicate rule ID ${rule.ruleId}`);
    ruleIds.add(rule.ruleId);
    if (rule.status === "ACTIVE" && (!rule.authority.owner || !rule.authority.boundary)) fail(`${rule.ruleId} has incomplete authority`);
    for (const sourceRef of rule.sourceRefs) {
      if (!sourceIds.has(sourceRef.split("#")[0])) fail(`${rule.ruleId} references unknown source ${sourceRef}`);
    }
    for (const messageKey of Object.values(rule.messageKeys)) {
      if (!messageKeys.has(messageKey)) fail(`${rule.ruleId} references unknown message ${messageKey}`);
    }
  }
  for (const rule of rules) {
    for (const dependency of rule.dependencies) {
      if (!ruleIds.has(dependency) && !unresolvedIds.has(dependency)) fail(`${rule.ruleId} references unknown dependency ${dependency}`);
      if (unresolvedIds.has(dependency)) {
        const effect = JSON.stringify(rule.effect);
        const explicitReview = rule.classification === "REVIEW" || effect.includes("REVIEW") || effect.includes(dependency);
        if (!explicitReview) fail(`${rule.ruleId} silently enforces unresolved dependency ${dependency}`);
      }
    }
  }
}

async function validateSourceEvidence(repositoryRoot, provenance) {
  for (const source of provenance.sources) {
    if (!source.path) continue;
    const bytes = await readFile(repositoryPath(repositoryRoot, source.path));
    const actual = sourceEvidenceSha256(bytes, source.path);
    if (actual !== source.sha256) fail(`source digest mismatch for ${source.sourceId}`);
  }
}

function policyDiff(bundle) {
  return `# Policy diff: ${bundle.bundleVersion}\n\n` +
    `Bundle digest: \`${bundle.contentHash}\`\n\n` +
    `Runtime activation: the active pinned bundle governs production decisions. Compatibility files are generated projections of the same canonical sources.\n\n` +
    `## Governed dispositions\n\n` +
    `- ECO 257 is statistics-only, cannot be an Economics elective, and has no advisor override. Current runtime behavior already agrees.\n` +
    `- ECO 213/214 recurring evidence projects unpublished years only; it is not a universal same-term prohibition.\n` +
    `- The two-Economics-course target is a soft preference bounded by hard total-term capacity.\n` +
    `- MAY is the canonical internal term; "Spring/May" remains the display label.\n` +
    `- Completed advanced history is preserved and missing historical evidence produces review.\n` +
    `- Dated preliminary schedules guide course-to-term estimates within their recorded scope; omissions do not block, and unsupported terms remain labeled projections.\n` +
    `- FULL remains REVIEW_REQUIRED in the bundle; the generated compatibility view preserves the existing runtime representation.\n` +
    `- Strategy fit remains ranking metadata and cannot invalidate an academically complete plan.\n\n` +
    `## Unresolved review records\n\n` +
    bundle.unresolved.map(question => `- ${question.ruleId}: ${question.requiredDisposition}`).join("\n") + "\n";
}

function dependencyImpact(bundle) {
  const rows = Object.entries(bundle.indexes.dependencyGraph)
    .filter(([, dependencies]) => dependencies.length)
    .map(([ruleId, dependencies]) => `| \`${ruleId}\` | ${dependencies.map(value => `\`${value}\``).join(", ")} |`)
    .join("\n");
  return `# Dependency impact: ${bundle.bundleVersion}\n\n` +
    `Bundle digest: \`${bundle.contentHash}\`\n\n` +
    `The canonical policy hub compiles this pinned runtime bundle and its compatibility projections. The bundle digest includes scoped exact and preliminary schedule evidence.\n\n` +
    `## Declared rule dependencies\n\n| Rule | Depends on |\n|---|---|\n${rows || "| None | None |"}\n\n` +
    `## Active consumers\n\n- \`lib/catalog/load.js\` loads the pinned bundle for assignment, generation, validation and moves.\n- \`app/api/majors/map/route.js\` supplies the bundle to production planning and validates submitted edits.\n- \`lib/reports/build-economics.js\` revalidates the selected plan against the active bundle before JSON, HTML and PDF projection.\n- The interface displays these validated decisions; it does not define academic policy.\n- The Independent Oracle reads canonical sources separately and does not import production decisions.\n`;
}

export async function compilePolicy({ repositoryRoot = SCRIPT_ROOT, outputRoot } = {}) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const manifest = await readJson(resolvedRepositoryRoot, MANIFEST_PATH);
  const releaseRoot = path.resolve(outputRoot ?? path.join(resolvedRepositoryRoot, "data/compiled/policy/releases", manifest.policyVersion));
  const activeRoot = outputRoot ? path.dirname(releaseRoot) : path.join(resolvedRepositoryRoot, "data/compiled/policy");
  const normalizedRoot = outputRoot ? path.join(path.dirname(releaseRoot), "normalized/economics") : path.join(resolvedRepositoryRoot, NORMALIZED_COMPATIBILITY_PATH);

  const schemaEntries = await Promise.all(SCHEMA_PATHS.map(async schemaPath => [schemaPath, await readJson(resolvedRepositoryRoot, schemaPath)]));
  const schemas = new Map(schemaEntries);
  const ajv = createValidator(schemaEntries);
  validateDocument(ajv, schemas.get("policy/schema/policy-manifest.v1.schema.json"), manifest, MANIFEST_PATH);

  const inputs = [];
  for (const declaration of manifest.inputs) {
    const document = await readJson(resolvedRepositoryRoot, declaration.path);
    if (declaration.schema) validateDocument(ajv, schemas.get(declaration.schema), document, declaration.path);
    inputs.push({ ...declaration, document });
  }
  const inputById = Object.fromEntries(inputs.map(input => [input.id, input.document]));
  const rules = flattenRecords(inputs).filter(rule => rule.status === "ACTIVE").sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  const provenance = inputById.provenance;
  const messages = inputById["messages-en-US"];
  const unresolved = inputById.unresolved;
  const schedule = inputById["schedule-2026-2027"];
  const preliminarySchedules = inputById["preliminary-schedules"];
  const courses = inputById.courses;
  const requirements = inputById.requirements;
  const offeringPatterns = inputById["offering-patterns"];
  const historicalOfferings = inputById["historical-offerings"];
  const compatibilityProfile = inputById["compatibility-profile"];

  validateReferences({ rules, provenance, messages, unresolved });
  await validateSourceEvidence(resolvedRepositoryRoot, provenance);
  if (new Set(courses.courses.map(course => course.code)).size !== courses.courses.length) fail("duplicate course code");
  if (schedule.releaseStatus !== "ACTIVE") fail(`schedule ${schedule.releaseId} is not active`);
  validateCriticalConflicts({ rules, schedule, unresolved, offeringPatterns, historicalOfferings });

  const compatibilityTargets = buildCompatibilityRepresentations({
    courses,
    requirements,
    rules,
    schedule,
    offeringPatterns,
    provenance,
    profile: compatibilityProfile
  });

  const indexed = indexRules(rules);
  const dependencyGraph = Object.fromEntries(rules.map(rule => [rule.ruleId, [...rule.dependencies].sort()]));
  const messagesByRule = Object.fromEntries(rules.map(rule => [rule.ruleId, rule.messageKeys]));
  const bundleWithoutHash = {
    schemaVersion: "1.0.0",
    bundleVersion: manifest.policyVersion,
    catalogApplicability: manifest.catalogApplicability,
    releaseRefs: { schedule: schedule.releaseId },
    rules,
    requirementProfile: compatibilityProfile.requirements,
    indexes: {
      ...indexed,
      coursesByCode: Object.fromEntries(courses.courses.map(course => [course.code, course])),
      requirementsByRuleId: Object.fromEntries(requirements.records.map(rule => [rule.ruleId, rule.effect])),
      prerequisiteClosure: prerequisiteClosure(rules),
      offeringByTerm: offeringIndex(schedule),
      preliminaryOfferingByTerm: preliminaryOfferingIndex(preliminarySchedules, schedule, provenance),
      offeringPatternsById: Object.fromEntries(offeringPatterns.patterns.map(pattern => [pattern.patternId, pattern])),
      historicalOfferingByCourse: Object.fromEntries(historicalOfferings.records
        .filter(record => record.activationStatus === "ACTIVE_OWNER_APPROVED" && record.ownerApproval?.approved === true)
        .map(record => [record.courseIdentity, record])),
      messagesByRule,
      dependencyGraph
    },
    messages: messages.messages,
    provenance: {
      authorityHierarchy: provenance.authorityHierarchy,
      sources: provenance.sources,
      historicalOfferingContract: {
        activationStatus: historicalOfferings.activationStatus,
        ownerApproval: historicalOfferings.ownerApproval,
        method: historicalOfferings.method,
        conflicts: historicalOfferings.conflicts
      }
    },
    unresolved: unresolved.questions
  };
  const contentHash = `sha256:${canonicalSha256(bundleWithoutHash)}`;
  const bundle = { ...bundleWithoutHash, contentHash };
  const activationStatus = manifest.status === "ACTIVE" ? "ACTIVE" : "PENDING_OWNER_APPROVAL";

  await Promise.all([
    mkdir(path.join(releaseRoot, "compatibility"), { recursive: true }),
    mkdir(normalizedRoot, { recursive: true })
  ]);
  const compatibility = [];
  for (const [outputName, document] of Object.entries(compatibilityTargets)) {
    await Promise.all([
      writeCanonicalIfChanged(path.join(releaseRoot, "compatibility", outputName), document),
      writeCanonicalIfChanged(path.join(normalizedRoot, outputName), document)
    ]);
    compatibility.push({
      output: `compatibility/${outputName}`,
      runtimeOutput: `${NORMALIZED_COMPATIBILITY_PATH}/${outputName}`,
      source: "canonical Knowledge Hub manifest inputs",
      status: "GENERATED",
      canonicalHash: `sha256:${canonicalSha256(document)}`
    });
  }

  const compileReport = {
    schemaVersion: "1.0.0",
    bundleVersion: manifest.policyVersion,
    contentHash,
    manifestStatus: manifest.status,
    activationStatus,
    inputs: manifest.inputs.map(input => input.path),
    counts: {
      activeRules: rules.length,
      courses: courses.courses.length,
      scheduleSections: schedule.terms.flatMap(term => term.sections).length,
      sources: provenance.sources.length,
      unresolvedReviewRecords: unresolved.questions.length,
      historicalOfferingRecords: historicalOfferings.records.length
    },
    validation: {
      schemas: "PASS",
      references: "PASS",
      sourceDigests: "PASS",
      duplicateIds: "PASS",
      overlaps: "PASS",
      contradictions: "PASS",
      missingSupersession: "PASS",
      unresolvedActiveEnforcement: "PASS",
      criticalConflicts: []
    },
    compatibility,
    determinism: { canonicalFormat: "UTF-8 JSON, sorted object keys and ID-addressed arrays", repeatCompilationsRequired: 3 },
    performanceBudgetMs: 5000
  };
  const active = {
    schemaVersion: "1.0.0",
    programs: {
      [manifest.program]: Object.fromEntries(manifest.catalogApplicability.map(catalogYear => [catalogYear, {
        bundleVersion: manifest.policyVersion,
        contentHash,
        compatibilityHashes: Object.fromEntries(compatibility.map(entry => [entry.output, entry.canonicalHash])),
        releasePath: `releases/${manifest.policyVersion}/bundle.json`,
        activationStatus
      }]))
    }
  };

  await Promise.all([
    writeCanonicalIfChanged(path.join(releaseRoot, "bundle.json"), bundle),
    writeTextIfChanged(path.join(releaseRoot, "bundle.sha256"), `${contentHash.slice("sha256:".length)}\n`, current => current.trim() === contentHash.slice("sha256:".length)),
    writeCanonicalIfChanged(path.join(releaseRoot, "compile-report.json"), compileReport),
    writeTextIfChanged(path.join(releaseRoot, "policy-diff.md"), policyDiff(bundle)),
    writeTextIfChanged(path.join(releaseRoot, "dependency-impact.md"), dependencyImpact(bundle))
  ]);
  await mkdir(activeRoot, { recursive: true });
  await writeCanonicalIfChanged(path.join(activeRoot, "active.json"), active);

  return { bundle, compileReport, releaseRoot, normalizedRoot, activePath: path.join(activeRoot, "active.json") };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") options.outputRoot = path.resolve(argv[++index]);
    else fail(`unknown argument ${argv[index]}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await compilePolicy(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${result.bundle.bundleVersion} ${result.bundle.contentHash}\n`);
}
