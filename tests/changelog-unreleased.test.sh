#!/bin/sh
# Tests scripts/check-changelog-unreleased.sh against a temporary repository and its origin.
set -eu
# A hook in a linked worktree exports an absolute GIT_DIR, which would aim every git command below at the real repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

assert_pass() {
  status=0
  sh scripts/check-changelog-unreleased.sh "$@" > "$TMP/stdout" 2> "$TMP/stderr" || status=$?
  [ "$status" -eq 0 ] || fail "$*: expected success, got $status: $(cat "$TMP/stderr")"
  [ ! -s "$TMP/stdout" ] || fail "$*: unexpected stdout"
  [ ! -s "$TMP/stderr" ] || fail "$*: unexpected stderr"
}

assert_rejected() {
  expected_line=$1
  expected_heading=$2
  shift 2
  status=0
  sh scripts/check-changelog-unreleased.sh "$@" > "$TMP/stdout" 2> "$TMP/stderr" || status=$?
  [ "$status" -eq 1 ] || fail "$*: expected rejection, got $status"
  [ ! -s "$TMP/stdout" ] || fail "$*: unexpected stdout"
  error=$(cat "$TMP/stderr")
  case $error in *"CHANGELOG.md:$expected_line:"*) ;; *) fail "wrong new-side line: $error" ;; esac
  case $error in *"$expected_heading"*) ;; *) fail "missing released heading: $error" ;; esac
  case $error in
    *"ordinary changes go under ## [Unreleased]; only a release PR that bumps version in .claude-plugin/plugin.json edits released sections (AGENTS.md)"*) ;;
    *) fail "missing remediation: $error" ;;
  esac
}

assert_boundary_rejected() {
  expected_location=$1
  diagnostic_kind=$2
  shift 2
  assert_rejected "$expected_location" '## [1.2.0]' "$@"
  case $diagnostic_kind:$error in
    mixed:*'changed hunk spans Unreleased and released content;'*) ;;
    mixed:*) fail "missing mixed-hunk diagnostic: $error" ;;
    *'changed hunk spans Unreleased and released content;'*) fail "unexpected mixed-hunk diagnostic: $error" ;;
  esac
}

assert_usage() {
  status=0
  sh scripts/check-changelog-unreleased.sh "$@" > "$TMP/stdout" 2> "$TMP/stderr" || status=$?
  [ "$status" -eq 2 ] || fail "$*: expected usage status 2, got $status"
  [ ! -s "$TMP/stdout" ] || fail "$*: unexpected stdout"
  case $(cat "$TMP/stderr") in *Usage:*) ;; *) fail "$*: missing usage" ;; esac
}

start_case() {
  git reset -q --hard
  git checkout -q -B "$1" "$BASE"
}

edit_unreleased() {
  sed 's/- next\./- next, with a note./' CHANGELOG.md > "$TMP/changelog"
  cp "$TMP/changelog" CHANGELOG.md
  git add CHANGELOG.md
}

edit_released() {
  sed 's/- current\./- current, with a note./' CHANGELOG.md > "$TMP/changelog"
  cp "$TMP/changelog" CHANGELOG.md
  git add CHANGELOG.md
}

stage_release() {
  sed 's/1\.2\.0/1.3.0/' .claude-plugin/plugin.json > "$TMP/plugin"
  cp "$TMP/plugin" .claude-plugin/plugin.json
  cat > CHANGELOG.md <<'EOF'
# Changelog

## [Unreleased]

## [1.3.0] - 2026-02-01

- next.

## [1.2.0] - 2026-01-02

- current.

## [1.1.0] - 2026-01-01

- old.

[1.3.0]: https://example.com/compare/v1.2.0...v1.3.0
[1.2.0]: https://example.com/compare/v1.1.0...v1.2.0
[1.1.0]: https://example.com/releases/v1.1.0
EOF
  git add CHANGELOG.md .claude-plugin/plugin.json
}

git init -q --bare -b main "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/work" 2>/dev/null
cd "$TMP/work"
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
git config tag.gpgsign false
mkdir scripts .claude-plugin
cp "$REPO/scripts/check-changelog-unreleased.sh" scripts/
printf '{\n  "name": "x",\n  "version": "1.2.0"\n}\n' > .claude-plugin/plugin.json
cat > CHANGELOG.md <<'EOF'
# Changelog

## [Unreleased]

- next.

## [1.2.0] - 2026-01-02

- current.

## [1.1.0] - 2026-01-01

- old.

[1.2.0]: https://example.com/compare/v1.1.0...v1.2.0
[1.1.0]: https://example.com/releases/v1.1.0
EOF
git add -A && git commit -q -m init && git push -q origin main
BASE=$(git rev-parse HEAD)

# Ordinary Unreleased edits and insertion immediately before the boundary pass.
start_case unreleased
edit_unreleased
assert_pass --staged
# Unstaged released changes must not affect a staged-only check.
sed 's/- current\./- unstaged change./' CHANGELOG.md > "$TMP/changelog"
cp "$TMP/changelog" CHANGELOG.md
assert_pass --staged

start_case before-heading
sed '/^## \[1.2.0\]/i\
- another upcoming change.\
' CHANGELOG.md > "$TMP/changelog"
cp "$TMP/changelog" CHANGELOG.md
git add CHANGELOG.md
assert_pass --staged

# The base has its first released heading on line 7 and its entry on line 9.
start_case released
edit_released
assert_rejected 9 '## [1.2.0]' --staged
# New-side diagnostics must follow line shifts in the Unreleased section.
sed '/^- next\./a\
- another upcoming change.\
' CHANGELOG.md > "$TMP/changelog"
cp "$TMP/changelog" CHANGELOG.md
git add CHANGELOG.md
assert_rejected 11 '## [1.2.0]' --staged

# Mixed replacements have no individual-line alignment. These manually worked
# locations cover their full new-side ranges, while precise edits and pure
# deletions retain their new-side line or Git anchor in both comparison modes.
while IFS='|' read -r boundary_case expected_location diagnostic_kind; do
  start_case "$boundary_case"
  case $boundary_case in
    overlapping-heading)
      sed -e 's/- next\./- next, with a note./' \
        -e '6d' \
        -e 's/2026-01-02/2026-01-03/' CHANGELOG.md > "$TMP/changelog"
      ;;
    frontier-expansion)
      sed '5,7c\
- next, edited.\
- extra upcoming one.\
- extra upcoming two.\
- upcoming separator replacement.\
## [1.2.0] - 2026-01-03
' CHANGELOG.md > "$TMP/changelog"
      ;;
    mixed-boundary-trailing-adds)
      sed '5,7c\
- next, edited.\
- upcoming separator replacement.\
## [1.2.0] - 2026-01-03\
- extra released one.\
- extra released two.
' CHANGELOG.md > "$TMP/changelog"
      ;;
    renamed-boundary-before-next-heading)
      sed '5,11c\
- next, edited.\
## Archived current\
- current, edited.\
## [1.1.0] - 2026-01-03
' CHANGELOG.md > "$TMP/changelog"
      ;;
    upcoming-details)
      sed '5,7c\
- next, edited.\
## Upcoming details\
- extra upcoming note.\
## [1.2.0] - 2026-01-03
' CHANGELOG.md > "$TMP/changelog"
      ;;
    same-size)
      sed '5,7c\
- next, edited.\
- upcoming separator replacement.\
## [1.2.0] - 2026-01-03
' CHANGELOG.md > "$TMP/changelog"
      ;;
    protected-heading-only)
      sed 's/2026-01-02/2026-01-03/' CHANGELOG.md > "$TMP/changelog"
      ;;
    pure-crossing-deletion)
      sed '5,7d' CHANGELOG.md > "$TMP/changelog"
      ;;
    *) fail "unknown boundary fixture: $boundary_case" ;;
  esac
  cp "$TMP/changelog" CHANGELOG.md
  git add CHANGELOG.md
  assert_boundary_rejected "$expected_location" "$diagnostic_kind" --staged
  git commit -q -m "boundary fixture: $boundary_case"
  assert_boundary_rejected "$expected_location" "$diagnostic_kind" "$BASE" HEAD
done <<'EOF'
overlapping-heading|5-6|mixed
frontier-expansion|5-9|mixed
mixed-boundary-trailing-adds|5-9|mixed
renamed-boundary-before-next-heading|5-8|mixed
upcoming-details|5-8|mixed
same-size|5-7|mixed
protected-heading-only|7|precise
pure-crossing-deletion|4|anchor
EOF

start_case after-heading
sed '/^## \[1.2.0\]/a\
- inserted into the release.
' CHANGELOG.md > "$TMP/changelog"
cp "$TMP/changelog" CHANGELOG.md
git add CHANGELOG.md
assert_rejected 8 '## [1.2.0]' --staged

start_case footer
sed 's@v1.1.0\.\.\.v1.2.0@v1.0.0...v1.2.0@' CHANGELOG.md > "$TMP/changelog"
cp "$TMP/changelog" CHANGELOG.md
git add CHANGELOG.md
assert_rejected 15 '## [1.1.0]' --staged

start_case release
stage_release
assert_pass --staged

# Net branch changes matter, not the delta from HEAD to the index.
start_case revert-released
edit_released
git commit -q -m 'edit released entry'
assert_rejected 9 '## [1.2.0]' --staged
git show "$BASE:CHANGELOG.md" > CHANGELOG.md
edit_unreleased
assert_pass --staged

# Revision checks agree with staged checks on rejected and exempt changes.
start_case revision-bad
edit_released
assert_rejected 9 '## [1.2.0]' --staged
git commit -q -m 'bad released edit'
BAD=$(git rev-parse HEAD)
assert_rejected 9 '## [1.2.0]' "$BASE" "$BAD"

start_case revision-release
stage_release
assert_pass --staged
git commit -q -m release
RELEASE=$(git rev-parse HEAD)
assert_pass "$BASE" "$RELEASE"

# Advance main after the branch point. The version there must not exempt a
# released edit on the branch, and unrelated main history must not be compared.
start_case main
printf 'unrelated\n' > unrelated.txt
sed 's/1\.2\.0/1.2.1/' .claude-plugin/plugin.json > "$TMP/plugin"
cp "$TMP/plugin" .claude-plugin/plugin.json
git add unrelated.txt .claude-plugin/plugin.json
git commit -q -m 'advance main independently'
AHEAD=$(git rev-parse HEAD)
assert_rejected 9 '## [1.2.0]' "$AHEAD" "$BAD"
assert_pass "$AHEAD" "$RELEASE"

# Without a released heading in the base, every changelog line is editable.
start_case no-release
printf '# Changelog\n\n## [Unreleased]\n\n- next.\n' > CHANGELOG.md
git add CHANGELOG.md && git commit -q -m 'only unreleased'
NO_RELEASE=$(git rev-parse HEAD)
printf '\n- additional change.\n' >> CHANGELOG.md
git add CHANGELOG.md && git commit -q -m 'extend unreleased'
assert_pass "$NO_RELEASE" HEAD

start_case no-changelog
git rm -q CHANGELOG.md && git commit -q -m 'remove changelog'
NO_CHANGELOG=$(git rev-parse HEAD)
printf '# Changelog\n\n## [1.2.0]\n\n- initial entry.\n' > CHANGELOG.md
git add CHANGELOG.md && git commit -q -m 'add changelog'
assert_pass "$NO_CHANGELOG" HEAD

# An absent origin/main falls back to HEAD for staged comparisons.
start_case local-only
git update-ref -d refs/remotes/origin/main
edit_released
assert_rejected 9 '## [1.2.0]' --staged
git reset -q --hard "$BASE"
edit_unreleased
assert_pass --staged

assert_usage
assert_usage main
assert_usage --unknown
assert_usage --staged extra
assert_usage main main extra

echo "ok"
