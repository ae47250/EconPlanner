import { createMcpHandler } from "mcp-handler";
import { checkRateLimit } from "@vercel/firewall";
import { GET as getPlannerFingerprint, POST as runPlanner } from "../majors/map/route.js";
import { registerPlannerTools } from "../../../lib/planning/mcp-tools.js";
import { publicSiteOrigin, validStateKey } from "../../../lib/planning/mcp-state.js";

export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(request) {
  const secret = process.env.ECONPLANNER_MCP_STATE_KEY;
  if (!validStateKey(secret) || !publicSiteOrigin()) {
    return Response.json({ error: "The planning tools are unavailable in this deployment." }, { status: 503 });
  }

  try {
    const { rateLimited, error } = await checkRateLimit("econplanner-mcp", { request, timeout: 3000 });
    if (rateLimited) return Response.json({ error: "Too many planning requests. Try again shortly." }, { status: 429 });
    if (error) return Response.json({ error: "The planning tools are temporarily unavailable." }, { status: 503 });
  } catch {
    return Response.json({ error: "The planning tools are temporarily unavailable." }, { status: 503 });
  }

  const handler = createMcpHandler(server => {
    registerPlannerTools(server, { runPlanner, getPlannerFingerprint, secret });
  }, { serverInfo: { name: "econplanner", version: "0.1.0" } });
  return handler(request);
}

export { handle as GET, handle as POST };
