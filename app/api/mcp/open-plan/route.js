import { GET as getPlannerFingerprint } from "../../majors/map/route.js";
import { validStateKey, verifyPlanningState } from "../../../../lib/planning/mcp-state.js";

export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

export async function POST(request) {
  const secret = process.env.ECONPLANNER_MCP_STATE_KEY;
  if (!validStateKey(secret)) {
    return Response.json({ error: "This plan link cannot be checked right now." }, { status: 503, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "This plan link is invalid." }, { status: 400, headers });
  }
  const { stateToken, planId } = body || {};
  if (typeof planId !== "string" || !planId || planId.length > 80) {
    return Response.json({ error: "This plan link is invalid." }, { status: 400, headers });
  }
  const verified = await verifyPlanningState(stateToken, secret, getPlannerFingerprint);
  if (verified.kind === "invalid") {
    return Response.json({ error: "This plan link is invalid or has expired." }, { status: 400, headers });
  }
  if (verified.kind !== "valid") {
    return Response.json({ error: "This plan link no longer matches the current planning policy." }, { status: 409, headers });
  }
  const { state } = verified;
  if (!state.plans.some(plan => plan.id === planId)) {
    return Response.json({ error: "This plan link does not name a saved plan." }, { status: 400, headers });
  }
  return Response.json({ student: state.student, plans: state.plans, planId, plannerFingerprint: state.fingerprint }, { headers });
}
