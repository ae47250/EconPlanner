// Seat freshness is separate from the existence of a published section.
export function availabilityIsStale(availability, referenceDate, maxAgeHours = 24) {
  if (!availability?.asOf || !referenceDate) return true;
  const checkedAt = Date.parse(availability.asOf);
  const reference = Date.parse(referenceDate);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(reference)) return true;
  return checkedAt > reference || reference - checkedAt > maxAgeHours * 60 * 60 * 1000;
}

export function seatStatusPresentation(availability, { verified = false, referenceDate } = {}) {
  if (!verified || availabilityIsStale(availability, referenceDate)) {
    return { label: "Current seat status unverified", tone: "unverified" };
  }
  const states = {
    open: { label: "OPEN", tone: "open" },
    full: { label: "FULL", tone: "full" },
    closed: { label: "CLOSED", tone: "full" },
    waitlisted: { label: "Waitlist", tone: "unverified" }
  };
  return states[availability?.status] || { label: "Current seat status unverified", tone: "unverified" };
}
