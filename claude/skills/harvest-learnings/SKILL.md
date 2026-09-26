---
name: harvest-learnings
description: Promote a project's transferable lessons (memories, notes, transcripts) into the global CLAUDE.md, skills, and hooks in agent-configs, then trim the project memories they replace.
disable-model-invocation: true
---

# Harvest learnings

Move what one project taught into the global layer so the next project starts
with it. Every lesson lands in exactly one home; nothing is copied twice.

## 1. Gather

Read, in this order (cheapest, most distilled first):

1. Project memory: `~/.claude/projects/<slug>/memory/*.md`, where `<slug>` is
   the project path with `/` replaced by `-`.
2. The project's `AGENTS.md` / `CLAUDE.md`.
3. The project's notes repo, if any (dated plans, run write-ups, reviews,
   follow-ups). Delegate this to an Explore agent: "return at most 25
   lessons that transfer to an unrelated project, each as rule | evidence
   with file + date | suggested home".
4. The user's own corrections from transcripts:
   `scripts/user-corrections.sh ~/.claude/projects/<slug> 220` (run via
   `rtk proxy` so RTK doesn't summarise it). Read every line; most are task
   requests, the few worth keeping are "why didn't you…" and "I want…"
   preferences not already in memory.
5. What is already global: `~/code/agent-configs/claude/CLAUDE.md`, the
   skill list in `claude/skills/`, and hooks in `claude/settings.json`.

Done when each source has been read and you hold a flat list of candidate
lessons, each with its evidence.

## 2. Classify

Give each candidate exactly one home:

| Home | When |
|---|---|
| Global `CLAUDE.md` | Applies in every session and fits in one or two lines |
| Existing global skill | Extends a procedure a skill already owns (`pre-pr-review`, `agent-brief`, `live-validation`, `project-bootstrap`, ...) |
| New global skill | A distinct procedure with its own trigger; model-invoked only if the agent must reach it unprompted |
| Hook | Must never be broken and a command's shape can detect the violation |
| Stays in project | Names this project's hosts, flags, files, decisions, or goals |
| Delete | Stale, done, or already covered globally |

Done when every candidate has a home and none has two.

## 3. Write

In a worktree branch of `~/code/agent-configs`:

- Load `mattpocock-skills:writing-for-agents` first.
- `CLAUDE.md` stays lean: add a bullet, move a paragraph into a skill. Check
  its byte size before and after; growth needs a reason.
- New skills go in `claude/skills/<name>/` and in `CLAUDE_ONLY_SKILLS` in
  `install.sh`; new hooks go in `claude/hooks/`, `install.sh`, and
  `claude/settings.json`. Update the README structure listing.
- Keep each lesson's evidence (PR number, date, what broke) in a short "Why"
  section; the rule without the incident gets ignored.

## 4. Verify and ship

- `bash -n install.sh`; `python3 -m json.tool claude/settings.json`.
- Exercise each new or changed hook with inputs it must block and inputs it
  must allow.
- Commit with `-F <file>`, push, open a PR. After the user merges:
  `./install.sh`.

## 5. Trim

After install, delete each project memory now covered globally and its line
in that project's `MEMORY.md`. Keep project-specific ones. Report the before
and after counts.

Done when the PR is merged and installed, and the project memory holds only
project-specific facts.
