import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const sourceRoot = process.env.ECON_SOURCE_DIR || "C:/Users/eiriksson/Downloads";
const rawDir = path.join(root, "data/raw/economics");
const normalizedDir = path.join(root, "data/normalized/economics");
const versionedNormalizedDir = path.join(root, "data/normalized/catalogs", "2025-2026");
const manifestPath = path.join(root, "data/manifests/source-manifest.json");
const templateDir = path.join(root, "templates");
const canonicalCoursesPath = path.join(normalizedDir, "courses.json");
const academicCalendarPath = path.join(root, "data/normalized/academic-calendars.json");

const sourceFiles = [
  ["Econ_Major_Requirements_and_Prerequisites (1).md", "Econ_Major_Requirements_and_Prerequisites.md"],
  ["Econ_Course_Offerings.md", "Econ_Course_Offerings.md"],
  ["Term_Structure.md", "Term_Structure.md"],
  ["07_spiffy_dashboard_template.html", "07_spiffy_dashboard_template.html"]
];

const scheduleImages = [
  [
    "C:/Users/EIRIKS~1/AppData/Local/Temp/codex-clipboard-0e39dce4-98b3-4a83-9a5a-f2d8777c3985.png",
    "schedule-2026-2027-fall.png"
  ],
  [
    "C:/Users/EIRIKS~1/AppData/Local/Temp/codex-clipboard-6a4aa25c-7f4c-4954-8ba6-3109ab84686a.png",
    "schedule-2026-2027-winter-spring.png"
  ]
];

const economicsRequirements = {
  id: "economics-major",
  catalogYear: "2025-2026",
  sourceStatus: "APPROVED_LOCAL_SOURCE",
  sourceRefs: [
    "data/raw/economics/Econ_Major_Requirements_and_Prerequisites.md",
    "data/raw/economics/Econ_Course_Offerings.md",
    "data/raw/economics/Term_Structure.md"
  ],
  requirementSlots: [
    { id: "eco-113", label: "ECO 113", kind: "exact", options: ["ECO 113"], units: 1 },
    { id: "eco-114", label: "ECO 114", kind: "exact", options: ["ECO 114"], units: 1 },
    { id: "eco-213", label: "ECO 213", kind: "exact", options: ["ECO 213"], units: 1 },
    { id: "eco-214", label: "ECO 214", kind: "exact", options: ["ECO 214"], units: 1 },
    {
      id: "statistics",
      label: "MAT 217 / ECO 257 / PSY 217",
      kind: "choice",
      options: ["MAT 217", "ECO 257", "PSY 217"],
      units: 1,
      provisionalOptions: ["PSY 217"]
    },
    {
      id: "finance",
      label: "ECO 321 / BUSN 323",
      kind: "choice",
      options: ["ECO 321", "BUSN 323"],
      preferredOptions: ["BUSN 323", "ECO 321"],
      units: 1
    },
    { id: "eco-461", label: "ECO 461", kind: "exact", options: ["ECO 461"], residency: "hanover", units: 1 },
    {
      id: "cognate",
      label: "MAT 113 / MAT 121",
      kind: "choice",
      options: ["MAT 113", "MAT 121"],
      units: 1
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `eco-elective-${index + 1}`,
      label: `ECO elective ${index + 1}`,
      kind: "elective",
      subject: "ECO",
      excludedCourses: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 257", "ECO 461", "ECO 307"],
      conditionalCourses: {
        "ECO 321": {
          slotId: "finance",
          assignedCode: "BUSN 323"
        }
      },
      maxLevel100: 1,
      units: 1
    }))
  ],
  rules: {
    totalMajorCourses: 11,
    totalCognateCourses: 1,
    max100LevelElectives: 1,
    noDoubleCountUnlessExplicit: true
  }
};

const economicsPrerequisites = {
  "ECO 213": {
    all: ["ECO 113"],
    any: [["MAT 113", "MAT 121"]],
    concurrentWithApproval: [{
      options: ["MAT 113", "MAT 121"],
      approval: "instructor",
      policySource: "department-approved",
      lastResortOnly: true
    }]
  },
  "ECO 214": {
    all: ["ECO 114"],
    any: [["MAT 113", "MAT 121"]],
    concurrentWithApproval: [{
      options: ["MAT 113", "MAT 121"],
      approval: "instructor",
      policySource: "department-approved",
      lastResortOnly: true
    }]
  },
  "ECO 221": { all: ["ECO 113"], any: [] },
  "ECO 222": { all: ["ECO 114"], any: [] },
  "ECO 223": { all: [], any: [["ECO 113", "ECO 114", "ECO 161"]] },
  "ECO 257": { all: [], any: [["ECO 113", "ECO 114"]] },
  "ECO 315": { all: [], any: [["ECO 113", "ECO 114"]] },
  "ECO 316": { all: ["ECO 113", "ECO 114"], any: [] },
  "ECO 321": { all: ["ECO 113", "ECO 114"], any: [] },
  "ECO 331": { all: ["ECO 213"], any: [] },
  "ECO 333": { all: ["ECO 114"], any: [] },
  "ECO 335": { all: ["ECO 213", "ECO 257"], any: [["MAT 121"]] },
  "ECO 337": { all: [], any: [["ECO 113", "ECO 114"]] },
  "ECO 357": { all: ["ECO 213", "ECO 214"], any: [], permission: "department" },
  "ECO 461": { all: ["ECO 213", "ECO 214"], any: [["ECO 257", "MAT 217", "PSY 217"]] },
  "ECO 471": { all: ["ECO 213", "ECO 214", "ECO 321"], any: [] }
};

const schedule2026 = {
  academicYear: "2026-2027",
  verifiedOn: "2026-07-28",
  source: {
    type: "user_provided_schedule_screenshots",
    files: [
      "data/raw/economics/schedule-2026-2027-fall.png",
      "data/raw/economics/schedule-2026-2027-winter-spring.png"
    ],
    sectionCodeSMeans: "May",
    summerOfferingNote: "ECO 113 is available online in Summer as a last-resort option when the regular academic-year schedule cannot fit the student."
  },
  courseOfferingNotes: {
    "ECO 461": "Normally one Winter offering per academic year; verify future schedules before treating a later offering as confirmed."
  },
  terms: {
    Fall: [
      { course: "ECO 113", section: "A", title: "Principles of Microeconomics" },
      { course: "ECO 114", section: "A", title: "Principles of Macroeconomics" },
      { course: "ECO 114", section: "B", title: "Principles of Macroeconomics" },
      { course: "ECO 114", section: "C", title: "Principles of Macroeconomics" },
      { course: "ECO 213", section: "A", title: "Intermediate Microeconomics" },
      { course: "ECO 234", section: "A", title: "Rational Choices" },
      { course: "ECO 333", section: "A", title: "International Trade & Finance" }
    ],
    Winter: [
      { course: "ECO 113", section: "J", title: "Principles of Microeconomics" },
      { course: "ECO 113", section: "K", title: "Principles of Microeconomics" },
      { course: "ECO 114", section: "J", title: "Principles of Macroeconomics" },
      { course: "ECO 161", section: "J", title: "Foundations of Economics" },
      { course: "ECO 214", section: "J", title: "Intermediate Macroeconomics" },
      { course: "ECO 221", section: "J", title: "Environmental Economics" },
      { course: "ECO 321", section: "J", title: "Money & Financial Markets" },
      { course: "ECO 461", section: "J", title: "Senior Seminar - Econometrics" }
    ],
    May: [
      { course: "ECO 222", section: "S", title: "Economics of the European Union" },
      { course: "ECO 260", section: "S", title: "Special Topics" }
    ],
    Summer: [
      {
        course: "ECO 113",
        section: "Online",
        title: "Principles of Microeconomics",
        delivery: "online",
        planningNote: "Last-resort summer option"
      }
    ]
  }
};

async function validateApprovedData() {
  const canonical = JSON.parse(await readFile(canonicalCoursesPath, "utf8"));
  const calendars = JSON.parse(await readFile(academicCalendarPath, "utf8"));
  const courses = canonical.courses || [];
  const codes = courses.map(course => course.code);
  const aliases = courses.flatMap(course => course.aliases || []);

  if (!courses.length || new Set(codes).size !== codes.length) {
    throw new Error("Canonical Economics courses are missing or contain duplicate codes.");
  }
  if (aliases.some(alias => codes.includes(alias))) {
    throw new Error("A canonical Economics alias duplicates a canonical course code.");
  }
  if (!calendars.summerClarificationWindows?.length) {
    throw new Error("The approved academic-calendar boundaries are missing.");
  }
}

async function ensureDirectories() {
  await Promise.all([
    mkdir(rawDir, { recursive: true }),
    mkdir(normalizedDir, { recursive: true }),
    mkdir(versionedNormalizedDir, { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
    mkdir(templateDir, { recursive: true })
  ]);
}

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function copySource(sourcePath, targetPath) {
  await copyFile(sourcePath, targetPath);
  return { path: path.relative(root, targetPath).replaceAll("\\", "/"), sha256: await sha256(targetPath) };
}

await ensureDirectories();
await validateApprovedData();

const manifestEntries = [];
for (const [sourceName, targetName] of sourceFiles) {
  const sourcePath = path.join(sourceRoot, sourceName);
  const targetPath = path.join(rawDir, targetName);
  manifestEntries.push({
    role: "economics_source",
    source: `department-provided:${sourceName}`,
    ...(await copySource(sourcePath, targetPath))
  });
}

const templatePath = path.join(templateDir, "econplannertemplate.html");
const template = await readFile(path.join(rawDir, "07_spiffy_dashboard_template.html"), "utf8");
await writeFile(
  templatePath,
  template
    .replaceAll("YOUR UNIVERSITY", "HANOVER COLLEGE")
    .replaceAll("Your University monogram", "Hanover College monogram")
    .replaceAll(">U</text>", ">H</text>")
    .replaceAll("DISCOVER. LEARN. LEAD.", "PLAN. MAP. ADVISE.")
    .replaceAll("Office of Academic Planning", "Hanover Academic Advising")
    .replaceAll("Economics Program", "EconMapper"),
  "utf8"
);

for (const [sourcePath, targetName] of scheduleImages) {
  const targetPath = path.join(rawDir, targetName);
  manifestEntries.push({
    role: "economics_schedule_evidence",
    source: "user-provided-schedule-screenshot",
    ...(await copySource(sourcePath, targetPath))
  });
}

manifestEntries.push(
  {
    role: "economics_canonical_courses",
    source: "https://catalog.hanover.edu/programs/economics.php",
    catalogYear: "2025-2026",
    retrievedOn: "2026-07-29",
    approvalStatus: "APPROVED_LOCAL_SOURCE",
    path: path.relative(root, canonicalCoursesPath).replaceAll("\\", "/"),
    sha256: await sha256(canonicalCoursesPath)
  },
  {
    role: "academic_calendar",
    source: "https://www.hanover.edu/academics/calendar/",
    academicYear: "2026-2027",
    retrievedOn: "2026-07-29",
    approvalStatus: "OFFICIAL_HANOVER_SOURCE",
    path: path.relative(root, academicCalendarPath).replaceAll("\\", "/"),
    sha256: await sha256(academicCalendarPath)
  }
);

await writeFile(path.join(normalizedDir, "requirements.json"), `${JSON.stringify(economicsRequirements, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "prerequisites.json"), `${JSON.stringify(economicsPrerequisites, null, 2)}\n`, "utf8");
await writeFile(path.join(versionedNormalizedDir, "economics-requirements.json"), `${JSON.stringify(economicsRequirements, null, 2)}\n`, "utf8");
await writeFile(path.join(versionedNormalizedDir, "economics-prerequisites.json"), `${JSON.stringify(economicsPrerequisites, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "schedule-2026-2027.json"), `${JSON.stringify(schedule2026, null, 2)}\n`, "utf8");
await writeFile(
  path.join(normalizedDir, "planning-constraints.json"),
  `${JSON.stringify({
    terms: {
      Fall: { maxTotalCourses: 4, maxEconomicsCourses: 2 },
      Winter: { maxTotalCourses: 4, maxEconomicsCourses: 2 },
      May: { maxTotalCourses: 1, maxEconomicsCourses: 1 },
      Summer: {
        maxTotalCourses: 1,
        maxEconomicsCourses: 1,
        planningNote: "Use only as a last resort; ECO 113 is the verified summer option and is online."
      }
    },
    hardRules: [
      "ECO 213 and ECO 214 cannot share a term",
      "ECO 213 and ECO 214 cannot be scheduled in May",
      "ECO 461 is senior Winter only",
      "MAT 113 or MAT 121 may be concurrent with ECO 213 or ECO 214 only as a last resort with the ECO course instructor's approval; every other prerequisite must be completed first",
      "A generated plan never adds courses to the regular term containing the plan-creation date; current-term courses must be recorded as In Progress",
      "A prerequisite currently In Progress becomes available for a dependent course only after the current term"
    ],
    futureSchedulePolicy: "Use a Term to be confirmed placeholder when an exact annual offering is not verified."
  }, null, 2)}\n`,
  "utf8"
);

const existingManifest = await (async () => {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return { generatedAt: null, entries: [] };
  }
})();

const nonEconomicsEntries = existingManifest.entries.filter(entry => ![
  "economics_source",
  "economics_schedule_evidence",
  "economics_canonical_courses",
  "academic_calendar"
].includes(entry.role));
await writeFile(
  manifestPath,
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    entries: [...nonEconomicsEntries, ...manifestEntries]
  }, null, 2)}\n`,
  "utf8"
);

console.log(`Ingested ${manifestEntries.length} Economics source files and schedule evidence.`);
