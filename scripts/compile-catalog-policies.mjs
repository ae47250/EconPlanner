import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, canonicalSha256 } from "../lib/policy/canonical-json.js";
import { sourceEvidenceSha256 } from "../lib/source-evidence-hash.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFESTS = [
  "policy/manifest/econ-catalog-2023-2024.1.json",
  "policy/manifest/econ-catalog-2024-2025.1.json",
  "policy/manifest/econ-catalog-2025-2026.2.json"
];
const EXPECTED_YEARS = ["2023-2024", "2024-2025", "2025-2026"];
const FLEXIBILITY_RULE_ID = "CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK";
const PLANNING_FLEXIBILITY_POLICY_PATH = "policy/rules/planning-flexibility.json";
const PLANNING_FLEXIBILITY_PROVENANCE_PATH = "policy/provenance/planning-flexibility.4.json";
const ACTIVE_BUNDLE_VERSION = "econ-2025-2026.1";
const ACTIVE_BUNDLE_HASH = "sha256:76659e80ea6c3f43148dbc485818081db36a25a1a857a9b020c1a75f505ca4e7";

function fail(message) {
  throw new Error(`Catalog policy compilation failed: ${message}`);
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

function sourceIdFromRef(sourceRef) {
  return String(sourceRef).split("#")[0];
}

function anchorFromRef(sourceRef) {
  return String(sourceRef).includes("#") ? String(sourceRef).slice(String(sourceRef).indexOf("#") + 1) : null;
}

function validateCatalog(catalog, manifest) {
  if (catalog.catalogYear !== manifest.catalogYear) fail(`${manifest.policyVersion} catalog year mismatch`);
  if (catalog.policyVersion !== manifest.policyVersion) fail(`${manifest.policyVersion} policy version mismatch`);
  if (catalog.publicationStatus !== "AUTHORITATIVE_PUBLISHED") fail(`${manifest.policyVersion} is not authoritative published evidence`);
  if (catalog.activationStatus !== "PENDING_OWNER_APPROVAL" || manifest.status !== "PENDING_OWNER_APPROVAL") {
    fail(`${manifest.policyVersion} must remain pending owner approval`);
  }
  for (const field of ["core", "statisticsOptions", "moneyFinanceOptions", "capstone", "cognateOptions"]) {
    if (!Array.isArray(catalog.requirements?.[field]) || !catalog.requirements[field].length) fail(`${manifest.policyVersion} is missing ${field}`);
  }
  if (catalog.requirements.economicsElectives?.count !== 4) fail(`${manifest.policyVersion} must govern four Economics electives`);
  if (!catalog.prerequisites?.["ECO 461"]) fail(`${manifest.policyVersion} is missing the capstone prerequisite record`);
  if (!catalog.nonCourseMilestones?.some(item => item.id === "ECONOMICS-COMPREHENSIVE-EVALUATION")) {
    fail(`${manifest.policyVersion} is missing the comprehensive-evaluation disposition`);
  }
  if (catalog.collegeWideBoundary?.changedByFlexibleMajorRule !== false) fail(`${manifest.policyVersion} changes College-wide policy`);
}

function validateHistoricalDifferences(catalogsByYear) {
  const year2023 = catalogsByYear["2023-2024"];
  const year2024 = catalogsByYear["2024-2025"];
  const year2025 = catalogsByYear["2025-2026"];
  if (year2023.requirements.statisticsOptions.includes("PSY 217")) fail("2023-2024 may not include PSY 217");
  if (!year2024.requirements.statisticsOptions.includes("PSY 217") || !year2025.requirements.statisticsOptions.includes("PSY 217")) fail("PSY 217 history is incomplete");
  if (year2023.requirements.moneyFinanceOptions.includes("BUSN 323") || year2024.requirements.moneyFinanceOptions.includes("BUSN 323")) fail("BUSN 323 may not precede 2025-2026");
  if (!year2025.requirements.moneyFinanceOptions.includes("BUSN 323")) fail("2025-2026 must include BUSN 323");
  if (year2023.nonCourseMilestones[0].status !== "REQUIRED") fail("2023-2024 comprehensive evaluation must be required");
  if ([year2024, year2025].some(catalog => catalog.nonCourseMilestones[0].status !== "NOT_LISTED")) fail("newer catalog milestone history is incorrect");
  for (const catalog of Object.values(catalogsByYear)) {
    if (!catalog.allocation?.["ECO 257"]?.includes("statistics") || catalog.allocation["ECO 257"].some(value => value.includes("elective"))) {
      fail(`${catalog.catalogYear} violates ECO 257 statistics-only policy`);
    }
  }
}

async function validateSources(repositoryRoot, provenance, documents) {
  const sourceById = Object.fromEntries(provenance.sources.map(source => [source.sourceId, source]));
  for (const source of provenance.sources) {
    const bytes = await readFile(repositoryPath(repositoryRoot, source.path));
    const actual = `sha256:${sourceEvidenceSha256(bytes, source.path)}`;
    if (actual !== source.sha256) fail(`source digest mismatch for ${source.sourceId}`);
    const text = bytes.toString("utf8");
    for (const anchor of source.anchors || []) if (!text.includes(anchor)) fail(`source anchor ${anchor} is missing from ${source.sourceId}`);
  }
  for (const document of documents) {
    for (const sourceRef of document.sourceRefs || []) {
      const source = sourceById[sourceIdFromRef(sourceRef)];
      if (!source) fail(`${document.ruleId || document.recordId} references unknown source ${sourceRef}`);
      const anchor = anchorFromRef(sourceRef);
      if (anchor && !source.anchors.includes(anchor)) fail(`${document.ruleId || document.recordId} references ungoverned anchor ${sourceRef}`);
    }
  }
}

function differences(previous, current) {
  if (!previous) return [{ code: "INITIAL_HISTORICAL_RELEASE", favorable: false, detail: "First governed historical Economics catalog release." }];
  const findings = [];
  const compare = (field, label) => {
    const before = new Set(previous.requirements[field]);
    const after = new Set(current.requirements[field]);
    for (const value of after) if (!before.has(value)) findings.push({ code: `ADDED_${field.toUpperCase()}_OPTION`, favorable: true, detail: `${label} adds ${value}.` });
    for (const value of before) if (!after.has(value)) findings.push({ code: `REMOVED_${field.toUpperCase()}_OPTION`, favorable: false, detail: `${label} removes ${value}.` });
  };
  compare("statisticsOptions", "Statistics");
  compare("moneyFinanceOptions", "Money/Finance");
  const oldMilestone = previous.nonCourseMilestones[0].status;
  const newMilestone = current.nonCourseMilestones[0].status;
  if (oldMilestone !== newMilestone) findings.push({
    code: "ECONOMICS_COMPREHENSIVE_EVALUATION_CHANGED",
    favorable: oldMilestone === "REQUIRED" && newMilestone === "NOT_LISTED",
    detail: `Economics comprehensive evaluation changes from ${oldMilestone} to ${newMilestone}.`
  });
  return findings;
}

function policyDiff(bundle) {
  const rows = bundle.materialDifferences.map(item => `| ${item.code} | ${item.favorable ? "more flexible" : "review"} | ${item.detail} |`).join("\n");
  return `# Policy diff: ${bundle.bundleVersion}\n\n` +
    `Bundle digest: \`${bundle.contentHash}\`\n\n` +
    `Activation: **pending owner approval**. The current active runtime bundle remains \`${ACTIVE_BUNDLE_VERSION}\`.\n\n` +
    `| Difference | Direction | Detail |\n|---|---|---|\n${rows}\n\n` +
    `College-wide graduation, residency, general-education, grade, and institution-wide requirements are outside this release's flexibility boundary.\n`;
}

function dependencyImpact(bundle) {
  return `# Dependency impact: ${bundle.bundleVersion}\n\n` +
    `Bundle digest: \`${bundle.contentHash}\`\n\n` +
    `- Catalog applicability may evaluate this release as authoritative published evidence.\n` +
    `- Conditional use is controlled by \`${FLEXIBILITY_RULE_ID}\`.\n` +
    `- The active Decision Engine bundle and \`data/compiled/policy/active.json\` are not changed.\n` +
    `- Planning, API, advisor-notice, readiness, and nightly-ledger consumers depend on the catalog applicability contract.\n` +
    `- Profile impact must be reviewed in the CP4b-B catalog/readiness ledger before activation.\n` +
    `- Rollback is the removal of the CP4b-B checkpoint commit; the previous immutable bundle remains available.\n`;
}

async function writeImmutable(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const existing = await readFile(filePath, "utf8");
    const normalizeLineEndings = value => value.replaceAll("\r\n", "\n");
    if (normalizeLineEndings(existing) !== normalizeLineEndings(contents)) fail(`immutable output differs at ${filePath}`);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(filePath, contents, "utf8");
}

function historicalSourceReport(provenance, releases) {
  const rows = provenance.sources.map(source => `| ${source.sourceId} | ${source.authority} | ${source.sha256} | ${source.anchors.join("; ")} | ${source.url || "owner confirmation"} |`).join("\n");
  return `# Historical Economics catalog sources and provenance\n\n` +
    `All governed source hashes and anchors passed compilation. No 2026-2027 catalog was created.\n\n` +
    `| Source | Authority | SHA-256 | Anchors | Locator |\n|---|---|---|---|---|\n${rows}\n\n` +
    `## Compiled releases\n\n${releases.map(release => `- ${release.catalogYear}: \`${release.bundleVersion}\` (\`${release.contentHash}\`), pending owner approval.`).join("\n")}\n`;
}

function validatePlanningFlexibilityPolicy(policy) {
  if (policy?.policyVersion !== "econ-planning-flexibility.4" || policy?.status !== "OWNER_APPROVED") {
    fail("owner-approved planning flexibility policy is missing");
  }
  const senior = policy.acceleratedSeniorStanding;
  if (senior?.requiresStudentConfirmation !== false || senior?.readinessImpact !== "NONE") {
    fail("accelerated senior-standing policy must be nonblocking and require no confirmation");
  }
  const projection = policy.futureScheduleProjection;
  if (projection?.publishedScheduleAuthority !== "AUTHORITATIVE"
    || projection?.unpublishedScheduleEffect !== "ALLOW_ACADEMICALLY_VALID_PLANNING_PROJECTION"
    || projection?.readinessImpact !== "NONE") {
    fail("future schedule projection policy is incomplete");
  }
  if (projection.futureOfferingLikelihoodExtension?.currentLikelihoodDataAvailable !== false
    || projection.futureOfferingLikelihoodExtension?.probabilitiesMayBeInferredWithoutData !== false) {
    fail("future offering likelihoods may not be invented without owner-supplied data");
  }
  const degreeInformation = policy.generalDegreeDesignationInformation;
  if (degreeInformation?.status !== "INFORMATIONAL_ONLY"
    || degreeInformation?.separateFromEconomicsMajorCatalogSelection !== true
    || degreeInformation?.latestCatalogInferencePermitted !== false
    || degreeInformation?.readinessImpact !== "NONE"
    || degreeInformation?.feasibilityImpact !== "NONE"
    || !degreeInformation?.designations?.HS?.differentDisciplinesRequired
    || !degreeInformation?.designations?.W2?.courses?.includes("ECO 461")) {
    fail("general-degree CCR/ACE information boundary is incomplete");
  }
  const equivalencyContract = policy.mathematicsEquivalencyEvidenceContract;
  if (equivalencyContract?.activationStatus !== "CONTRACT_ACTIVE_NO_APPROVED_EQUIVALENCIES"
    || equivalencyContract?.crossScopeInferencePermitted !== false
    || equivalencyContract?.unapprovedDisposition !== "REVIEW_REQUIRED_NO_CREDIT"
    || equivalencyContract?.approvedEquivalencies?.length !== 0
    || !["ECONOMICS_COGNATE", "COURSE_PREREQUISITE", "BOTH"].every(scope => equivalencyContract.approvedScopes?.includes(scope))) {
    fail("mathematics-equivalency scope contract is incomplete");
  }
  const designation = policy.mostFlexibleEconomicsMajorRequirementSet;
  if (designation?.catalogYear !== "2025-2026"
    || designation?.selectionMethod !== "OWNER_DESIGNATION"
    || designation?.automaticNewestSelectionPermitted !== false
    || designation?.declarationCatalogMayOverride !== false) {
    fail("owner-designated Economics requirement set is incomplete");
  }
  const strategyContract = policy.economicsPlanningStrategies;
  const strategies = Object.fromEntries((strategyContract?.strategies || []).map(strategy => [strategy.id, strategy]));
  if (strategyContract?.classification !== "NONACADEMIC_PLANNING_AND_RANKING_PREFERENCES"
    || strategyContract?.feasibilityImpact !== "NONE"
    || strategyContract?.stableSavedStateIds !== true
    || !["balanced", "explore-first", "one-year-early"].every(id => strategies[id])) {
    fail("owner-approved Economics strategy contract is incomplete");
  }
  if (strategies["explore-first"].publicLabel !== "Explore the Major"
    || !strategies["explore-first"].eligibility?.effectiveStandings?.includes("freshman")
    || !strategies["explore-first"].eligibility?.effectiveStandings?.includes("sophomore")
    || strategies["explore-first"].eligibility?.effectiveStandings?.some(standing => ["junior", "senior"].includes(standing))
    || strategies["explore-first"].rankingPreferences?.firstYearTargetFormula !== "MIN_BALANCED_MINUS_ONE_AND_FLOOR_TOTAL_OVER_YEARS"
    || strategies["explore-first"].rankingPreferences?.exactTargetIsFeasibilityRule !== false) {
    fail("Explore the Major strategy contract is incomplete or academicized");
  }
  if (JSON.stringify(strategies["one-year-early"].eligibility?.effectiveStandings)
      !== JSON.stringify(["freshman", "sophomore"])) {
    fail("One Year Early must remain limited to effective freshman and sophomore contexts");
  }
  if (policy.boundaries?.catalog2026_2027CreatedOrActivated !== false) {
    fail("the planning flexibility policy may not create or activate a 2026-2027 catalog");
  }
}

function planningFlexibilityContract(bundle) {
  const policy = bundle.policy;
  return `# Owner-approved planning-flexibility contract\n\n` +
    `Compiled policy: \`${bundle.bundleVersion}\` (\`${bundle.contentHash}\`).\n\n` +
    `- Accelerated one-year-early plans assume senior standing in the final planning year; no student confirmation is requested and readiness is unchanged by the assumption alone.\n` +
    `- Published schedules remain authoritative. Later unpublished schedules use academically checked placements with \`PLANNING_PROJECTION\` provenance and one informational notice.\n` +
    `- Economics planning uses the owner-designated ${policy.mostFlexibleEconomicsMajorRequirementSet.catalogYear} requirement set. Incoming catalog years remain comparison and degree-audit metadata.\n` +
    `- Material incoming-catalog differences create a nonblocking SAC petition notification, not a substantive advisor action.\n` +
    `- A future owner-supplied Excel history may support informational offering likelihoods only when data coverage and method are disclosed. No likelihood data or probability is present in this release.\n` +
    `- CCR/ACE information uses the student's supported general-degree catalog separately from the Economics major requirement set and has no readiness or feasibility effect.\n` +
    `- Mathematics equivalencies require an explicit cognate, prerequisite, or both scope with complete approval evidence; no equivalencies are activated in this release.\n` +
    `- Balanced, Explore the Major, and One Year Early use the strategy IDs, public labels, eligibility boundaries, definitions, and nonacademic ranking preferences in the compiled strategy contract.\n` +
    `- Explore the Major remains limited to effective freshman and sophomore contexts, must be lighter than and materially distinct from its selected same-context Balanced baseline, and uses a soft nondecreasing backloaded target.\n` +
    `- One Year Early remains limited to effective freshman and sophomore contexts; ineligible saved or submitted requests normalize to the standard graduation timeline without changing academic feasibility.\n` +
    `- No 2026-2027 catalog is compiled or activated, and the active Decision Engine mapping is unchanged.\n`;
}

async function compilePlanningFlexibilityPolicy(root, compiledRoot) {
  const policy = await readJson(root, PLANNING_FLEXIBILITY_POLICY_PATH);
  const provenance = await readJson(root, PLANNING_FLEXIBILITY_PROVENANCE_PATH);
  validatePlanningFlexibilityPolicy(policy);
  if (provenance.policyVersion !== policy.policyVersion
    || !provenance.sources?.some(source => source.sourceId === "OWNER-CONFIRMATION-CP5-2026-08-09"
      && source.authorityBoundary === "ECONOMICS_PLANNING_STRATEGY_RANKING_ONLY")
    || !provenance.sources?.some(source => source.sourceId === "OWNER-CONFIRMATION-CP7-2026-08-09"
      && source.authorityBoundary === "ECONOMICS_NONACADEMIC_PLANNING_STRATEGY_ELIGIBILITY_ONLY")) {
    fail("planning-flexibility owner-confirmation provenance is incomplete");
  }
  const payload = {
    schemaVersion: "1.0.0",
    bundleVersion: policy.policyVersion,
    activationStatus: "OWNER_APPROVED",
    activeRuntimeMappingChanged: false,
    policy,
    provenance: {
      sourcePath: PLANNING_FLEXIBILITY_POLICY_PATH,
      provenancePath: PLANNING_FLEXIBILITY_PROVENANCE_PATH,
      sourceRefs: policy.sourceRefs,
      sources: provenance.sources
    }
  };
  const contentHash = `sha256:${canonicalSha256(payload)}`;
  const bundle = {...payload, contentHash};
  const outputRoot = path.join(compiledRoot, "planning-flexibility", policy.policyVersion);
  const compileReport = {
    schemaVersion: "1.0.0",
    bundleVersion: policy.policyVersion,
    contentHash,
    activationStatus: "OWNER_APPROVED",
    activeRuntimeMappingChanged: false,
    inputs: [PLANNING_FLEXIBILITY_POLICY_PATH, PLANNING_FLEXIBILITY_PROVENANCE_PATH],
    validation: {
      acceleratedSeniorStandingNonblocking: "PASS",
      futureScheduleProjectionNonblocking: "PASS",
      publishedScheduleAuthorityPreserved: "PASS",
      ownerDesignationFixedTo2025_2026: "PASS",
      automaticNewestSelectionDisabled: "PASS",
      futureLikelihoodsNotInvented: "PASS",
      generalDegreeDesignationInformationNonblocking: "PASS",
      generalDegreeCatalogKeptSeparate: "PASS",
      mathematicsEquivalencyCrossScopeInferenceDisabled: "PASS",
      approvedMathematicsEquivalencies: 0,
      economicsStrategyContractOwnerApproved: "PASS",
      strategyPreferencesNonacademicAndNonblocking: "PASS",
      oneYearEarlyEligibilityFreshmanSophomoreOnly: "PASS",
      catalog2026_2027Invented: false,
      collegeWidePolicyChanged: false
    },
    determinism: {canonicalFormat: "UTF-8 JSON with canonical key and ID-array ordering", requiredCleanCompilations: 3}
  };
  await Promise.all([
    writeImmutable(path.join(outputRoot, "bundle.json"), canonicalJson(bundle)),
    writeImmutable(path.join(outputRoot, "bundle.sha256"), `${contentHash.slice(7)}\n`),
    writeImmutable(path.join(outputRoot, "compile-report.json"), canonicalJson(compileReport)),
    writeImmutable(path.join(outputRoot, "architecture-contract.md"), planningFlexibilityContract(bundle))
  ]);
  return bundle;
}

export async function compileCatalogPolicies({ repositoryRoot = REPOSITORY_ROOT, outputRoot } = {}) {
  const root = path.resolve(repositoryRoot);
  const compiledRoot = path.resolve(outputRoot || path.join(root, "data/compiled/policy"));
  const manifests = await Promise.all(MANIFESTS.map(manifestPath => readJson(root, manifestPath)));
  const provenance = await readJson(root, manifests[0].inputs.provenance);
  const ruleDocument = await readJson(root, manifests[0].inputs.flexibilityRule);
  const flexibilityRule = ruleDocument.records.find(rule => rule.ruleId === FLEXIBILITY_RULE_ID);
  if (!flexibilityRule || flexibilityRule.status !== "OWNER_APPROVED") fail("owner-approved flexibility rule is missing");
  if (flexibilityRule.authority.excluded.length !== 5) fail("flexibility rule authority boundary is incomplete");

  const catalogs = await Promise.all(manifests.map(manifest => readJson(root, manifest.inputs.catalog)));
  for (let index = 0; index < catalogs.length; index += 1) validateCatalog(catalogs[index], manifests[index]);
  const catalogsByYear = Object.fromEntries(catalogs.map(catalog => [catalog.catalogYear, catalog]));
  if (JSON.stringify(Object.keys(catalogsByYear).sort()) !== JSON.stringify(EXPECTED_YEARS)) fail("catalog release inventory is incomplete");
  validateHistoricalDifferences(catalogsByYear);
  await validateSources(root, provenance, [...catalogs, flexibilityRule]);

  const releases = [];
  let previous = null;
  for (let index = 0; index < manifests.length; index += 1) {
    const manifest = manifests[index];
    const catalog = catalogs[index];
    const materialDifferences = differences(previous, catalog);
    const payload = {
      schemaVersion: "1.0.0",
      bundleVersion: manifest.policyVersion,
      catalogYear: manifest.catalogYear,
      program: manifest.program,
      activationStatus: "PENDING_OWNER_APPROVAL",
      authoritativePublicationStatus: catalog.publicationStatus,
      catalog,
      flexibilityRule,
      materialDifferences,
      provenance: {
        authorityHierarchy: provenance.authorityHierarchy,
        sources: provenance.sources.filter(source => new Set([...catalog.sourceRefs, ...flexibilityRule.sourceRefs].map(sourceIdFromRef)).has(source.sourceId))
      },
      rollback: {activeBundleVersion: ACTIVE_BUNDLE_VERSION, activeBundleHash: ACTIVE_BUNDLE_HASH}
    };
    const contentHash = `sha256:${canonicalSha256(payload)}`;
    const bundle = {...payload, contentHash};
    const releaseRoot = path.join(compiledRoot, "releases", manifest.policyVersion);
    const compileReport = {
      schemaVersion: "1.0.0",
      bundleVersion: manifest.policyVersion,
      contentHash,
      activationStatus: "PENDING_OWNER_APPROVAL",
      activeRuntimeMappingChanged: false,
      inputs: Object.values(manifest.inputs),
      validation: {
        manifest: "PASS",
        requiredRuleFamilies: "PASS",
        historicalDifferences: "PASS",
        sourceDigests: "PASS",
        sourceAnchors: "PASS",
        sourceReferences: "PASS",
        collegeWideBoundary: "PASS",
        eco257StatisticsOnly: "PASS",
        unavailableCatalogInvented: false
      },
      determinism: {canonicalFormat: "UTF-8 JSON with canonical key and ID-array ordering", requiredCleanCompilations: 3},
      previousActiveBundle: {bundleVersion: ACTIVE_BUNDLE_VERSION, contentHash: ACTIVE_BUNDLE_HASH}
    };
    await Promise.all([
      writeImmutable(path.join(releaseRoot, "bundle.json"), canonicalJson(bundle)),
      writeImmutable(path.join(releaseRoot, "bundle.sha256"), `${contentHash.slice(7)}\n`),
      writeImmutable(path.join(releaseRoot, "compile-report.json"), canonicalJson(compileReport)),
      writeImmutable(path.join(releaseRoot, "policy-diff.md"), policyDiff(bundle)),
      writeImmutable(path.join(releaseRoot, "dependency-impact.md"), dependencyImpact(bundle))
    ]);
    releases.push({
      catalogYear: manifest.catalogYear,
      bundleVersion: manifest.policyVersion,
      contentHash,
      releasePath: `releases/${manifest.policyVersion}/bundle.json`,
      publicationStatus: catalog.publicationStatus,
      activationStatus: "PENDING_OWNER_APPROVAL"
    });
    previous = catalog;
  }

  const registry = {
    schemaVersion: "1.0.0",
    program: "ECONOMICS",
    activeRuntimeMappingChanged: false,
    activeRuntimeBundle: {bundleVersion: ACTIVE_BUNDLE_VERSION, contentHash: ACTIVE_BUNDLE_HASH, mappingPath: "active.json"},
    latestAuthoritativePublishedCatalogYear: "2025-2026",
    unavailableCatalogYears: ["2026-2027"],
    releases
  };
  await Promise.all([
    writeImmutable(path.join(compiledRoot, "catalog-releases.json"), canonicalJson(registry)),
    writeImmutable(path.join(compiledRoot, "historical-catalog-source-report.md"), historicalSourceReport(provenance, releases))
  ]);
  const planningFlexibility = await compilePlanningFlexibilityPolicy(root, compiledRoot);
  return {registry, planningFlexibility, compiledRoot};
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
  const result = await compileCatalogPolicies(parseArguments(process.argv.slice(2)));
  process.stdout.write(result.registry.releases.map(release => `${release.bundleVersion} ${release.contentHash}`).join("\n") + "\n");
}
