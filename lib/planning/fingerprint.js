import { loadPolicyBundle } from "../policy/load-bundle.js";
import { canonicalSha256 } from "../policy/canonical-json.js";
import { loadCatalogPolicyReleases, loadPlanningFlexibilityPolicy } from "../catalog/policy-releases.js";
import academicCalendar from "../../data/normalized/academic-calendars.json" with { type: "json" };

// Exact/preliminary schedules are covered by the main bundle's content hash.
// Include the separately compiled catalog/flexibility policy and calendar too.
export async function loadPlannerFingerprint(policyBundle = null) {
  const bundle = policyBundle || await loadPolicyBundle();
  return `sha256:${canonicalSha256({
    policyAndSchedule: bundle.contentHash,
    catalogs: loadCatalogPolicyReleases().releases.map(release => release.contentHash),
    flexibility: loadPlanningFlexibilityPolicy().contentHash,
    academicCalendar
  })}`;
}
