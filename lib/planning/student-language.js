const DISPLAY_MESSAGE_KEYS = ["offering.preliminarySchedule", "offering.unpublishedSchedule",
  "infeasibility.courseCapacity",
  "history.scheduledPrerequisite",
  "checklist.statisticsAlreadyFilled",
  "checklist.prerequisiteNotCompleted",
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
  "move.requirementUnmet"];

export function studentDisplayMessages(bundle) {
  if (bundle?.activationStatus !== "ACTIVE") throw new Error("An active policy bundle is required for student messages.");
  return Object.fromEntries(DISPLAY_MESSAGE_KEYS.map(key => [key, requiredDisplayMessage(bundle.messages, key)]));
}

function requiredDisplayMessage(messages, key) {
  const message = messages?.[key];
  if (typeof message !== "string" || !message.trim()) throw new Error(`Missing policy message: ${key}`);
  return message;
}

export function displayMessage(messages, key, params = {}) {
  return requiredDisplayMessage(messages, key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

export function preliminaryScheduleExplanation(issuedOn, messages) {
  return requiredDisplayMessage(messages, "offering.preliminarySchedule").replace("{issuedOn}", issuedOn);
}

export function studentTermLabel(value) { return String(value || "").replaceAll("Spring/May", "May"); }

const englishPluralRules = new Intl.PluralRules("en-US");
export function pluralize(count, singular, plural = `${singular}s`) {
  return englishPluralRules.select(Number(count)) === "one" ? singular : plural;
}

export function studentStandingSummary(student = {}) {
  const standing = ({ freshman: "Freshman", sophomore: "Sophomore", junior: "Junior", senior: "Senior" })[String(student.academicStanding || "").toLowerCase()]
    || student.academicStanding || (student.isTransferStudent ? "Transfer plan" : "Not supplied");
  if (student.customGraduationEnabled) return `${standing} (custom graduation year)`;
  if (student.planningPace === "one_year_early" && student.acceleratedPlanExists !== false) return `${standing} (graduating one year early)`;
  return standing;
}

export function studentFriendlyUnavailableReason(item = {}, messages) {
  return studentFriendlyUnavailableAdvice(item, messages).message;
}

function hasReasonCode(item, ...codes) {
  return codes.some(code => item.reasonCode === code || item.reasonCodes?.includes(code));
}

// The statistics choice that ECO 461 requires. Kept equal to the
// "statistics" options in data/normalized/economics/requirements.json by a test.
export const STATISTICS_COURSES = ["ECO 257", "MAT 217", "PSY 217"];

function studentCourseName(course) {
  return course === "ECO elective" ? "Economics elective" : course;
}

// Name the destination term with its year ("Winter 2027"). Move results carry
// reasonTerm when blocked; otherwise the label reads "2026/2027 Winter".
function moveTermName(item = {}) {
  if (item.reasonTerm) return studentTermLabel(item.reasonTerm);
  const label = studentTermLabel(item.label).match(/(\d{4})\/(\d{4}) (Fall|Winter|May)/);
  if (label) return `${label[3]} ${label[3] === "Fall" ? label[1] : label[2]}`;
  return studentTermLabel(item.label) || "that term";
}

function isMayMove(item = {}) {
  return /\bMay\b/.test(studentTermLabel(item.reasonTerm || item.label || ""));
}

function moveCourseName(item = {}, fromMessage = "") {
  return studentCourseName(fromMessage || item.reasonCourse || item.course || item.movingCourse || "") || "the course";
}

export function studentFriendlyUnavailableAdvice(item = {}, messages) {
  const advice = (message, suggestsFix = false) => ({ message, suggestsFix });
  const message = String(item.message || "");
  if (item.status === "ALLOWED") return advice("This change passes the plan checks.");
  const term = moveTermName(item);
  const dependent = message.match(/([A-Z]+ \d+) is missing prerequisites?(?: or a required permission)?:\s*([^.]+)/i);
  if (item.movingCourse && dependent && dependent[1] !== item.movingCourse && dependent[2].includes(item.movingCourse)) {
    return advice(displayMessage(messages, "move.dependentPrerequisite", { moving: item.movingCourse, dependent: dependent[1] }), true);
  }
  const publishedAbsence = message.match(/^(.+?) has no verified, conflict-free section in (Fall|Winter|Spring\/May|May) (\d{4})/i);
  if (hasReasonCode(item, "NO_VERIFIED_CONFLICT_FREE_SECTION") || publishedAbsence) {
    return advice(displayMessage(messages, "move.noSectionFits", {
      course: moveCourseName(item, publishedAbsence?.[1]),
      term: publishedAbsence ? studentTermLabel(`${publishedAbsence[2]} ${publishedAbsence[3]}`) : term }));
  }
  if (hasReasonCode(item, "NAMED_FUTURE_COURSE_REQUIRES_VERIFIED_OFFERING") || /matching verified offering|named future course needs/i.test(message)) {
    return advice(displayMessage(messages, "move.namedCourseUnpublished", { course: moveCourseName(item), term }));
  }
  if (hasReasonCode(item, "COURSE_NOT_SUPPORTED_IN_MAY") || /cannot be projected in May/i.test(message)) {
    return advice(displayMessage(messages, "move.notOfferedInMay", { course: moveCourseName(item, message.match(/([A-Z]+ \d+) cannot be projected in May/i)?.[1]) }));
  }
  if (hasReasonCode(item, "UNAPPROVED_UNPUBLISHED_TERM") || /projected only in MAY/i.test(message)) {
    const mayOnly = hasReasonCode(item, "UNAPPROVED_UNPUBLISHED_TERM") && item.reasonRecurringTerms
      ? item.reasonRecurringTerms.length === 1 && item.reasonRecurringTerms[0] === "MAY"
      : /projected only in MAY when/i.test(message);
    const course = item.reasonCourse || message.match(/([A-Z]+ \d+) is projected only in MAY when/i)?.[1];
    if (mayOnly && course) {
      const termOnly = studentTermLabel(item.label).split(" ").at(-1);
      return advice(displayMessage(messages, termOnly ? "move.mayOnlyUnconfirmed" : "move.mayOnlyUnconfirmedTermUnknown", { course, term: termOnly }));
    }
    return advice(`Not confirmed for ${studentTermLabel(item.label).split(" ").at(-1) || "this term"}.`);
  }
  if (hasReasonCode(item, "INTERMEDIATE_SAME_TERM_REQUIRES_VERIFIED_SCHEDULE") || /need separate terms/i.test(message)) {
    const courses = message.match(/([A-Z]+ \d+(?: and [A-Z]+ \d+)+) need separate terms/i)?.[1] || "These courses";
    return advice(displayMessage(messages, "move.intermediateSeparateTerms", { courses }));
  }
  if (hasReasonCode(item, "ECO_461_WINTER_ONLY") || /must be placed in Winter/i.test(message)) {
    return advice(displayMessage(messages, "move.winterOnly", { course: moveCourseName(item, message.match(/([A-Z]+ \d+) must be placed in Winter/i)?.[1]) }));
  }
  if (hasReasonCode(item, "TOTAL_COURSE_LIMIT_EXCEEDED", "ECONOMICS_COURSE_LIMIT_EXCEEDED") || /exceeds? (?:the )?(?:total |Economics )?course limit|exceeds? (?:the )?(?:published )?term limit|exceeds? (?:the )?term capacity/i.test(message)) {
    return advice(requiredDisplayMessage(messages, isMayMove(item) ? "move.mayFull" : "move.termFull"), true);
  }
  if (hasReasonCode(item, "UNPUBLISHED_TERM_ELECTIVE_LIMIT") || /at most one Economics elective may be planned/i.test(message)) {
    return advice(requiredDisplayMessage(messages, "move.electiveAlreadyHere"), true);
  }
  const absent = message.match(/^(.+?) is not listed in its complete (Fall|Winter|May) (\d{4}) schedule scope/i);
  if (hasReasonCode(item, "NOT_OFFERED_IN_COMPLETE_SCHEDULE") || absent) {
    return advice(displayMessage(messages, "move.notOfferedInTerm", {
      course: moveCourseName(item, absent?.[1]), term: absent ? `${absent[2]} ${absent[3]}` : term }));
  }
  if (item.status === "CONDITIONAL" && /exact schedule has not been published/i.test(message)) {
    return advice("This placement depends on the future schedule. Check it when the college publishes it.");
  }
  const prerequisites = message.match(/([A-Z]+ \d+) is missing prerequisites?(?: or a required permission)?:\s*([^.]+)/i);
  const missing = prerequisites ? prerequisites[2].split(/\s+\/\s+/).map(code => code.trim()).filter(code => /^[A-Z]+ \d+$/.test(code)) : [];
  // A missing permission with no named course is for the advisor, not a course to take.
  if (prerequisites && !missing.length) return advice(requiredDisplayMessage(messages, "move.advisorCheck"));
  if (prerequisites) {
    const isStatistics = missing.length === STATISTICS_COURSES.length && STATISTICS_COURSES.every(code => missing.includes(code));
    return advice(isStatistics
      ? displayMessage(messages, "move.statisticsFirst", { course: prerequisites[1] })
      : displayMessage(messages, "move.takePrerequisiteFirst", { course: prerequisites[1], courses: missing.join(" or ") }));
  }
  if (/prerequisite/i.test(message)) return advice(displayMessage(messages, "move.prerequisiteMustComeFirst", { course: moveCourseName(item) }));
  if (/conflict/i.test(message)) return advice("A class-time conflict prevents this move.");
  if (/advisor|review|required evidence/i.test(message) || item.status === "REVIEW_REQUIRED") {
    return advice(requiredDisplayMessage(messages, "move.advisorCheck"));
  }
  if (/not allowed|not eligible/i.test(message)) return advice(displayMessage(messages, "move.notOfferedOrAllowed", { course: moveCourseName(item), term }));
  if (/requirement|allocation/i.test(message)) return advice(requiredDisplayMessage(messages, "move.requirementUnmet"));
  if (item.status === "CONDITIONAL") return advice(message);
  return advice("This move needs an advisor’s review.");
}

export function studentFriendlyCourseMarker(marker) {
  return ({
    "Approval required": "Approval needed",
    "Confirm senior standing": "Ask your advisor and the Registrar to confirm senior standing",
    "Eligibility review required": "Ask an advisor whether this class counts",
    "Enrollment review required": "Check this class’s enrollment status"
  })[marker] || marker;
}


export function isUnpublishedScheduleCondition(item = {}) {
  return item.status === "CONDITIONAL" && !(item.requiredApprovals || []).length
    && /exact schedule has not been published|future schedule is unpublished|future offering|projected placement/i.test(item.message || "");
}

export function studentFriendlyMoveCondition(item = {}, movingCourse, messages) {
  const approvals = item.requiredApprovals || [];
  if (approvals.length) {
    const seen = new Set();
    return approvals.flatMap(approval => {
      const authority = approval.type === "instructor" ? "instructor" : approval.authority || "advisor";
      const key = `${approval.prerequisite || ""}|${approval.course || ""}|${authority}`;
      if (seen.has(key)) return [];
      seen.add(key);
      if (!approval.prerequisite || !approval.course) return [`${authority} approval needed.`];
      const params = { prerequisite: approval.prerequisite, course: approval.course,
        term: approval.term ? studentTermLabel(approval.term) : moveTermName(item), authority };
      return [displayMessage(messages, approval.type === "instructor"
        ? "move.sameTermPrerequisiteApproval" : "move.sameTermPrerequisiteOtherApproval", params)];
    }).join(" ");
  }
  if (isUnpublishedScheduleCondition(item)) {
    return requiredDisplayMessage(messages, "offering.unpublishedSchedule");
  }
  return studentFriendlyUnavailableReason({ movingCourse, ...item }, messages);
}

// Translate check explanations without changing their decisions or dropping
// unfamiliar conditions. Keep units: a course need not equal one unit.
export function studentFriendlyMoveDetails(item = {}) {
  return studentTermLabel(item.message)
    .replace(/Within normal capacity: ([\d.]+) of ([\d.]+) modeled units\./g,
      "Your plan would use $1 of the usual $2 course units for this term.")
    .replace(/Projected placement; the exact schedule has not been published and may change\./g,
      "The schedule isn’t published yet, so this placement may change.")
    .replace(/([A-Z]+ \d+) is planned concurrently with ([A-Z]+ \d+)\. Approval from the ([A-Z]+ \d+) instructor is required\./g,
      "Taking $1 and $2 in the same term needs approval from the $3 instructor.")
    .replace(/([A-Z]+ \d+) is missing prerequisites?:\s*([^.]+)\./g,
      (_, course, prerequisites) => `${course} needs ${prerequisites.replace(/\s+\/\s+/g, " or ")} first. Keep the required course earlier, or move ${course} to a later term and check again.`)
    .replace(/\bmodeled units\b/g, "planned course units")
    .trim();
}

export function studentFriendlyMoveNextStep(item = {}) {
  const message = String(item.message || "");
  // Making room cannot resolve an offering restriction. Do not suggest it as
  // a way around an unpublished or prohibited offering.
  if (item.ruleId || hasReasonCode(item, "NO_VERIFIED_CONFLICT_FREE_SECTION", "NAMED_FUTURE_COURSE_REQUIRES_VERIFIED_OFFERING", "UNAPPROVED_UNPUBLISHED_TERM", "COURSE_NOT_SUPPORTED_IN_MAY", "NOT_OFFERED_IN_COMPLETE_SCHEDULE") || /not listed|no verified|cannot be projected|projected only|not eligible|matching verified offering/i.test(message)) return "";
  if (hasReasonCode(item, "TOTAL_COURSE_LIMIT_EXCEEDED", "ECONOMICS_COURSE_LIMIT_EXCEEDED") || /exceeds? (?:the )?(?:total |Economics )?course limit|exceeds? (?:the )?(?:published )?term limit|exceeds? (?:the )?term capacity/i.test(message)) {
    return "Move a course out of this term to make room, then try again. The other course checks still need to pass.";
  }
  if (hasReasonCode(item, "UNPUBLISHED_TERM_ELECTIVE_LIMIT") || /at most one Economics elective may be planned/i.test(message)) {
    return "Move the Economics elective already in this term elsewhere, then try again.";
  }
  return "";
}
