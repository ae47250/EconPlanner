import { evaluateOffering } from "../decision-engine/placement.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";
export { availabilityIsStale } from "./seat-status.js";

const DAY_ALIASES = new Map([
  ["mon", "Mon"],
  ["monday", "Mon"],
  ["tue", "Tue"],
  ["tues", "Tue"],
  ["tuesday", "Tue"],
  ["wed", "Wed"],
  ["wednesday", "Wed"],
  ["thu", "Thu"],
  ["thur", "Thu"],
  ["thurs", "Thu"],
  ["thursday", "Thu"],
  ["fri", "Fri"],
  ["friday", "Fri"]
]);

function normalizeAcademicYear(value) {
  return value ? String(value).replace("/", "-") : null;
}

function normalizeDays(value) {
  if (Array.isArray(value)) return value.map(day => DAY_ALIASES.get(String(day).toLowerCase()) || day);
  if (!value || /online/i.test(value)) return [];
  return String(value)
    .split(",")
    .map(day => DAY_ALIASES.get(day.trim().toLowerCase()) || day.trim())
    .filter(Boolean);
}

function timeToMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return hour * 60 + Number(match[2]);
}

function normalizeAvailability(rawOffering, schedule) {
  const raw = rawOffering.availability || {};
  const sourceStatus = String(raw.status || rawOffering.status || "unknown").trim().toLowerCase();
  const rawLabel = String(raw.rawStatus || rawOffering.status || "").trim().toLowerCase();
  const status = sourceStatus === "full" || rawLabel === "full"
    ? "full"
    : sourceStatus === "closed"
      ? "closed"
      : ["waitlist", "waitlisted"].includes(sourceStatus)
        ? "waitlisted"
        : sourceStatus === "open"
          ? "open"
          : "unknown";
  return {
    status,
    rawStatus: raw.rawStatus || rawOffering.status || null,
    seatsOpen: raw.seatsOpen !== null && raw.seatsOpen !== "" && Number.isFinite(Number(raw.seatsOpen))
      ? Number(raw.seatsOpen)
      : null,
    capacity: raw.capacity !== null && raw.capacity !== "" && Number.isFinite(Number(raw.capacity))
      ? Number(raw.capacity)
      : null,
    asOf: Object.hasOwn(raw, "asOf") ? raw.asOf : schedule.availabilityAsOf ?? null
  };
}

function normalizeOffering(rawOffering, term, schedule) {
  const meeting = rawOffering.meeting || {};
  const days = normalizeDays(meeting.days || rawOffering.days);
  const startTime = meeting.startTime || rawOffering.startTime || null;
  const endTime = meeting.endTime || rawOffering.endTime || null;
  return {
    ...rawOffering,
    academicYear: normalizeAcademicYear(rawOffering.academicYear || schedule.academicYear),
    term,
    course: String(rawOffering.course || "").trim().toUpperCase(),
    section: String(rawOffering.section || "").trim(),
    units: Number(rawOffering.units ?? rawOffering.credits ?? 1),
    instructor: rawOffering.instructor || rawOffering.faculty || null,
    crossListedAs: [...new Set(rawOffering.crossListedAs || [])],
    meeting: {
      days,
      startTime,
      endTime,
      startMinutes: timeToMinutes(startTime),
      endMinutes: timeToMinutes(endTime),
      delivery: rawOffering.delivery || meeting.delivery || (days.length ? "in_person" : "online_or_unspecified"),
      location: rawOffering.location || meeting.location || null,
      startDate: rawOffering.startDate || meeting.startDate || null,
      endDate: rawOffering.endDate || meeting.endDate || null
    },
    availability: normalizeAvailability(rawOffering, schedule),
    provenance: rawOffering.provenance || {
      sourceType: schedule.source?.type || "unknown",
      sourceFiles: schedule.source?.files || [],
      sourceDocumentDate: schedule.source?.sourceDocumentDate ?? null,
      screenshotRetrievedOn: schedule.source?.screenshotRetrievedOn ?? null,
      repositoryIngestedOn: schedule.source?.repositoryIngestedOn ?? null,
      humanVerifiedOn: schedule.source?.humanVerifiedOn ?? null,
      verifiedOn: schedule.verifiedOn ?? null
    },
    verificationStatus: rawOffering.verificationStatus || "unverified"
  };
}

export function normalizeEconomicsSchedule(rawSchedule) {
  if (!rawSchedule) return null;
  const terms = Object.fromEntries(Object.entries(rawSchedule.terms || {}).map(([term, offerings]) => [
    term,
    (offerings || []).map(offering => normalizeOffering(offering, term, rawSchedule))
  ]));
  return {
    ...rawSchedule,
    academicYear: normalizeAcademicYear(rawSchedule.academicYear),
    provider: {
      sourceType: rawSchedule.source?.type || "unknown",
      sourceFiles: rawSchedule.source?.files || [],
      schemaVersion: rawSchedule.schemaVersion || 1,
      sourceDocumentDate: rawSchedule.source?.sourceDocumentDate ?? null,
      screenshotRetrievedOn: rawSchedule.source?.screenshotRetrievedOn ?? null,
      repositoryIngestedOn: rawSchedule.source?.repositoryIngestedOn ?? null,
      humanVerifiedOn: rawSchedule.source?.humanVerifiedOn ?? null,
      availabilityAsOf: rawSchedule.availabilityAsOf ?? null,
      verifiedOn: rawSchedule.verifiedOn ?? null,
      lastVerifiedAt: rawSchedule.lastVerifiedAt ?? null
    },
    terms
  };
}

export function canonicalScheduleCode(schedule, code) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  for (const offering of Object.values(schedule?.terms || {}).flat()) {
    if (offering.course === normalizedCode || (offering.crossListedAs || []).includes(normalizedCode)) {
      return offering.course;
    }
  }
  return normalizedCode;
}

export function scheduleOfferings(schedule, slot, code) {
  const normalized = normalizeEconomicsSchedule(schedule);
  if (!normalized) return [];
  const scheduleYear = normalizeAcademicYear(normalized.academicYear);
  const slotYear = normalizeAcademicYear(slot?.academicYear) || scheduleYear;
  if (scheduleYear && slotYear && scheduleYear !== slotYear) return [];
  const term = slot?.scheduleTerm || slot?.termKey || slot;
  const canonicalCode = canonicalScheduleCode(normalized, code);
  return (normalized.terms?.[term] || []).filter(offering => offering.course === canonicalCode);
}

export function scheduleOfferingDecision(offering, slot, policyBundle = runtimePolicyBundle()) {
  return evaluateOffering(
    { ...offering, source: "verified-offering" },
    { ...slot, termKey: slot?.termKey || slot?.scheduleTerm },
    policyBundle.indexes.offeringByTerm,
    policyBundle
  );
}

export function meetingsConflict(left, right) {
  const leftMeeting = left?.meeting;
  const rightMeeting = right?.meeting;
  if (!leftMeeting?.days?.length || !rightMeeting?.days?.length) return false;
  if (!Number.isFinite(leftMeeting.startMinutes) || !Number.isFinite(leftMeeting.endMinutes)) return false;
  if (!Number.isFinite(rightMeeting.startMinutes) || !Number.isFinite(rightMeeting.endMinutes)) return false;
  if (!leftMeeting.days.some(day => rightMeeting.days.includes(day))) return false;
  return leftMeeting.startMinutes < rightMeeting.endMinutes
    && rightMeeting.startMinutes < leftMeeting.endMinutes;
}

function availabilityRank(offering) {
  if (offering.availability?.status === "open") return 0;
  if (offering.availability?.status === "waitlisted") return 1;
  if (offering.availability?.status === "unknown") return 2;
  if (offering.availability?.status === "full") return 3;
  return 4;
}

export function selectConflictFreeOffering(schedule, slot, code, selectedCourses = []) {
  return scheduleOfferings(schedule, slot, code)
    .filter(offering => (
      offering.verificationStatus === "verified"
      && offering.availability?.status !== "closed"
      && !selectedCourses.some(course => meetingsConflict(offering, course))
    ))
    .sort((left, right) => availabilityRank(left) - availabilityRank(right))[0] || null;
}
