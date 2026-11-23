import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildPlanConditions, studentFacingPlanReviewMessage, studentFacingPrerequisiteReview, studentFriendlyCourseMarker, studentFriendlyUnavailableReason } from "../lib/planning/plan-presentation.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { resolveCatalogApplicability } from "../lib/catalog/applicability.js";

const policyBundle = runtimePolicyBundle();
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
  assert.match(review.summary, /You marked ECO 213 completed, but ECO 113.*marked Taking now/);
  assert.match(review.summary, /advisor will check it\. Also: MAT 113 or MAT 121 is not marked completed\.$/);
  assert.match(review.message, /You marked ECO 213 completed, but ECO 113.*marked Taking now/);
  assert.match(review.message, /You marked ECO 213 completed, but MAT 113 or MAT 121.*not marked completed/);
  assert.doesNotMatch(review.message, /Your answers do not show|Ask your advisor to check your earlier course/);
  assert.match(review.advisorPrompt, /ECO 113 and either MAT 113 or MAT 121/);

  const conditions = buildPlanConditions({
    plan: { validation: { reviewFindings: [decision], conditions: [{ reasonCode: decision.reasonCode, affectedObject: { course: "ECO 213" }, message: "Old historical note." }] } },
    student,
    policyBundle
  });
  assert.equal(conditions.length, 2);
  assert.deepEqual(conditions.map(item => item.message), review.details);
  assert.equal(conditions[0].shortMessage, review.summary);
  assert.equal(conditions[0].advisorPrompt, review.advisorPrompt);
  assert.equal(conditions[1].advisorPrompt, undefined);

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
  assert.equal(studentFriendlyUnavailableReason({ message: "ECO 224 has no verified, conflict-free section in Winter 2027." }),
    "No conflict-free section is available in the published Winter 2027 schedule.");
  assert.equal(studentFriendlyUnavailableReason({ message: "This named future course needs a matching verified offering." }),
    "Schedule not yet published.");
  assert.equal(studentFriendlyUnavailableReason({ message: "Spring/May 2028 exceeds the total course limit." }),
    "Term full. Move a course out first.");
  assert.equal(studentFriendlyUnavailableReason({ message: "ECO 214 is missing prerequisites: ECO 114." }),
    "Take ECO 114 before this class.");
  assert.equal(studentFriendlyCourseMarker("Approval required"), "Approval needed");
  assert.equal(studentFriendlyCourseMarker("Eligibility review required"), "Ask an advisor whether this class counts");
  assert.equal(studentFriendlyCourseMarker("Confirm senior standing"), "Ask your advisor and the Registrar to confirm senior standing");
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
  assert.equal(studentFriendlyUnavailableReason({message:"ECO 214 is missing prerequisites: ECO 114." + capacity}), "Take ECO 114 before this class.");
  assert.equal(studentFriendlyUnavailableReason({message:"ECO 222 is not listed in its complete Fall 2026 schedule scope." + capacity}), "This class isn’t listed in the published Fall 2026 schedule.");
  assert.equal(studentFriendlyUnavailableReason({message:"At most one Economics elective may be planned in an unpublished Fall, Winter or May term." + capacity}), "Move the elective already here first.");
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
  assert.equal(studentFriendlyMoveCondition({ requiredApprovals: [{ type: "instructor", course: "ECO 213", prerequisite: "MAT 113" }] }, "MAT 113"), "Same term as ECO 213 — instructor approval needed.");
});

test("moving a prerequisite explains which dependent course needs to move", () => {
  assert.equal(studentFriendlyUnavailableReason({movingCourse: "MAT 113", message: "ECO 213 is missing prerequisites: MAT 113 / MAT 121."}), "ECO 213 needs MAT 113 first. Move ECO 213 later, then try again.");
  assert.equal(studentFriendlyUnavailableReason({movingCourse: "ECO 321", message: "ECO 471 is missing prerequisites: ECO 321."}), "ECO 471 needs ECO 321 first. Move ECO 471 later, then try again.");
});
