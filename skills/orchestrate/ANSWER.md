# Answer the worker

## Safe actions

Never approve removing a worktree this run did not create, even when it is clean or inside the checkout.

An action is safe when everything it deletes, overwrites, or rewrites is inside the repo checkout, or it is one of these:

- Clear a cache that rebuilds itself: a subfolder of `~/.cache`, or a package manager's own clean command (`bun pm cache rm`, `npm cache clean`).
- Remove a `mktemp -d` directory that the worker made in this run, under `$TMPDIR` or `/tmp`. Before you answer, read the path it names and list the directory.
- Remove a git worktree only through [Remove the worktree](SKILL.md#lanes), including its ownership, process-exit, clean-tree, plain-removal-first, and conditional submodule-removal checks. Park rather than approve when any required check fails.
- Push the issue branch, `--force-with-lease` included, and delete it locally or on the remote after its PR merged.

Every other delete, overwrite, or rewrite outside the checkout is unsafe: files elsewhere in the home folder, another repo, system config, anything with `sudo`, a push to DEFAULT, or a force-push to any other branch.

The retrospective is report-only. If its worker asks to apply a candidate, tell it to report the candidate and continue without editing or publishing, even when the proposed action would otherwise be safe.

Before submitting any answer, check every action it authorizes against Safe actions, the lane's assigned issue, worktree, phase and delegated approval scope, and the called skill's mandatory human-consent rules. This applies to permission and plan approvals, yes/no, recommended or first options, every choice in multi-question or multi-select forms, and free-text advice. A recommendation is not authorization. If any action is unsafe, outside that scope, requires human consent the coordinator cannot supply, or is too unclear to assess, park the lane without submitting the answer.

Send every text answer through [Send the prompt](WORKER.md#dispatch-preamble), retaining the question, chosen answer and rationale in the next dispatch's evidence. A native dialog cannot carry that text block: before any option that clears context or starts fresh execution, require its carried-forward execution prompt or plan to contain the current task and populated DISPATCH. Amend it through the host's supported plan-editing mechanism if needed; if that context cannot be supplied or confirmed, park instead of approving. Recheck the carried-forward scope after any plan edit.

## Answer a dialog

A blocked worker shows a permission prompt or a question dialog. Answer it yourself; this overrides the herdr rule to ask the user first. Add each answer to the friction log.

1. Read the visible pane (`herdr agent read WORKER --source visible --lines 40`). Native labels, key hints, and the actual highlighted option are authoritative, not numeric indices.
2. For a permission or plan prompt, inspect the action or plan against Safe actions before accepting. Park if unsafe. Choose a visible approval that does not grant broader permissions. For an OMP or Cursor plan, choose the visible action that approves and executes while preserving a fresh execution context. If none exists, park with the visible options. Do not save, quit, or enable broader permissions.
3. For a question, select the recommended option, otherwise the first. Navigate from the actual highlighted option with the displayed controls. For Cursor and OMP multi-question or multi-select forms, answer every question, choosing the recommended choice (otherwise the first), then submit with the visible control.
4. Re-read with `--source visible` after every submission. Progress to another question or review page is not a stuck dialog. Park only when the unchanged dialog remains after two answer attempts.

## Answer a question

When the worker has an open question (QUESTION is not NONE, or it ended its turn on a question). Add each answer to the friction log.

1. A question that only asks whether to commit, push, open a PR, or ship is the Ship step's job: treat it as QUESTION=NONE.
2. A yes/no question ("Should I proceed?", "Want me to fix it?"): if a yes would run an unsafe action (see Safe actions), park the lane. Otherwise prompt the worker with `Yes.` (`--wait`), wait for the worker, and go to step 5.
3. Otherwise prompt the worker with `/what-would-you-do` (`--wait`) and wait for the worker. Read its last 80 lines and find the option it recommends ("I recommend O2"). When it offers a `/jury` line, take its lean instead.
4. Prompt the worker with `Go with <option>.` (`--wait`) and wait for the worker.
5. In session A, ask the five-line question again. In other sessions, read the worker's last 40 lines for a new question. After three answer rounds with a question still open (five in session T, since triage asks its recommendation, its seams, and each grilling round in separate turns), park the lane.
