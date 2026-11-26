import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlanConditions, studentFacingPlanReviewMessage, studentFacingPrerequisiteReview, studentFriendlyCourseMarker, studentFriendlyUnavailableReason } from "../lib/planning/plan-presentation.js";
import { loadEconomicsPolicyCompatibility, runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { resolveCatalogApplicability } from "../lib/catalog/applicability.js";
import { isUnpublishedScheduleCondition, preliminaryScheduleExplanation, studentDisplayMessages, studentFriendlyMoveCondition } from "../lib/planning/student-language.js";

const policyBundle = runtimePolicyBundle();
const displayMessages = studentDisplayMessages(policyBundle);
const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");

test("non-registration notes have an advisor heading and the derived catalog year uses owner wording", () => {
  const html = renderEconomicsHtml({
    student: { displayName: "Fictional student", academicStanding: "freshman" },
    selectedPlan: { id: "balanced" }, terms: [], unresolved: [], planNotes: [],
    planConditions: [
      { id: "seat", kind: "seat", message: "Check seats." },
      { id: "advisor", kind: "review", message: "Check this history." }
    ]
  }, template);
  assert.match(html, /<h3>Before you register<\/h3><ul>.*Check seats/);
  assert.match(html, /<h3>Check with your advisor<\/h3><ul>.*Check this history/);
  const notice = resolveCatalogApplicability({ entryCatalogYear: "2026-2027", availableCatalogYears: ["2025-2026"] }).advisorNotice;
  assert.equal(notice.message, "Based on your class year, your catalog year is likely 2026–2027. The Economics major requirements are the same for both years.");
});

test("ECO 213 advisor status names the uncertain MAT 113 answer and explains the review", () => {
  const student = { courses: [
    { code: "ECO 113", status: "in_progress" },
    { code: "MAT 113", status: "uncertain" }
  ] };
  const decision = {
    reasonCode: "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW",
    subject: { course: "ECO 213" },
    requiredEvidence: ["ECO 113", "MAT 113", "MAT 121"],
    sourceRefs: ["DEPARTMENT-POLICIES#Confirmed-policy-7"]
  };
  const review = studentFacingPrerequisiteReview(decision, { student, policyBundle });
  assert.equal(review.summary, "ECO 213 is marked completed, but MAT 113 or MAT 121 is not marked, and ECO 113 is marked Taking now. Fix these, or your advisor will check.");
  assert.equal(review.message, review.summary);
  assert.doesNotMatch(review.message, /Your answers do not show|Ask your advisor to check your earlier course/);
  assert.match(review.advisorPrompt, /ECO 113 and either MAT 113 or MAT 121/);

  const conditions = buildPlanConditions({
    plan: { validation: { reviewFindings: [decision], conditions: [{ reasonCode: decision.reasonCode, affectedObject: { course: "ECO 213" }, message: "Old historical note." }] } },
    student,
    policyBundle
  });
  // Owner decision 2026-11-25: one message per course, so both gaps share one plan note.
  assert.equal(conditions.length, 1);
  assert.deepEqual(conditions.map(item => item.message), review.details);
  assert.equal(conditions[0].shortMessage, review.summary);
  assert.equal(conditions[0].advisorPrompt, review.advisorPrompt);

  const html = renderEconomicsHtml({
    student: { displayName: "Fictional student", academicStanding: "senior" },
    selectedPlan: { id: "balanced", feasibilityStatus: "CONDITIONALLY_FEASIBLE" },
    terms: [], unresolved: [], planConditions: conditions, studentNotices: [], catalog: {}, planNotes: []
  }, template);
  assert.ok(html.indexOf("What to check for this plan") < html.indexOf("For your advisor"));
  assert.ok(!html.includes("Why an advisor should review this plan:"));
  assert.ok(html.includes(review.advisorPrompt.replaceAll("'", "&#39;")));
  for (const message of review.details) assert.ok(html.includes(`<li data-plan-warning>${message}</li>`));
});

test("Hanover Core applicability uses the confirmed flexible catalog rules", () => {
  assert.equal(policyBundle.messages["designation.applicability"], undefined);
});

test("next-step prerequisites name only the actual course pairs in the selected schedule", () => {
  const conditions = buildPlanConditions({
    plan: {
      prerequisiteNotices: [{
        prerequisite: "ECO 114", prerequisiteStatus: "PLANNED_EARLIER",
        dependentCourse: "ECO 214", dependentTerm: "Winter 2028"
      }],
      displayWarnings: [policyBundle.planningAdvice.display.prerequisiteCompletion],
      validation: { conditions: [{ reasonCode: "PREREQUISITES_PENDING_SUCCESSFUL_COMPLETION" }] }
    },
    policyBundle
  });
  assert.deepEqual(conditions.map(item => item.message), ["Before taking ECO 214 in Winter 2028, finish ECO 114."]);
  assert.equal(conditions[0].kind, "prerequisite");
});

test("prerequisite reminders combine shared and related scheduled course steps", () => {
  const conditions = buildPlanConditions({
    plan: { prerequisiteNotices: [
      { prerequisite: "MAT 113", dependentCourse: "ECO 213", dependentTerm: "Fall 2027" },
      { prerequisite: "MAT 113", dependentCourse: "ECO 214", dependentTerm: "Winter 2028" },
      { prerequisite: "ECO 213", dependentCourse: "ECO 461", dependentTerm: "Winter 2029" },
      { prerequisite: "ECO 214", dependentCourse: "ECO 461", dependentTerm: "Winter 2029" },
      { prerequisite: "MAT 217", dependentCourse: "ECO 461", dependentTerm: "Winter 2029" }
    ] },
    policyBundle
  });
  assert.deepEqual(conditions.map(item => item.message), [
    "Before taking ECO 213 in Fall 2027 and ECO 214 in Winter 2028, finish MAT 113.",
    "Before taking ECO 461 in Winter 2029, finish ECO 213, ECO 214, and MAT 217."
  ]);
});

test("seat reminders name only scheduled classes with unconfirmed seat evidence", () => {
  const conditions = buildPlanConditions({
    plan: {
      planningDetailMessages: [
        "Seat availability for ECO 114-J was last checked on an unknown date; confirm it before registration.",
        "Seat availability for MAT 113-S was last checked on 2026-09-01; confirm it before registration."
      ],
      displayWarnings: [policyBundle.planningAdvice.display.seatConfirmation]
    },
    policyBundle
  });
  assert.deepEqual(conditions.map(item => item.message), [
    "We don’t know if there are open seats in ECO 114 and MAT 113. Check the registration system before you register."
  ]);
  assert.equal(buildPlanConditions({ plan: {}, policyBundle }).length, 0);
});

test("blocked-move summaries and course markers use student-facing language", () => {
  assert.equal(studentFriendlyUnavailableReason({ message: "ECO 224 has no verified, conflict-free section in Winter 2027." }, displayMessages),
    "No ECO 224 section fits in Winter 2027.");
  assert.equal(studentFriendlyUnavailableReason({ message: "This named future course needs a matching verified offering.", movingCourse: "ECO 333", label: "2028/2029 Winter" }, displayMessages),
    "ECO 333 can’t go in Winter 2029 until that schedule is published. Use an elective slot instead, or ask your advisor.");
  assert.equal(studentFriendlyUnavailableReason({ message: "Spring/May 2028 exceeds the total course limit.", reasonTerm: "Spring/May 2028" }, displayMessages),
    "May allows one course. Move the other one out first.");
  assert.equal(studentFriendlyUnavailableReason({ message: "Winter 2028 exceeds the total course limit.", reasonTerm: "Winter 2028" }, displayMessages),
    "Term full. Move a course out first.");
  assert.equal(studentFriendlyUnavailableReason({ message: "ECO 214 is missing prerequisites: ECO 114." }, displayMessages),
    "ECO 214 needs ECO 114 first.");
  assert.equal(studentFriendlyUnavailableReason({ message: "ECO 461 is missing prerequisites: ECO 257 / MAT 217 / PSY 217." }, displayMessages),
    "ECO 461 needs a statistics course first.");
  assert.equal(studentFriendlyUnavailableReason({ message: "ECO 213 is missing prerequisites: MAT 113 / MAT 121." }, displayMessages),
    "ECO 213 needs MAT 113 or MAT 121 first.");
  assert.equal(studentFriendlyUnavailableReason({ status: "BLOCKED", reasonCodes: ["INTERMEDIATE_SAME_TERM_REQUIRES_VERIFIED_SCHEDULE"], reasonTerm: "Fall 2028",
    message: "ECO 213 and ECO 214 need separate terms unless that year's verified schedule supports both in this term. This term has 2 courses. The normal limit is 4." }, displayMessages),
    "ECO 213 and ECO 214 must be in different terms unless that year’s published schedule lists both.");
  assert.equal(studentFriendlyUnavailableReason({ status: "BLOCKED", message: "ECO 213 is missing prerequisites or a required permission: ECO 113.", movingCourse: "ECO 213" }, displayMessages),
    "ECO 213 needs ECO 113 first.");
  assert.equal(studentFriendlyUnavailableReason({ status: "BLOCKED", message: "ECO 471 is missing prerequisites or a required permission: DEPARTMENT_PERMISSION.", movingCourse: "ECO 471" }, displayMessages),
    displayMessages["move.advisorCheck"]);
  assert.equal(studentFriendlyUnavailableReason({ status: "BLOCKED", reasonCodes: ["ECO_461_WINTER_ONLY"], reasonCourse: "ECO 461", reasonTerm: "Fall 2029",
    message: "ECO 461 must be placed in Winter. This term has 3 courses. The normal limit is 4." }, displayMessages),
    "ECO 461 is offered only in Winter.");
  assert.equal(studentFriendlyCourseMarker("Approval required"), "Approval needed");
  assert.equal(studentFriendlyCourseMarker("Eligibility review required"), "Ask an advisor whether this class counts");
  assert.equal(studentFriendlyCourseMarker("Confirm senior standing"), "Ask your advisor and the Registrar to confirm senior standing");
});

test("unpublished schedule grouping uses the condition, while its text comes from the catalog", () => {
  const item = { status: "CONDITIONAL", message: "Projected placement; the exact schedule has not been published and may change." };
  assert.equal(isUnpublishedScheduleCondition(item), true);
  assert.equal(studentFriendlyMoveCondition(item, undefined, displayMessages), policyBundle.messages["offering.unpublishedSchedule"]);
  assert.equal(isUnpublishedScheduleCondition({ ...item, requiredApprovals: [{ type: "advisor" }] }), false);
  assert.equal(isUnpublishedScheduleCondition({ ...item, status: "ALLOWED" }), false);
});

test("preliminary schedule copy is shared by the screen formatter and report HTML", () => {
  const sentence = "Preliminary schedule (2026-11-01). Course and term may change.";
  assert.equal(preliminaryScheduleExplanation("2026-11-01", displayMessages), sentence);
  const html = renderEconomicsHtml({
    student: { displayName: "Fictional student", academicStanding: "freshman" },
    selectedPlan: { id: "balanced" },
    terms: [{ term: "Fall 2027", academicYear: "2027-2028", courses: [{
      code: "ECO 213", title: "Intermediate Microeconomics",
      preliminaryScheduleEvidence: { issuedOn: "2026-11-01" }
    }] }],
    unresolved: [], planNotes: [], planConditions: []
  }, template);
  assert.match(html, /<span class="course-requirement">Preliminary schedule \(2026-11-01\)\. Course and term may change\.<\/span>/);
});

test("display messages require the verified active bundle, not an uncompiled source edit", async t => {
  const compiledRoot = await mkdtemp(path.join(os.tmpdir(), "econ-display-messages-"));
  t.after(() => rm(compiledRoot, { recursive: true, force: true }));
  const release = "releases/econ-2025-2026.1";
  const releaseSource = new URL(`../data/compiled/policy/${release}/`, import.meta.url);
  const bundlePath = path.join(compiledRoot, release, "bundle.json");
  const activePath = path.join(compiledRoot, "active.json");
  await cp(new URL("../data/compiled/policy/active.json", import.meta.url), activePath);
  await cp(releaseSource, path.join(compiledRoot, release), { recursive: true });

  const editedSource = JSON.parse(await readFile(new URL("../policy/messages/en-US.json", import.meta.url), "utf8"));
  editedSource.messages["offering.unpublishedSchedule"] = "Uncompiled source change.";
  editedSource.messages["offering.preliminarySchedule"] = "Uncompiled source change ({issuedOn}).";
  const isolatedPolicyPath = path.join(compiledRoot, "policy/messages/en-US.json");
  const isolatedLanguagePath = path.join(compiledRoot, "lib/planning/student-language.js");
  await mkdir(path.dirname(isolatedPolicyPath), { recursive: true });
  await mkdir(path.dirname(isolatedLanguagePath), { recursive: true });
  await writeFile(isolatedPolicyPath, JSON.stringify(editedSource));
  await writeFile(path.join(compiledRoot, "package.json"), '{"type":"module"}');
  await cp(new URL("../lib/planning/student-language.js", import.meta.url), isolatedLanguagePath);
  const loaded = await loadPolicyBundle({ compiledRoot, useCache: false });
  const isolatedLanguage = await import(pathToFileURL(isolatedLanguagePath).href);
  const loadedMessages = isolatedLanguage.studentDisplayMessages(loaded);
  assert.deepEqual(loadedMessages, displayMessages);
  assert.equal(isolatedLanguage.preliminaryScheduleExplanation("2026-11-01", loadedMessages),
    "Preliminary schedule (2026-11-01). Course and term may change.");
  assert.equal(isolatedLanguage.studentFriendlyMoveCondition({ status: "CONDITIONAL", message: "Projected placement; the exact schedule has not been published." }, undefined, loadedMessages),
    "Schedule not yet published.");
  assert.throws(() => preliminaryScheduleExplanation("2026-11-01"), /Missing policy message/);
  assert.throws(() => studentFriendlyMoveCondition({ status: "CONDITIONAL", message: "Projected placement; the exact schedule has not been published." }), /Missing policy message/);

  await rm(bundlePath);
  await assert.rejects(loadPolicyBundle({ compiledRoot, useCache: false }), { code: "ENOENT" });
  assert.throws(() => loadEconomicsPolicyCompatibility({ compiledRoot, useCache: false }), { code: "ENOENT" });
  await cp(new URL(`../data/compiled/policy/${release}/bundle.json`, import.meta.url), bundlePath);

  const active = JSON.parse(await readFile(activePath, "utf8"));
  active.programs.ECONOMICS["2025-2026"].activationStatus = "PENDING";
  await writeFile(activePath, JSON.stringify(active));
  await assert.rejects(loadPolicyBundle({ compiledRoot, useCache: false }), /not active/);
  assert.throws(() => loadEconomicsPolicyCompatibility({ compiledRoot, useCache: false }), /not active/);
  await cp(new URL("../data/compiled/policy/active.json", import.meta.url), activePath);

  const damaged = JSON.parse(await readFile(bundlePath, "utf8"));
  damaged.messages["offering.unpublishedSchedule"] = "Unverified bundle change.";
  await writeFile(bundlePath, JSON.stringify(damaged));
  await assert.rejects(loadPolicyBundle({ compiledRoot, useCache: false }), /digest mismatch/);
  assert.throws(() => loadEconomicsPolicyCompatibility({ compiledRoot, useCache: false }), /digest mismatch/);
});

test("full-section review names the enrollment evidence without exposing a policy code", () => {
  const decision = {
    reasonCode: "ENROLLMENT_FULL",
    subject: { course: "MAT 217" },
    offeringEvidence: { enrollmentState: "FULL" }
  };
  const message = "The listed section for MAT 217 was recorded as full. Check the registration system for current availability.";
  assert.equal(studentFacingPlanReviewMessage(decision), message);
  const conditions = buildPlanConditions({
    plan: { validation: { reviewFindings: [decision] }, displayWarnings: [message] },
    policyBundle
  });
  assert.deepEqual(conditions.map(({ message: text, course, kind }) => ({ message: text, course, kind })), [
    { message, course: "MAT 217", kind: "review" }
  ]);
});


test("capacity context never turns a valid choice or a different restriction into a full-term warning", () => {
  const capacity = " Within normal capacity: 2 of 4 modeled units.";
  assert.equal(studentFriendlyUnavailableReason({status:"ALLOWED", message:capacity}), "This change passes the plan checks.");
  assert.equal(studentFriendlyUnavailableReason({status:"CONDITIONAL", message:capacity + " Projected placement; the exact schedule has not been published and may change."}),
    "This placement depends on the future schedule. Check it when the college publishes it.");
  assert.equal(studentFriendlyUnavailableReason({message:"ECO 214 is missing prerequisites: ECO 114." + capacity}, displayMessages), "ECO 214 needs ECO 114 first.");
  assert.equal(studentFriendlyUnavailableReason({message:"ECO 222 is not listed in its complete Fall 2026 schedule scope." + capacity}, displayMessages), "ECO 222 isn’t offered in Fall 2026.");
  assert.equal(studentFriendlyUnavailableReason({message:"At most one Economics elective may be planned in an unpublished Fall, Winter or May term." + capacity}, displayMessages), "Only one elective per term until the schedule is published. Move the other elective first.");
});

test("move details explain course load, unpublished schedules, and concurrent approval plainly", async () => {
  const { studentFriendlyMoveDetails } = await import("../lib/planning/student-language.js");
  const message = "Within normal capacity: 2 of 4 modeled units. Projected placement; the exact schedule has not been published and may change. MAT 113 is planned concurrently with ECO 213. Approval from the ECO 213 instructor is required.";
  assert.equal(studentFriendlyMoveDetails({ message }), "Your plan would use 2 of the usual 4 course units for this term. The schedule isn’t published yet, so this placement may change. Taking MAT 113 and ECO 213 in the same term needs approval from the ECO 213 instructor.");
  assert.equal(studentFriendlyMoveDetails({message:"ECO 213 is missing prerequisites: MAT 113 / MAT 121."}), "ECO 213 needs MAT 113 or MAT 121 first. Keep the required course earlier, or move ECO 213 to a later term and check again.");
  assert.equal(studentFriendlyMoveDetails({message:"An additional approval is needed."}), "An additional approval is needed.");
});

test("making room is suggested for capacity, never as a workaround for offering restrictions", async () => {
  const { studentFriendlyMoveNextStep } = await import("../lib/planning/student-language.js");
  const message = "Spring/May 2028 exceeds the total course limit.";
  assert.match(studentFriendlyMoveNextStep({message}), /Move a course out of this term/);
  assert.equal(studentFriendlyMoveNextStep({message: "MAT 113 cannot be projected in May. " + message}), "");
  assert.equal(studentFriendlyMoveNextStep({message, ruleId:"PLANNING-MAY-COURSE-EXCLUSIONS"}), "");
});

 test("concurrent move warning says what permission is for", async () => {
  const { studentFriendlyMoveCondition } = await import("../lib/planning/student-language.js");
  assert.equal(studentFriendlyMoveCondition({ requiredApprovals: [{ type: "instructor", course: "ECO 213", prerequisite: "MAT 113", term: "Winter 2028" }] }, "MAT 113", displayMessages), "MAT 113 comes before ECO 213. Taking both in Winter 2028 needs the ECO 213 instructor’s approval.");
  assert.equal(studentFriendlyMoveCondition({ label: "2027/2028 Fall", requiredApprovals: [{ type: "instructor", course: "ECO 213", prerequisite: "MAT 113" }] }, "ECO 213", displayMessages), "MAT 113 comes before ECO 213. Taking both in Fall 2027 needs the ECO 213 instructor’s approval.");
});

test("moving a prerequisite explains which dependent course needs to move", () => {
  assert.equal(studentFriendlyUnavailableReason({movingCourse: "MAT 113", message: "ECO 213 is missing prerequisites: MAT 113 / MAT 121."}, displayMessages), "MAT 113 must come before ECO 213. Move ECO 213 later first.");
  assert.equal(studentFriendlyUnavailableReason({movingCourse: "ECO 321", message: "ECO 471 is missing prerequisites: ECO 321."}, displayMessages), "ECO 321 must come before ECO 471. Move ECO 471 later first.");
});


test("every owner-approved D1 message has text in the active display catalog", () => {
  const ids = [
    "infeasibility.courseCapacity",
    "history.scheduledPrerequisite",
    "planNote.mathSequence",
    "checklist.statisticsAlreadyFilled",
    "checklist.prerequisiteNotCompleted",
    "checklist.prerequisiteTakingNow",
    "checklist.concurrentPrerequisite",
    "catalog.petitionPlanCounts",
    "catalog.petitionPlanMayUse",
    "catalog.comprehensiveEvaluation",
    "move.electiveAlreadyHere",
    "move.dependentPrerequisite",
    "move.takePrerequisiteFirst",
    "move.prerequisiteMustComeFirst",
    "move.mayOnlyUnconfirmed",
    "move.mayOnlyUnconfirmedTermUnknown",
    "move.sameTermPrerequisiteApproval",
    "move.sameTermPrerequisiteOtherApproval",
    "move.intermediateSeparateTerms",
    "move.notOfferedInMay",
    "move.statisticsFirst",
    "move.noSectionFits",
    "move.notOfferedInTerm",
    "move.mayFull",
    "move.termFull",
    "move.namedCourseUnpublished",
    "move.winterOnly",
    "move.advisorCheck",
    "move.notOfferedOrAllowed",
    "move.requirementUnmet"
];
  for (const id of ids) {
    assert.equal(typeof displayMessages[id], "string", id);
    assert.ok(displayMessages[id].trim(), id);
  }
});

test("the statistics wording uses the same courses as the statistics requirement", async () => {
  const { STATISTICS_COURSES } = await import("../lib/planning/student-language.js");
  const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));
  const statistics = requirements.requirementSlots.find(slot => slot.id === "statistics");
  assert.deepEqual([...STATISTICS_COURSES].sort(), [...statistics.capstonePrerequisiteOptions].sort());
});

test("move wording names the course and never says this class", () => {
  const items = [
    { message: "ECO 224 has no verified, conflict-free section in Winter 2027." },
    { message: "ECO 222 is not listed in its complete Fall 2026 schedule scope." },
    { message: "ECO 214 is missing prerequisites: ECO 114." },
    { message: "A prerequisite is pending.", movingCourse: "ECO 333" },
    { message: "ECO 333 is not eligible in this term.", movingCourse: "ECO 333", label: "2027/2028 May" },
    { status: "BLOCKED", reasonCodes: ["COURSE_NOT_SUPPORTED_IN_MAY"], reasonCourse: "ECO 113", reasonTerm: "Spring/May 2027", message: "Placement unavailable." }
  ];
  for (const item of items) assert.doesNotMatch(studentFriendlyUnavailableReason(item, displayMessages), /this class/i);
  assert.equal(studentFriendlyUnavailableReason(items[3], displayMessages), "ECO 333 has a prerequisite that must come first.");
  assert.equal(studentFriendlyUnavailableReason(items[4], displayMessages), "ECO 333 isn’t offered or allowed in May 2028.");
});
