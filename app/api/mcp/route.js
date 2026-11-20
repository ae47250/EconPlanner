import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { GET as getPlannerFingerprint, POST as runPlanner } from "../majors/map/route.js";
import { registerPlannerTools } from "../../../lib/planning/mcp-tools.js";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request) {
  const secret = process.env.ECONPLANNER_MCP_STATE_KEY;
  if (!secret || !/^[a-f\d]{64}$/i.test(secret)) {
    return Response.json({ error: "The planning tools are unavailable in this deployment." }, { status: 503 });
  }

  const server = new McpServer({ name: "econplanner", version: "0.1.0" });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  registerPlannerTools(server, { runPlanner, getPlannerFingerprint, secret });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
