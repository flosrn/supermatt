#!/bin/sh
# A stand-in for `codex exec` that never calls a model: every other command runs the real Codex
# CLI at $REAL_CODEX (the evaluator calls Codex with restricted environments, so the caller's
# launcher sets it on each call). In place of a model run it changes the fixture repository inside
# the real skill-eval sandbox (a commit a reset then drops, a merge whose resolution adds a path,
# and a core.fsmonitor that writes a file whenever Git consults it), then prints a minimal trace.
[ "$1" = exec ] || exec "$REAL_CODEX" "$@"
cwd=
while [ "$#" -gt 0 ]; do
  [ "$1" = --cd ] && cwd=$2
  shift
done
cat >/dev/null
"$REAL_CODEX" sandbox -P skill-eval -C "$cwd" /bin/sh -c '
set -e
git() { command git -c user.name=Dev -c user.email=dev@example.invalid -c commit.gpgsign=false "$@"; }
base=$(git rev-parse HEAD)
printf "dropped\n" > dropped.txt; git add dropped.txt; git commit -qm "dropped commit"
git reset -q --hard "$base"
git checkout -q -b side; printf "side\n" > side.txt; git add side.txt; git commit -qm side
git checkout -q -; printf "main\n" > main.txt; git add main.txt; git commit -qm main
git merge -q --no-commit side; printf "resolved\n" > resolution-only.txt; git add resolution-only.txt; git commit -qm "merge side"
git config core.fsmonitor "printf late > late.txt; false"
' >/dev/null 2>&1 || exit 1
printf '%s\n' '{"type":"thread.started","thread_id":"stub"}' '{"type":"turn.started"}' \
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}' \
  '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
