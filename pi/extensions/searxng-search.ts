import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Pi ships no web search tool at all. The published option (`pi-web-access`)
// wants a cloud API key for Brave/Tavily/Exa/etc., which this machine has no
// reason to buy: ai-stack already serves SearXNG on :8888.
//
// Registered as a tool rather than left to the `local-search` skill because a
// 27B model reliably calls a tool that is in front of it, and unreliably
// remembers to shell out to a script a skill described. Same backend, higher
// hit rate.
//
// Fails soft with a message the model can act on -- an unreachable SearXNG
// should read as "search is unavailable, proceed without it", never as a
// crashed turn.
const MAX_RESULTS = 8;

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
}

export default function (pi: ExtensionAPI) {
  const host = process.env.AI_STACK_HOST || "127.0.0.1";
  const baseUrl = `http://${host}:8888`;

  pi.registerTool({
    name: "web_search",
    label: "web search",
    description:
      "Search the web via a local SearXNG instance. Returns up to 8 results as title, URL, and snippet. " +
      "Use for factual lookups: API signatures, error messages, CLI flags, package versions. " +
      "Snippets are summaries, not primary sources -- read the URL before acting on anything that matters.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),

    async execute(_toolCallId, params, signal) {
      const url = `${baseUrl}/search?q=${encodeURIComponent(params.query)}&format=json`;

      let payload: { results?: SearxResult[] };
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          return {
            content: [{ type: "text", text: `SearXNG returned HTTP ${response.status}. Continue without web results.` }],
            details: { error: true },
          };
        }
        payload = await response.json();
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text:
                `SearXNG at ${baseUrl} is not reachable (${error.message}). ` +
                `Continue without web results, and say so rather than guessing an answer.`,
            },
          ],
          details: { error: true },
        };
      }

      const results = (payload.results ?? []).slice(0, MAX_RESULTS);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results for "${params.query}".` }],
          details: { count: 0 },
        };
      }

      const text = results
        .map((r) => `- ${r.title ?? "(untitled)"} (${r.url ?? "no url"}): ${(r.content ?? "").trim()}`)
        .join("\n");

      return {
        content: [{ type: "text", text }],
        details: { count: results.length },
      };
    },
  });
}
