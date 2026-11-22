export function studentTermLabel(value) { return String(value || "").replaceAll("Spring/May", "May"); }

export function studentStandingSummary(student = {}) {
  const standing = ({ freshman: "Freshman", sophomore: "Sophomore", junior: "Junior", senior: "Senior" })[String(student.academicStanding || "").toLowerCase()]
    || student.academicStanding || (student.isTransferStudent ? "Transfer plan" : "Not supplied");
  if (student.customGraduationEnabled) return `${standing} (custom graduation year)`;
  if (student.planningPace === "one_year_early") return `${standing} (graduating one year early)`;
  return standing;
}

export function studentFriendlyUnavailableReason(item = {}) {
  const message = String(item.message || "");
  if (item.status === "ALLOWED") return "This change passes the plan checks.";
  const dependent = message.match(/([A-Z]+ \d+) is missing prerequisites?:\s*([^.]+)/i);
  if (item.movingCourse && dependent && dependent[1] !== item.movingCourse && dependent[2].includes(item.movingCourse)) {
    return `${dependent[1]} needs ${item.movingCourse} first. Move ${dependent[1]} later, then try again.`;
  }
  const publishedAbsence = message.match(/no verified, conflict-free section in (Fall|Winter|Spring\/May|May) (\d{4})/i);
  if (publishedAbsence) return `No conflict-free section is available in the published ${publishedAbsence[1]} ${publishedAbsence[2]} schedule.`;
  if (/matching verified offering|named future course needs/i.test(message)) {
    return "Schedule not yet published.";
  }
  if (/projected only in MAY|cannot be projected in May/i.test(message)) {
    return `Not confirmed for ${studentTermLabel(item.label).split(" ").at(-1) || "this term"}.`;
  }
  if (/exceeds? (?:the )?(?:total |Economics )?course limit|exceeds? (?:the )?(?:published )?term limit|exceeds? (?:the )?term capacity/i.test(message)) {
    return "Term full. Move a course out first.";
  }
  if (/at most one Economics elective may be planned/i.test(message)) {
    return "Move the elective already here first.";
  }
  const absent = message.match(/not listed in its complete (Fall|Winter|May) (\d{4}) schedule scope/i);
  if (absent) return `This class isn’t listed in the published ${absent[1]} ${absent[2]} schedule.`;
  if (item.status === "CONDITIONAL" && /exact schedule has not been published/i.test(message)) {
    return "This placement depends on the future schedule. Check it when the college publishes it.";
  }
  const prerequisites = message.match(/missing prerequisites?:\s*([^.]+)/i);
  if (prerequisites) return `Take ${prerequisites[1].replace(/\s+\/\s+/g, " or ")} before this class.`;
  if (/prerequisite/i.test(message)) return "A required earlier class must come first.";
  if (/conflict/i.test(message)) return "A class-time conflict prevents this move.";
  if (/advisor|review|required evidence/i.test(message) || item.status === "REVIEW_REQUIRED") {
    return "An advisor needs to check this move.";
  }
  if (/not allowed|not eligible/i.test(message)) return "This class can’t be placed in that term.";
  if (/requirement|allocation/i.test(message)) return "This move would leave a major requirement without a class.";
  if (item.status === "CONDITIONAL") return message;
  return "This move needs an advisor’s review.";
}

export function studentFriendlyCourseMarker(marker) {
  return ({
    "Approval required": "Approval needed",
    "Confirm senior standing": "Ask an advisor to confirm senior standing",
    "Eligibility review required": "Ask an advisor whether this class counts",
    "Enrollment review required": "Check this class’s enrollment status"
  })[marker] || marker;
}


export function studentFriendlyMoveCondition(item = {}, movingCourse) {
  const approvals = item.requiredApprovals || [];
  if (approvals.length) return [...new Set(approvals.map(approval => {
    const counterpart = approval.prerequisite === movingCourse ? approval.course : approval.prerequisite;
    const authority = approval.type === "instructor" ? "instructor" : approval.authority || "advisor";
    return `${counterpart ? `Same term as ${counterpart} — ` : ""}${authority} permission needed.`;
  }))].join(" ");
  if (item.status === "CONDITIONAL" && /exact schedule has not been published|future schedule is unpublished|future offering|projected placement/i.test(item.message || "")) {
    return "Schedule not yet published.";
  }
  return studentFriendlyUnavailableReason(item);
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
      "Taking $1 and $2 in the same term needs permission from the $3 instructor.")
    .replace(/([A-Z]+ \d+) is missing prerequisites?:\s*([^.]+)\./g,
      (_, course, prerequisites) => `${course} needs ${prerequisites.replace(/\s+\/\s+/g, " or ")} first. Keep the required course earlier, or move ${course} to a later term and check again.`)
    .replace(/\bmodeled units\b/g, "planned course units")
    .trim();
}

export function studentFriendlyMoveNextStep(item = {}) {
  const message = String(item.message || "");
  // Making room cannot resolve an offering restriction. Do not suggest it as
  // a way around an unpublished or prohibited offering.
  if (item.ruleId || /not listed|no verified|cannot be projected|projected only|not eligible|matching verified offering/i.test(message)) return "";
  if (/exceeds? (?:the )?(?:total |Economics )?course limit|exceeds? (?:the )?(?:published )?term limit|exceeds? (?:the )?term capacity/i.test(message)) {
    return "Move a course out of this term to make room, then try again. The other course checks still need to pass.";
  }
  if (/at most one Economics elective may be planned/i.test(message)) {
    return "Move the Economics elective already in this term elsewhere, then try again.";
  }
  return "";
}
