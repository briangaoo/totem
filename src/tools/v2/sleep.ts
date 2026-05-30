import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SleepOut } from "../../schemas/sleep.js";
import { projectSleep } from "../../projections/sleep.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerSleep(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_sleep",
    "Last night's sleep deep-dive: all 4 stages (REM/light/SWS/wake) with durations + percentages, the full hypnogram (per-stage timeline), efficiency, performance, consistency, disturbances, and in-sleep heart rate (avg/min). (sleep HRV, respiratory rate, debt + latency aren't exposed by this endpoint and return null.)",
    { date: z.iso.date().optional() },
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get("/home-service/v1/deep-dive/sleep/last-night", { date: d });
      const projected = projectSleep(raw, d);
      try {
        const out = SleepOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_sleep", e);
        throw e;
      }
    },
  );
}
