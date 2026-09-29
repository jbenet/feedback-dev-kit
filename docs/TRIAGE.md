# Triage: how dev agents work the feedback queue

How feedback turns into fixes when coding agents do most of the work in the background, as Capital OS
has run it since September 2026 (114 issues filed in the first four days, 97 of them closed with a
"Done" note), and the policy it settled on. Adapt the roles to your team; keep the shape.

Contents:

1. [The loop](#1-the-loop)
2. [Four classes](#2-four-classes)
3. [Roles → outcomes](#3-roles--outcomes)
4. [Classifying: evidence, not memory](#4-classifying-evidence-not-memory)
5. [Statuses, and "mark fixed issues done"](#5-statuses-and-mark-fixed-issues-done)
6. [Prioritising the queue](#6-prioritising-the-queue)
7. [The feedback-fixer pattern](#7-the-feedback-fixer-pattern)
8. [Wiring it up](#8-wiring-it-up)
9. [Confidentiality](#9-confidentiality)

---

## 1. The loop

```
report filed ─▶ triage (class, evidence, why) ─▶ A: fix now ─────────────────▶ verify ─▶ done + closing note
                                              ├▶ B: record as evidence ───────────────▶ done
                                              ├▶ C: ask the owner, quote the decision ──▶ owner answers ─▶ A or D
                                              └▶ D: spec ("Done when …") ─▶ owner approves ─▶ build ─▶ done
```

- **A trigger** starts triage: a new issue file (the ingester can kick it), or a heartbeat every 10–15
  minutes. A P0 (the app is down, data wrong on screen, a confidentiality leak) triggers it at once
  and notifies a person.
- **One integrating agent** owns triage and merging. Fixes run in parallel in isolated worktrees
  ([§7](#7-the-feedback-fixer-pattern)).
- **Every closed issue says what was done** in a closing note at the end of the body, with the version
  or commit: `**Done (N30).** The list filters by status, priority and kind in the browser…`, or
  `fixed_in: <commit>` in the frontmatter. The issues page links it.

Latency targets Capital OS set (GUESSES to measure): report to triaged within 15 minutes; a class-A fix
running on the owner's instance within the hour; live for the team at the next release.

## 2. Four classes

Three were planned; the real issues showed a fourth, data corrections.

| Class | Test | Examples |
|---|---|---|
| **A. No-brainer** | Broken against its own spec, or copy, small UX (order, alignment, show or hide, scroll, a default), or performance. No change to what a record means. No new page. | a capture drawn 8 px off; a draft losing its pictures; a button under the fold on iPad; a slow page |
| **B. Data correction** | A first-person fact about a record: "I know them", "is on our team", "these are duplicates", "wrong type". Evidence, not code. | "these two customers are the same" |
| **C. Contradiction** | Reverses or conflicts with a recorded decision: design boards, the project's invariants, a dated decision by the owner, an earlier triage or closing note. | a request to change a default the owner chose; a navigation order he set |
| **D. Big change** | A model (scoring, routing, confidence, identity); a new page or a redesign; data semantics (statuses, types, what counts); anything touching confidentiality, access, connectors or outward actions (sending, money); a destructive migration. | a new scoring model; a new workflow page |

The classifier is conservative:

- If both A and D are plausible, it is **D**.
- **A mechanical check on the diff overrides the text.** A fix whose diff touches migrations,
  connectors, auth or authorisation, the approval gate, or deployment configuration is class D whatever
  the issue said. Run this check in the merge gate, so a "copy fix" that grew into a model change is
  caught before it lands.
- A B item is recorded as the reporter's claim (with who and when), weighted by whatever confidence
  model the app has, and never overrides a fact the owner gave. No agent accepts its own proposal. Often
  the reporter can make the edit themselves; the reply says so.

## 3. Roles → outcomes

Who filed it decides what an agent may do without asking. Capital OS has three roles: admin, member
(a full user) and viewer; the owner is the admin who makes product decisions.

| | Owner / admin | Member | Viewer | Agent-filed (a monitor, a test) |
|---|---|---|---|---|
| **A** | Build it. | Build it. If it changes a page everyone uses, put it behind a flag for a day. | Build it. | Build it, inside that agent's own permissions. |
| **B** | Apply as a reviewed fact, "on the owner's word". | Record as the reporter's evidence. | Record as evidence, lower weight. | Evidence at the agent's confidence. |
| **C** | It is the owner's new decision: build it, and record it as superseding the old one. | **Route to the owner**, citing the conflicting decision. Tell the reporter "this conflicts with decision X; asked the owner". Do not build. | Route to the owner. | Route to the owner. |
| **D** | **Build now behind a flag; the owner reviews after.** | **Spec first.** Write a spec ending in "Done when …", the owner approves, then build. | Spec first. | Spec first. |

Always, whatever the class or role:

- **Confidentiality, access and outward actions go to the owner** for an explicit yes before anything
  is built: who can see what, any new place data goes, anything that sends, pays or publishes.
- A reporter the server could not verify is treated as a team member, not the owner.

In short: **admin feedback can be auto-built; member and viewer feedback that goes beyond a no-brainer
is specced first; confidentiality always goes to the owner.**

## 4. Classifying: evidence, not memory

Triage writes a block into the issue (the file, or a comment on GitHub):

```markdown
## Triage
class: C
reporter_verified: yes
evidence:
  - docs/decisions/2026-09-24-navigation-order.md (24 Sep 2026)
  - design/S2 navigation board
why: Moves Approvals below Calendar, which reverses the navigation order decided on 24 Sep.
```

- `evidence` lists what was checked, each with its path and date: the decision log, the project's
  invariants and "do not build" list, the agent rules, the design boards, and earlier issues on the same
  route (the context block's `route` finds them). For B, the record's current facts and their sources.
- `why` is one sentence: for C, the decision contradicted; for D, which trigger fired.
- **Keep a decision log** (`docs/decisions/`, one short file per decision: date, who, quote, source,
  scope as pages/modules/fields, supersedes). The contradiction check greps it by scope instead of
  reasoning from memory. Every owner answer to a C or D route appends one.
- **Say how much was checked.** A check that finds no matching decision says "no recorded decision found
  (21 entries, repo sources only)", not "no contradiction". Unsupported is not nonexistent.
- Any route to the owner carries the quoted decision, so the answer can be one line.

Do not trust `kind` and `priority` from the box: almost every report arrives as bug/P2. Triage sets
them.

## 5. Statuses, and "mark fixed issues done"

| Status | Meaning |
|---|---|
| `open` | Filed, not yet looked at. |
| `triaged` | Classified, with the triage block. |
| `agent-ready` | Specced (D) or clear (A) and waiting for a builder. |
| `in-progress` | A builder has it; `assignee:` and `branch:` in the frontmatter. |
| `done` | Fixed and verified, with a closing note and the version or commit. |

**Mark fixed issues done, not "review"** (the owner, Capital OS issue 0061). A `review` state
accumulated issues nobody went back to; the fix is verified before it merges, so the issue closes when
it merges. The file reader still maps a legacy `review` to `done`.

Keep states separate that are different facts: an agent reporting success, the fix merged, the fix
released to the reporter's instance. Where a deployed instance lags the development one, show the
reporter *Fixed, not yet released → In staging → Live*, true once the release contains `fixed_in`.

## 6. Prioritising the queue

- **Important and urgent first**, decided before a long unattended stretch and written down: what
  blocks people now (P0, anything on a page used daily), then what the owner filed today, then the
  rest by priority and age.
- **Batch by page.** Issues on the same route usually touch the same component; give them to one fixer.
- **Keep every slot busy** on long unattended stretches: several fixers at once, a ready queue of the
  next three, and a heartbeat (not a watch loop) that relaunches finished slots. An idle slot is a defect
  to report.
- **Measure output**: issues closed, reopen rate, time from filed to done. The issues page's velocity
  chart shows filed vs closed per day.
- Priority orders the queue; it is not a delivery date. Do not promise one.

## 7. The feedback-fixer pattern

A UI fix involves screenshots and trial and error, which bloats the context of whoever does it. So each
fix runs in a scoped sub-agent with its own everything:

1. **Isolated git worktree** on its own branch, so parallel fixers never touch each other's files.
2. **Its own demo server** on a free port from a reserved range (Capital OS: 3110–3119), seeded with
   invented data. Never the live server, never real data. A worktree's server files no feedback (only
   the live server numbers issues).
3. **Read set:** the project's rules, the issue file it was given (and nothing else confidential), the
   named route or component and its tests. Not the changelog history, not unrelated docs.
4. **Reproduce, fix, verify** in a real browser with Playwright at the viewport the issue recorded
   (`context.client.viewport`, `pixelRatio`, `touch`). Look at its own screenshots; do not send them
   back.
5. **Gate:** type check, the project's boundary checks, the property tests, all passing.
6. **Commit on its branch** (never push, never fetch), stop its server.
7. **Reply** with the root cause in two sentences, the files changed, the checks' results, and what it
   could not verify (Safari-only bugs cannot be tested in Chromium or Playwright's WebKit: say so).

The integrating agent reviews the diff, runs the mechanical D check, merges, writes the closing note,
marks the issue done, and takes the changelog screenshot.

A Claude Code agent definition (`.claude/agents/feedback-fixer.md`) for this:

```markdown
---
name: feedback-fixer
description: Fixes one UI issue from the feedback queue in an isolated git worktree with its own demo
  server, so screenshots and trial-and-error stay out of the main conversation. Spawn with isolation
  "worktree"; give it the issue file.
tools: Read, Edit, Write, Bash
model: sonnet
---
You fix one issue in <app> inside your own git worktree.

1. Read the issue file you are given, and the project's rules (AGENTS.md or its equivalent).
2. Start a demo server on a free port from 3110–3119: `PORT=3110 npm run dev`. Invented data only.
3. Reproduce the problem, fix it, and check it with Playwright at the issue's viewport. Look at your own
   screenshots; don't send them back.
4. Run the type check and the tests; all must pass.
5. Commit on your worktree's branch (never push, never fetch). Stop the dev server.

Reply with: the root cause in two sentences, the files changed, the checks' results, and anything you
couldn't verify.
```

## 8. Wiring it up

### With Claude Code

- Put the agent definition above in `.claude/agents/`. The integrating session spawns it with the Agent
  tool, `subagent_type: "feedback-fixer"`, `isolation: "worktree"`, and the issue path in the prompt.
  Several can run at once.
- Triage itself stays in the main session (it needs the decision log and the whole queue), or runs as
  a scheduled task every 15 minutes that reads new issue files, writes the triage blocks, and spawns
  fixers for class A.
- In CI, the Claude Code GitHub Action can run the same agent on an issue labelled `status:agent-ready`
  (GitHub variant), with the repository's demo setup, opening a pull request instead of committing to a
  branch.

### With any agent runner

The contract is small:

- **Input:** one issue (the file, or `GET /api/issues/:id`), the repository at the integrating branch,
  and the rule files.
- **Environment:** an isolated checkout, `npm install`, a free port, invented data, a headless browser.
  No network beyond the package registry, no production credentials.
- **Output:** a branch or a patch, plus the four-part reply. The runner never merges and never changes
  the issue's status; the integrator does, after the gate.
- **Status back:** `PATCH /api/issues/:id { status: "in-progress" }` when a fixer starts (with
  `assignee` and `branch` recorded) and `{ status: "done" }` when merged, with the closing note in the
  body. On GitHub, the labels and the close do the same.
- **Pulling from a deployed instance:** poll `GET /api/feedback/export?since=` with the bearer token and
  file each item through the local journal, so numbering keeps one authority.

## 9. Confidentiality

Issues filed from a real deployment can name people and show private data, in the text, the context and
above all the screenshots.

- Triage reads the issue **where it is**. Its content does not go into a sub-agent's prompt beyond the
  path; the fixer reads the file itself, inside the same boundary.
- A fixer copies nothing real into code, commits, tests, screenshots or its reply. It reproduces on
  invented data.
- Cloud or third-party agents get a **dev brief** at most: the class, the route template, repro steps on
  demo data, and acceptance criteria. No names, no screenshots, no record ids. Check the brief against the
  app's known names before releasing it; a brief that fails stays local.
- Closing notes and release notes say what changed in plain words and never quote a title that could
  name someone.
- Run agents only under accounts with training on inputs turned off.
