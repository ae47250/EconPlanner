import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, canonicalSha256 } from "../lib/policy/canonical-json.js";
import { sourceEvidenceSha256 } from "../lib/source-evidence-hash.js";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "policy/manifest/econ-2025-2026.1.json";
const SCHEMA_PATHS = [
  "policy/schema/policy-record.v1.schema.json",
  "policy/schema/policy-manifest.v1.schema.json",
  "policy/schema/schedule-release.v1.schema.json",
  "policy/schema/offering-pattern.v1.schema.json",
  "policy/schema/approval-instance.v1.schema.json",
  "policy/schema/message-catalog.v1.schema.json"
];
const COMPATIBILITY_TARGETS = {
  "courses.json": "data/normalized/economics/courses.json",
  "requirements.json": "data/normalized/economics/requirements.json",
  "prerequisites.json": "data/normalized/economics/prerequisites.json",
  "planning-constraints.json": "data/normalized/economics/planning-constraints.json",
  "schedule-2026-2027.json": "data/normalized/economics/schedule-2026-2027.json"
};

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

function sameMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validateCompatibilityTargets({ courses, requirements, rules, schedule, targets }) {
  const legacyCourses = new Map(targets["courses.json"].courses.map(course => [course.code, course]));
  for (const course of courses.courses) {
    const legacy = legacyCourses.get(course.code);
    if (!legacy || legacy.title !== course.title || legacy.units !== course.units) fail(`course compatibility drift for ${course.code}`);
  }

  const legacyPrerequisites = targets["prerequisites.json"];
  for (const rule of rules.filter(candidate => candidate.ruleType === "coursePrerequisite")) {
    const legacy = legacyPrerequisites[rule.condition.course];
    if (!legacy || !sameMembers(rule.effect.allOf ?? [], legacy.all ?? [])) fail(`prerequisite allOf drift for ${rule.condition.course}`);
    const canonicalGroups = (rule.effect.oneOfGroups ?? []).map(group => [...group].sort().join("|")).sort();
    const legacyGroups = (legacy.any ?? []).map(group => [...group].sort().join("|")).sort();
    if (!sameMembers(canonicalGroups, legacyGroups)) fail(`prerequisite oneOf drift for ${rule.condition.course}`);
  }

  const slotByRule = {
    "REQ-ECO-113": "eco-113", "REQ-ECO-114": "eco-114", "REQ-ECO-213": "eco-213", "REQ-ECO-214": "eco-214",
    "REQ-STATISTICS": "statistics", "REQ-FINANCE": "finance", "REQ-ECO-461": "eco-461", "REQ-COGNATE": "cognate"
  };
  const legacySlots = new Map(targets["requirements.json"].requirementSlots.map(slot => [slot.id, slot]));
  for (const [ruleId, slotId] of Object.entries(slotByRule)) {
    const rule = requirements.records.find(candidate => candidate.ruleId === ruleId);
    if (!rule || !sameMembers(rule.effect.options, legacySlots.get(slotId)?.options ?? [])) fail(`requirement compatibility drift for ${ruleId}`);
  }
  const electiveRule = requirements.records.find(rule => rule.ruleId === "REQ-ECO-ELECTIVES");
  const legacyElectiveCount = targets["requirements.json"].requirementSlots.filter(slot => slot.kind === "elective").length;
  if (electiveRule.effect.slotCount !== legacyElectiveCount) fail("elective slot-count compatibility drift");

  const termLabels = { FALL: "Fall", WINTER: "Winter", MAY: "May", SUMMER: "Summer" };
  for (const term of schedule.terms) {
    const legacySections = targets["schedule-2026-2027.json"].terms[termLabels[term.canonicalTerm]] ?? [];
    const canonicalInventory = term.sections.map(section => `${section.course}|${section.title}|${section.units}`);
    const legacyInventory = legacySections.map(section => `${section.course}|${section.title}|${section.units}`);
    if (!sameMembers(canonicalInventory, legacyInventory)) fail(`schedule compatibility drift for ${term.termId}`);
  }
  const fullSections = schedule.terms.flatMap(term => term.sections).filter(section => section.enrollmentState === "FULL").length;
  const legacyFullSections = Object.values(targets["schedule-2026-2027.json"].terms).flat().filter(section => section.availability?.rawStatus === "Full").length;
  if (fullSections !== legacyFullSections) fail("FULL enrollment-state compatibility drift");

  const capacityByTerm = Object.fromEntries(rules.filter(rule => rule.ruleType === "termLoad" && rule.condition.canonicalTerm).map(rule => [rule.condition.canonicalTerm, rule.effect]));
  const legacyTerms = targets["planning-constraints.json"].terms;
  for (const [canonicalTerm, label] of Object.entries(termLabels)) {
    const canonicalCapacity = capacityByTerm[canonicalTerm];
    if (canonicalCapacity && canonicalCapacity.maxTotalCourses !== legacyTerms[label]?.maxTotalCourses) fail(`term-capacity compatibility drift for ${canonicalTerm}`);
  }
}

function validateCriticalConflicts({ rules, schedule, unresolved, offeringPatterns }) {
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
    `Runtime activation: **not changed by CP2**. Compatibility files preserve the current runtime shapes.\n\n` +
    `## Governed dispositions\n\n` +
    `- ECO 257 is statistics-only, cannot be an Economics elective, and has no advisor override. Current runtime behavior already agrees.\n` +
    `- ECO 213/214 recurring evidence projects unpublished years only; it is not a universal same-term prohibition.\n` +
    `- The two-Economics-course target is a soft preference bounded by hard total-term capacity.\n` +
    `- MAY is the canonical internal term; "Spring/May" remains the display label.\n` +
    `- Completed advanced history is preserved and missing historical evidence produces review.\n` +
    `- Unsupported future exact terms remain preliminary/TBC.\n` +
    `- FULL remains REVIEW_REQUIRED in the bundle; the legacy compatibility view retains its pre-CP2 representation until runtime migration.\n` +
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
    `CP2 adds compiled data only. Current catalog loading, planning, validation, editing, reports, and PDFs continue to use their existing runtime paths.\n\n` +
    `## Declared rule dependencies\n\n| Rule | Depends on |\n|---|---|\n${rows || "| None | None |"}\n\n` +
    `## Future consumers\n\n- CP3 may load this exact bundle in shadow mode.\n- CP4 may replace normalized runtime reads only after differential approval.\n- UI, plan edits, reports, and PDFs are unchanged in CP2.\n`;
}

export async function compilePolicy({ repositoryRoot = SCRIPT_ROOT, outputRoot } = {}) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const manifest = await readJson(resolvedRepositoryRoot, MANIFEST_PATH);
  const releaseRoot = path.resolve(outputRoot ?? path.join(resolvedRepositoryRoot, "data/compiled/policy/releases", manifest.policyVersion));
  const activeRoot = outputRoot ? path.dirname(releaseRoot) : path.join(resolvedRepositoryRoot, "data/compiled/policy");

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
  const courses = inputById.courses;
  const requirements = inputById.requirements;
  const offeringPatterns = inputById["offering-patterns"];

  validateReferences({ rules, provenance, messages, unresolved });
  await validateSourceEvidence(resolvedRepositoryRoot, provenance);
  if (new Set(courses.courses.map(course => course.code)).size !== courses.courses.length) fail("duplicate course code");
  if (schedule.releaseStatus !== "ACTIVE") fail(`schedule ${schedule.releaseId} is not active`);
  validateCriticalConflicts({ rules, schedule, unresolved, offeringPatterns });

  const compatibilityTargets = {};
  for (const [outputName, sourcePath] of Object.entries(COMPATIBILITY_TARGETS)) compatibilityTargets[outputName] = await readJson(resolvedRepositoryRoot, sourcePath);
  validateCompatibilityTargets({ courses, requirements, rules, schedule, targets: compatibilityTargets });

  const indexed = indexRules(rules);
  const dependencyGraph = Object.fromEntries(rules.map(rule => [rule.ruleId, [...rule.dependencies].sort()]));
  const messagesByRule = Object.fromEntries(rules.map(rule => [rule.ruleId, rule.messageKeys]));
  const bundleWithoutHash = {
    schemaVersion: "1.0.0",
    bundleVersion: manifest.policyVersion,
    catalogApplicability: manifest.catalogApplicability,
    releaseRefs: { schedule: schedule.releaseId },
    rules,
    indexes: {
      ...indexed,
      coursesByCode: Object.fromEntries(courses.courses.map(course => [course.code, course])),
      requirementsByRuleId: Object.fromEntries(requirements.records.map(rule => [rule.ruleId, rule.effect])),
      prerequisiteClosure: prerequisiteClosure(rules),
      offeringByTerm: offeringIndex(schedule),
      offeringPatternsById: Object.fromEntries(offeringPatterns.patterns.map(pattern => [pattern.patternId, pattern])),
      messagesByRule,
      dependencyGraph
    },
    messages: messages.messages,
    provenance: {
      authorityHierarchy: provenance.authorityHierarchy,
      sources: provenance.sources
    },
    unresolved: unresolved.questions
  };
  const contentHash = `sha256:${canonicalSha256(bundleWithoutHash)}`;
  const bundle = { ...bundleWithoutHash, contentHash };

  await mkdir(path.join(releaseRoot, "compatibility"), { recursive: true });
  const compatibility = [];
  for (const [outputName, sourcePath] of Object.entries(COMPATIBILITY_TARGETS)) {
    const document = compatibilityTargets[outputName];
    await writeFile(path.join(releaseRoot, "compatibility", outputName), canonicalJson(document));
    compatibility.push({ output: `compatibility/${outputName}`, source: sourcePath, status: "MATCH", canonicalHash: `sha256:${canonicalSha256(document)}` });
  }

  const compileReport = {
    schemaVersion: "1.0.0",
    bundleVersion: manifest.policyVersion,
    contentHash,
    manifestStatus: manifest.status,
    activationStatus: "PENDING_OWNER_APPROVAL",
    inputs: manifest.inputs.map(input => input.path),
    counts: {
      activeRules: rules.length,
      courses: courses.courses.length,
      scheduleSections: schedule.terms.flatMap(term => term.sections).length,
      sources: provenance.sources.length,
      unresolvedReviewRecords: unresolved.questions.length
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
        releasePath: `releases/${manifest.policyVersion}/bundle.json`,
        activationStatus: "PENDING_OWNER_APPROVAL"
      }]))
    }
  };

  await Promise.all([
    writeFile(path.join(releaseRoot, "bundle.json"), canonicalJson(bundle)),
    writeFile(path.join(releaseRoot, "bundle.sha256"), `${contentHash.slice("sha256:".length)}\n`),
    writeFile(path.join(releaseRoot, "compile-report.json"), canonicalJson(compileReport)),
    writeFile(path.join(releaseRoot, "policy-diff.md"), policyDiff(bundle)),
    writeFile(path.join(releaseRoot, "dependency-impact.md"), dependencyImpact(bundle))
  ]);
  await mkdir(activeRoot, { recursive: true });
  await writeFile(path.join(activeRoot, "active.json"), canonicalJson(active));

  return { bundle, compileReport, releaseRoot, activePath: path.join(activeRoot, "active.json") };
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
