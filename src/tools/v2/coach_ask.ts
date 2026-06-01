import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CoachAskOut } from "../../schemas/coach.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { randomInt } from "node:crypto";

export function registerCoachAsk(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_coach_ask",
    "WRITE (creates a coach conversation): ask Whoop Coach a question and poll up to 30s for the reply. context tells the coach which screen you're asking about — one of HOME, RECOVERY, STRAIN, SLEEP, STRESS, CARDIO_DETAILS, WAKE_UP_REPORT (default HOME). Preview unless confirm:true.",
    {
      message: z.string(),
      context: z
        .enum(["HOME", "RECOVERY", "STRAIN", "SLEEP", "STRESS", "CARDIO_DETAILS", "WAKE_UP_REPORT"])
        .default("HOME"),
      confirm: z.boolean().default(false).describe("Set true to actually send. Default returns a preview."),
    },
    async ({ message, context, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", "/ai-conversation-bff/v1/conversation + /turn", {
                  message: message.slice(0, 100),
                  context,
                }),
              ),
            },
          ],
        };
      }
      // Conversation creation response: { metadata: { id, ... }, turns: [...], tag }
      const conv = await client.post<{
        metadata?: { id?: string };
        conversation_id?: string;
        id?: string;
      }>("/ai-conversation-bff/v1/conversation", {
        context,
        fingerprint: `CHAT_WITH_AGENT${context}_${new Date().toISOString().slice(0, 10)}`,
        source_type: "CHAT_WITH_AGENT",
        chat_entrypoint_experience: "STANDARD",
        tracking_capabilities: {
          is_dismiss_tracking_enabled: false,
          is_seen_tracking_enabled: true,
        },
      });
      const conversationId = conv.metadata?.id ?? conv.conversation_id ?? conv.id ?? "";

      // Turn response: { id, turn_status, messages, turn_number, feedback }
      const turn = await client.post<{ id?: string; turn_id?: string }>(
        `/ai-conversation-bff/v1/conversation/${conversationId}/turn`,
        {
          role: "user",
          content: message,
          is_suggestion: false,
          tracking_capabilities: {
            is_dismiss_tracking_enabled: false,
            is_seen_tracking_enabled: true,
          },
        },
      );
      const turnId = turn.id ?? turn.turn_id ?? "";

      // Response text lives at messages[].items[].content.text (BFF rich-content
      // shape); fall back to messages[].content for older shapes. Only the
      // ASSISTANT's reply counts — the turn echoes the user's message first, so
      // breaking on "any message present" returns before the coach has answered.
      function extractText(msgs: unknown[]): string | null {
        for (const m of msgs) {
          if (typeof m !== "object" || m === null) continue;
          const msg = m as Record<string, unknown>;
          if (msg.role && msg.role !== "assistant") continue;
          if (typeof msg.content === "string") return msg.content;
          if (Array.isArray(msg.items)) {
            for (const item of msg.items) {
              if (typeof item !== "object" || item === null) continue;
              const it = item as Record<string, unknown>;
              const itemContent = it.content;
              if (typeof itemContent === "object" && itemContent !== null) {
                const t = (itemContent as Record<string, unknown>).text;
                if (typeof t === "string") return t;
              }
            }
          }
        }
        return null;
      }

      // The assistant reply streams token-by-token, so the FIRST non-empty read
      // is almost always a partial chunk (e.g. just "56"). Breaking on first text
      // returns a truncated answer. Instead keep the latest text each poll and
      // stop only once the turn is terminal (server says it's done) or the text
      // has stopped growing for two polls (the stream has settled). The 30s cap
      // is the backstop.
      const TERMINAL = ["COMPLETE", "COMPLETED", "DONE", "FINISHED"];
      let polled = 0;
      let status = "PENDING";
      let responseText: string | null = null;
      let stableFor = 0;
      for (; polled < 30; polled++) {
        // Jittered, not a fixed 1.000s metronome — a perfectly periodic poll is
        // a scripted-client tell. ~0.85–1.4s keeps the 30s budget intact.
        await new Promise((r) => setTimeout(r, randomInt(850, 1400)));
        const r = await client.get<Record<string, unknown>>(
          `/ai-conversation-bff/v1/conversation/${conversationId}/turn/${turnId}`,
        );
        status = typeof r.turn_status === "string" ? r.turn_status.toUpperCase() : status;
        const latest = extractText(Array.isArray(r.messages) ? r.messages : []);
        if (latest !== null) {
          stableFor = latest === responseText ? stableFor + 1 : 0;
          responseText = latest;
        }
        if (TERMINAL.includes(status)) break; // server marked the turn done
        if (responseText !== null && stableFor >= 2) break; // stream settled
      }
      const out = CoachAskOut.parse({
        conversation_id: conversationId,
        turn_id: turnId,
        response_text: responseText,
        turn_status: status,
        polled_iterations: polled,
        timed_out: polled === 30,
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
