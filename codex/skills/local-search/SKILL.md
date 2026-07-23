---
name: local-search
description: >
  Use a local SearXNG instance instead of cloud web search for trivial,
  low-stakes factual lookups (an API signature, an error message, a CLI
  flag, a package version/changelog). Only relevant on machines running
  the ai-stack SearXNG service (port 8888) -- check it's reachable before
  using this skill. Trigger whenever you're about to reach for cloud search
  for a quick factual check rather than deep or time-sensitive research,
  and the query doesn't need full page rendering.
---

# Local Search

Route cheap lookups to the local SearXNG instance so cloud search calls
are reserved for research that actually needs them (ambiguous queries,
synthesis across many sources, anything time-sensitive enough that a
locally-cached/indexed search engine might lag).

No local model is in this loop -- the script fetches raw search results,
and you read and judge them exactly as you would cloud search output.
There's no logic-bug risk to reason about here, unlike other ai-stack
skills.

## Step 1 — run the query

```bash
~/.codex/skills/local-search/scripts/search.sh "<query>"
```

The script does its own reachability check -- do not pre-flight it with a
separate `curl`. (`AI_STACK_HOST` points at a LAN-served stack when the
instance isn't local, e.g. `192.168.1.233`; unset it defaults to localhost.)

Prints up to 8 results as `- title (url): snippet` lines. Exits non-zero
with a stderr message if SearXNG is unreachable or returns zero results. On
`not reachable`, relay that one line to the user and fall back to cloud
search; on zero results, fall back quietly (the stack was up, it just had no
hits).

## Step 2 — judge the results yourself

Treat the output like any other search result list: read titles/URLs,
follow up by fetching a specific page if you need the full content, and
don't trust a snippet over primary-source verification for anything that
matters (security advisories, exact version numbers you'll act on, API
contracts you'll code against). This skill saves a cloud call on the
*lookup*, not on the judgment of what the lookup means.

## When not to use this

- Time-sensitive news or anything where index freshness matters (SearXNG's
  upstream engines may lag cloud search).
- Research requiring synthesis across many sources or several search
  rounds -- cloud search's own iteration is better suited.
- Anything where the user is explicitly relying on cloud search quality.
