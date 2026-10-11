---
name: jury
description: "Put a question or decision to a jury of 3 or 5 subagents: blind independent votes, one anonymized review round, and one committed verdict with the vote, the dissent, and the first action."
argument-hint: "<question or decision> [5 for a five-seat panel]"
disable-model-invocation: true
compatibility: Requires a host that can dispatch subagents. Uses the Codex CLI for one seat when `codex` is on PATH.
license: MIT
---

# Jury

One model asked once gives one line of reasoning, and asking it to debate itself mostly makes it agree with itself. A jury gets independence from separate subagents that vote blind, and it gets correction from one review round where every vote change must name its reason. You are the foreman: you frame, dispatch, check facts, and deliver one verdict. There is always a verdict.

## Step 1: Gate

The question is the arguments. A trailing `5` sets the panel size and is not part of the question. If the question is empty, take the decision under discussion in this conversation, and if there is none, ask for it.

Stop before any dispatch when:

- The question has one checkable answer (what a function returns, what a doc says). Answer it and say that no jury was needed.
- This host cannot dispatch subagents. Say so and stop. Never play the jurors yourself in one context: a juror that has read the other answers is not independent.

## Step 2: Brief

Read what the question needs once: the code, docs, links, and conversation it points at. Then write the **brief**, the only thing every juror sees:

- **Question**: one sentence.
- **Options**: two to four, with neutral labels (A, B, C, or short plain names). A juror may also answer "none", with a better framing.
- **Criteria**: two to four things a good answer must do well.
- **Facts**: each with its source (`path:line`, URL, or "user said").
- **Constraints**: budget, deadline, what cannot change.

Leave your own leaning out of the brief, and leave out any option label that judges ("the safe option"). Ask the user one question only if you cannot name the options. Show the brief, then continue without waiting.

## Step 3: Seat the panel

Seat three jurors, or five when the arguments end in `5`. Each seat gets one **lens**, in table order. A lens tells the juror where to look. It does not pick the juror's side, so every vote is free.

| # | Lens | Question the lens asks |
|---|------|------------------------|
| 1 | Pre-mortem | It is a year later and this choice failed. What caused it? |
| 2 | First principles | Set aside how it is usually done. What does the problem itself require? |
| 3 | Cost | What does each option cost to build, to run, and to undo? |
| 4 | Outsider | What does someone with no history in this choice see? |
| 5 | Evidence | Which facts in the brief carry the decision, and how solid is each? |

This host is Codex when any of `CODEX_SANDBOX`, `CODEX_SESSION_ID`, or `CODEX_THREAD_ID` is set. When it is not, run `command -v codex`. If it prints a path, the last seat is a **Codex seat**: it runs on a different model family, and different families catch different mistakes. Otherwise every seat is a subagent of this host.

## Step 4: Blind vote

Before each round, check the host's worker limit and occupied slots. Dispatch only seats that fit, queue the rest, and start them as workers finish. If capacity is unknown, use one worker at a time. A capacity rejection leaves the seat queued; it consumes no retry and is never a reason to drop it. Every seat gets the original blind inputs, without earlier seats' answers from that round.

A host seat is a fresh subagent, never a fork of this conversation, that gets only the juror prompt. The Codex seat is a Bash call with a 600000 ms timeout, dispatched alongside the host seats that fit. Make its directory first with `mktemp -d`:

```bash
codex exec --ignore-user-config --disable apps --disable plugins -s read-only -c 'approval_policy="never"' --ephemeral --skip-git-repo-check -C <project root> -o <temp dir>/vote.md - > <temp dir>/codex.log 2>&1 <<'EOF'
<juror prompt>
EOF
```

The flags keep the seat read-only, with no MCP servers, plugins, or approval escalation, so it cannot write through the user's own config. Read its answer from `vote.md`, never from the command output. If the command exits non-zero or the file is empty, read the reason from `tail -5 <temp dir>/codex.log`, dispatch a host subagent with the same lens, and record the swap and its reason for the Panel line.

The juror prompt:

```text
You are one juror on a panel of <N>. The other jurors answer the same brief on their own, and you will not see their answers. Do not ask the user anything and do not change any file. You may read files and run read-only commands to check the facts in the brief.

Your lens: <lens>: <question the lens asks>. Use it to decide where to look. It does not decide your vote: vote for the option the evidence supports.

<brief>

Return only this block:
CHOICE: <one option label, or "none: <a better framing>">
CONFIDENCE: <0-100>
REASONS: <at most 3, each with the fact or path:line it rests on>
WOULD CHANGE MY MIND: <the one finding that would flip your choice>
RISKIEST ASSUMPTION: <the assumption your choice depends on most>
```

Seats may return one at a time as background notifications. Wait for every seat without writing a message for each arrival, and treat a completion notice for a seat you already have as nothing to answer. Retry a seat that fails or returns no `CHOICE` once, then drop it and note the drop. Tally the choices. This is the **blind vote**.

If the blind vote is unanimous and every confidence is 70 or higher, go to Step 6.

## Step 5: Review

Run one review round, never more. More rounds make jurors agree with each other, and they do not make the answer more correct.

1. **Check facts.** Find the factual claims the jurors disagree on that could change the vote. Check each against its source yourself, and mark it verified, contradicted, or unverifiable.
2. **Anonymize.** Remove the lens names from the juror blocks. Label them Position A, B, C, and give each reviewer its own shuffled order.
3. **Dispatch fresh reviewers**, one per seat, never forks, using Step 4's capacity checks and queue. Every reviewer gets the same brief, fact checks, and anonymized positions, without earlier reviewers' answers. The Codex seat reviews through `codex exec` with `-o <temp dir>/review.md` and the same log redirect, unless it failed in Step 4. If that call fails, queue a host reviewer and record the swap. A fresh reviewer wrote none of the positions, so it has no answer of its own to protect.

The reviewer prompt:

```text
You are one reviewer on a panel of <N>. Below are anonymous positions on the same brief, in random order. Do not ask the user anything and do not change any file.

<brief>

Fact checks by the foreman:
<claim>: <verified | contradicted | unverifiable>, <source>

<Position A: juror block>
<Position B: juror block>
...

Return only this block:
REVIEW: <for each position, its strongest point and its weakest point>
EVERYONE MISSED: <what no position considered>
CHOICE: <one option label, or "none: <a better framing>">
CONFIDENCE: <0-100>
CHANGED FROM MAJORITY BECAUSE: <if your choice differs from the most common choice above, the argument or checked fact that decided it; otherwise "none">
```

Tally the choices. This is the **review vote**.

## Step 6: Verdict

The review vote decides, or the blind vote when Step 5 was skipped. The blind vote stands instead when the review majority differs from it and no reviewer names the argument or fact behind the change: a change with no reason is agreement, not evidence.

You may overrule the majority only with a checked fact that defeats its main reason. Say so in the verdict. On a tie, pick the option whose main reason survived the fact checks. If that still ties, pick the option that is cheaper to undo.

Confidence:

- **HIGH**: all seats, or four of five, chose it, and the reasons in Why are verified or rest on files you read.
- **MEDIUM**: a majority chose it.
- **LOW**: you broke a tie, you overruled the majority, or the main reason is unverifiable.

A "none" verdict is valid: give the better framing as the verdict and the first action under it.

## Step 7: Report

Output only this block. The brief was already shown in Step 2. Show the juror blocks and reviews only if the user asks for them.

```markdown
## Verdict: <option, or "Reframe: <better framing>">

Confidence: <HIGH | MEDIUM | LOW>
Vote: blind <A 2, B 1>, review <A 3>. <what changed a vote and why, or "no change">

Why:
1. <reason, with its source>

Dissent: <the strongest case for the option that lost, in its best form>
Everyone missed: <from the reviews, or "review skipped: unanimous blind vote">
Riskiest assumption: <assumption>. Test: <the cheapest check>. If it fails: <the option the verdict flips to>.
First action: <one concrete step>

Panel: <N> seats (<seats per model family>), lenses <list>. <drops or swaps>
```

When every seat ran on one model family, end the Panel line with: "One model family, so the seats can share a blind spot." When the user comes back with the result of the Test, run the jury again from Step 2 with that result as a fact.
