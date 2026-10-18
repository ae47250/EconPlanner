export function studentFriendlyUnavailableReason(item = {}) {
  const message = String(item.message || "");
  if (item.status === "ALLOWED") return "This change passes the plan checks.";
  const publishedAbsence = message.match(/no verified, conflict-free section in (Fall|Winter|Spring\/May|May) (\d{4})/i);
  if (publishedAbsence) return `No conflict-free section is available in the published ${publishedAbsence[1]} ${publishedAbsence[2]} schedule.`;
  if (/matching verified offering|named future course needs/i.test(message)) {
    return "The future schedule isn’t published yet, so we can’t confirm this class there.";
  }
  if (/exceeds? (?:the )?(?:total |Economics )?course limit|exceeds? (?:the )?(?:published )?term limit|exceeds? (?:the )?term capacity/i.test(message)) {
    return "This term is already at its course limit.";
  }
  if (/at most one Economics elective may be planned/i.test(message)) {
    return "Only one future Economics elective can be planned per term.";
  }
  const absent = message.match(/not listed in its complete (Fall|Winter|May) (\d{4}) schedule scope/i);
  if (absent) return `This class isn’t listed in the published ${absent[1]} ${absent[2]} schedule.`;
  if (/projected only in MAY|cannot be projected in May/i.test(message)) {
    return "We need a published schedule showing this class in that term before you can move it there.";
  }
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
  return "This move doesn’t fit the plan. Open the details to see why.";
}

export function studentFriendlyCourseMarker(marker) {
  return ({
    "Approval required": "Advisor approval needed",
    "Confirm senior standing": "Ask an advisor to confirm senior standing",
    "Eligibility review required": "Ask an advisor whether this class counts",
    "Enrollment review required": "Check this class’s enrollment status"
  })[marker] || marker;
}
