#!/bin/sh
# Tests scripts/link-skills.sh against a copy of the repository and a temporary
# HOME, and syntax-checks the shell templates the skills ship.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

sh -n "$REPO/skills/diagnosing-bugs/scripts/hitl-loop.template.sh" || fail "hitl-loop.template.sh syntax"

# Run against a copy, so a broken guard cannot write into this checkout.
mkdir "$TMP/repo" "$TMP/home"
cp -R "$REPO/scripts" "$REPO/skills" "$REPO/references" "$TMP/repo/"
COPY="$(cd "$TMP/repo" && pwd -P)"
expected="$(find "$COPY/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"

HOME="$TMP/home" bash "$COPY/scripts/link-skills.sh" >/dev/null || fail "link-skills.sh exited nonzero"

for dest in .claude/skills .agents/skills; do
  count=0
  for link in "$TMP/home/$dest"/*; do
    [ -L "$link" ] || fail "$link is not a symlink"
    [ "$(readlink "$link")" = "$COPY/skills/$(basename "$link")" ] || fail "$link points elsewhere"
    count=$((count + 1))
  done
  [ "$count" = "$expected" ] || fail "$dest has $count links, expected $expected"
done

for dest in .claude .agents; do
  link="$TMP/home/$dest/references"
  [ -L "$link" ] || fail "$link is not a symlink"
  [ "$(readlink "$link")" = "$COPY/references" ] || fail "$link points elsewhere"
  [ -r "$TMP/home/$dest/skills/tdd/../../references/scratch-dependencies.md" ] || fail "$dest skill references do not resolve"
done

HOME="$TMP/home" bash "$COPY/scripts/link-skills.sh" >/dev/null || fail "link-skills.sh is not idempotent"
for dest in .claude .agents; do
  [ "$(readlink "$TMP/home/$dest/references")" = "$COPY/references" ] || fail "$dest references changed on rerun"
  [ ! -L "$COPY/references/references" ] || fail "link-skills.sh wrote a link into references/"
done

# A destination that is a symlink into the repository must be refused.
rm -rf "$TMP/home/.claude/skills"
ln -s "$COPY/skills" "$TMP/home/.claude/skills"
if HOME="$TMP/home" bash "$COPY/scripts/link-skills.sh" >/dev/null 2>&1; then
  fail "link-skills.sh accepted a destination that points into the repository"
fi
[ -z "$(find "$COPY/skills" -mindepth 2 -maxdepth 2 -type l)" ] || fail "link-skills.sh wrote links into skills/"

echo "ok"
