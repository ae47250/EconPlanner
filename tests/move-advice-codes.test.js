import test from "node:test";
import assert from "node:assert/strict";
import * as language from "../lib/planning/student-language.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";

const messages = language.studentDisplayMessages(runtimePolicyBundle());
const courseLimitNext = "Move a course out of this term to make room, then try again. The other course checks still need to pass.";
const cases = [
  ["TOTAL_COURSE_LIMIT_EXCEEDED", "Winter exceeds the total course limit.", "Term full. Move a course out first.", courseLimitNext, true],
  ["ECONOMICS_COURSE_LIMIT_EXCEEDED", "Winter exceeds the Economics course limit.", "Term full. Move a course out first.", courseLimitNext, true],
  ["UNPUBLISHED_TERM_ELECTIVE_LIMIT", "At most one Economics elective may be planned in this term.", "Move the elective already here first. The department usually offers only one Economics elective each Fall and Winter.", "Move the Economics elective already in this term elsewhere, then try again.", true],
  ["NAMED_FUTURE_COURSE_REQUIRES_VERIFIED_OFFERING", "A named future course needs a matching verified offering.", messages["offering.unpublishedSchedule"], "", false],
  ["COURSE_NOT_SUPPORTED_IN_MAY", "ECO 213 cannot be projected in May. A matching verified schedule is required.", "Not confirmed for May.", "", false],
  ["UNAPPROVED_UNPUBLISHED_TERM", "ECO 222 is projected only in MAY when its schedule is unpublished. Another term requires a matching verified schedule section.", "ECO 222 is normally offered only in May. No May section is confirmed.", "", false],
  ["NOT_OFFERED_IN_COMPLETE_SCHEDULE", "ECO 222 is not listed in its complete May 2027 schedule scope.", "This class isn’t listed in the published May 2027 schedule.", "", false],
  ["NO_VERIFIED_CONFLICT_FREE_SECTION", "ECO 222 has no verified, conflict-free section in May 2027. Choose another term.", "No conflict-free section is available in the published May 2027 schedule.", "", false]
];

for (const [code, originalMessage, expected, next, suggestsFix] of cases) {
  test(`${code}: rewording preserves advice, condition, next step and fix selection`, () => {
    assert.ok(expected.trim(), "Every case must have a non-empty expected answer.");
    const original = { status: "BLOCKED", message: originalMessage, label: "2026/2027 May", reasonTerm: "May 2027", ...(code === "UNAPPROVED_UNPUBLISHED_TERM" ? { reasonCourse: "ECO 222", reasonRecurringTerms: ["MAY"] } : {}) };
    assert.equal(language.studentFriendlyUnavailableReason(original, messages), expected);
    for (const status of ["BLOCKED", "CONDITIONAL"]) {
      for (const codeFields of [{ reasonCodes: [code] }, { reasonCode: code }]) {
        const item = { ...original, ...codeFields, status, message: "Placement unavailable." };
        assert.equal(language.studentFriendlyUnavailableReason(item, messages), expected);
        assert.equal(language.studentFriendlyMoveCondition(item, "ECO 222", messages), expected);
        assert.equal(language.studentFriendlyMoveNextStep(item), next);
        assert.deepEqual(language.studentFriendlyUnavailableAdvice(item, messages), { message: expected, suggestsFix });
      }
    }
  });
}

test("code checks preserve earlier advice branches and offering restrictions", () => {
  const item = { status: "BLOCKED", reasonCodes: ["TOTAL_COURSE_LIMIT_EXCEEDED"], movingCourse: "ECO 113" };
  assert.equal(language.studentFriendlyUnavailableReason({ ...item, message: "ECO 213 is missing prerequisites: ECO 113." }, messages),
    "ECO 113 is a prerequisite for ECO 213 and must come first. Move ECO 213 later, then try again.");
  assert.equal(language.studentFriendlyUnavailableReason({ ...item, message: "A named future course needs a matching verified offering." }, messages), messages["offering.unpublishedSchedule"]);
  assert.equal(language.studentFriendlyMoveNextStep({ ...item, ruleId: "offering-rule" }), "");
  assert.equal(language.studentFriendlyMoveNextStep({ ...item, reasonCodes: [...item.reasonCodes, "NO_VERIFIED_CONFLICT_FREE_SECTION"] }), "");
  assert.equal(language.studentFriendlyUnavailableReason({ ...item, status: "ALLOWED" }), "This change passes the plan checks.");
});

test("term-load decision codes do not acquire course-limit advice", () => {
  for (const reasonCode of ["TERM_CAPACITY_EXCEEDED", "TERM_OVERLOAD_EVIDENCE_REQUIRED"]) {
    const item = { status: "BLOCKED", reasonCodes: [reasonCode], message: "Placement unavailable." };
    assert.equal(language.studentFriendlyUnavailableReason(item), "This move needs an advisor’s review.");
    assert.equal(language.studentFriendlyMoveNextStep(item), "");
    assert.equal(language.studentFriendlyUnavailableAdvice(item).suggestsFix, false);
  }
});
