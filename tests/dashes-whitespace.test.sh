#!/bin/sh
# Tests scripts/check-dashes-whitespace.sh against a temporary repository.
set -eu
# A hook in a linked worktree exports an absolute GIT_DIR, which would aim every git command below at the real repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Built from octal escapes, as the no-dashes hook does, so this file holds no dash of its own.
EN=$(printf '\342\200\223')
EM=$(printf '\342\200\224')
MESSAGE='En or em dash found. AGENTS.md bans them: rewrite the sentence.'

fail() { echo "FAIL: $*" >&2; exit 1; }

run_check() {
  status=0
  sh scripts/check-dashes-whitespace.sh "$@" > "$TMP/stdout" 2> "$TMP/stderr" || status=$?
  output=$(cat "$TMP/stdout" "$TMP/stderr")
}

assert_pass() {
  name=$1
  shift
  run_check "$@"
  [ "$status" -eq 0 ] || fail "$name: expected success, got $status: $output"
  [ -z "$output" ] || fail "$name: unexpected output: $output"
}

assert_rejected() {
  name=$1
  shift
  run_check "$@"
  [ "$status" -eq 1 ] || fail "$name: expected rejection, got $status: $output"
  case $output in "$NL"* | *"$NL$NL"*) fail "$name: blank line in: $output" ;; esac
}

NL='
'
# Each expected report starts a line, so a wrong path prefix cannot hide behind a substring match.
assert_reports() {
  case $NL$output in *"$NL$2"*) ;; *) fail "$1: missing line starting '$2' in: $output" ;; esac
}

assert_hides() {
  case $output in *"$2"*) fail "$1: output repeats '$2': $output" ;; esac
}

start_case() {
  git checkout -q -B "$1" "$BASE"
}

commit_case() {
  git add -A
  git commit -q -m "$1"
}

git init -q -b main "$TMP/work"
cd "$TMP/work"
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
# Diff settings a contributor may have; the script must still read Git's plain diff.
git config color.ui always
git config diff.external true
git config diff.hide.textconv true
printf '* diff=hide\n' > .gitattributes
mkdir scripts
cp "$REPO/scripts/check-dashes-whitespace.sh" scripts/
printf '# Fixture\n\nfirst line\nsecond line\nthird line\n' > README.md
# Offences already in the base: a range that only leaves them in place must pass.
printf 'old %s dash\nold trailing  \nkept\n' "$EM" > legacy.md
commit_case init
BASE=$(git rev-parse HEAD)

# An em dash added to a tracked Markdown file is reported with its file and line.
start_case em-dash
sed "4s/.*/second $EM line/" README.md > "$TMP/file" && cp "$TMP/file" README.md
commit_case 'add an em dash'
assert_rejected em-dash "$BASE" HEAD
assert_reports em-dash "README.md:4:"
assert_reports em-dash "$MESSAGE"

# An en dash counts too. Each hunk restarts the line count, so the second hunk's line is right.
start_case en-dash
sed -e '2s/.*/intro/' -e "5s/.*/third $EN line/" README.md > "$TMP/file" && cp "$TMP/file" README.md
commit_case 'add an en dash'
assert_rejected en-dash "$BASE" HEAD
assert_reports en-dash "README.md:5:"

# Any text file counts, not only Markdown, and a new file numbers its lines from 1.
start_case text-file
printf '#!/bin/sh\necho "one %s two"\n' "$EM" > tool.sh
commit_case 'add a script with an em dash'
assert_rejected text-file "$BASE" HEAD
assert_reports text-file "tool.sh:2:"

# A reported line may hold a secret, so the report names its location without its content.
start_case dash-redacted
printf 'token=dash-sentinel-value %s\n' "$EM" > secret.env
commit_case 'add a secret on a line with an em dash'
assert_rejected dash-redacted "$BASE" HEAD
assert_reports dash-redacted "secret.env:1:"
assert_hides dash-redacted "dash-sentinel-value"

# An added line that starts with "++" reads "+++" in the diff, like a file header, but is content.
start_case plus-prefix
printf '++ counter %s step\n' "$EM" >> README.md
commit_case 'add a line starting with ++'
assert_rejected plus-prefix "$BASE" HEAD
assert_reports plus-prefix "README.md:6:"

# A non-ASCII file name is reported as written, not in Git's quoted form.
start_case non-ascii-path
NAME=$(printf 'caf\303\251.md')
printf 'menu %s soup\nprice  \n' "$EM" > "$NAME"
commit_case 'add a file with a non-ASCII name'
assert_rejected non-ascii-path "$BASE" HEAD
assert_reports non-ascii-path "$NAME:1:"
assert_reports non-ascii-path "$NAME:2: trailing whitespace."

# Git's binary detection skips files whose bytes hold a dash.
start_case binary
printf 'bin\000ary %s\n' "$EM" > blob.bin
commit_case 'add a binary file'
assert_pass binary "$BASE" HEAD

start_case clean
printf 'fourth line\n' >> README.md
commit_case 'add a clean line'
assert_pass clean "$BASE" HEAD

# Text in another encoding passes without a warning from awk about invalid multibyte data.
start_case latin1
printf 'caf\351 au lait\n' > latin1.txt
commit_case 'add a Latin-1 text file'
assert_pass latin1 "$BASE" HEAD

start_case trailing-whitespace
sed '3s/.*/first line  /' README.md > "$TMP/file" && cp "$TMP/file" README.md
commit_case 'add trailing whitespace'
assert_rejected trailing-whitespace "$BASE" HEAD
assert_reports trailing-whitespace "README.md:3: trailing whitespace."

# Git echoes each offending line after its diagnostic; the report keeps every diagnostic only.
start_case whitespace-redacted
printf 'token=ws-sentinel-value  \nsecond=ws-other-value \n' > secret.env
commit_case 'add secrets on lines with trailing whitespace'
assert_rejected whitespace-redacted "$BASE" HEAD
assert_reports whitespace-redacted "secret.env:1: trailing whitespace."
assert_reports whitespace-redacted "secret.env:2: trailing whitespace."
assert_hides whitespace-redacted "ws-sentinel-value"
assert_hides whitespace-redacted "ws-other-value"

# Git echoes no line after a blank line at EOF, so the next diagnostic must survive.
start_case blank-eof
printf 'text\n\n' > a-eof.md
printf 'text \n' > b-trailing.md
commit_case 'add a blank line at EOF, then trailing whitespace'
assert_rejected blank-eof "$BASE" HEAD
assert_reports blank-eof "a-eof.md:2: new blank line at EOF."
assert_reports blank-eof "b-trailing.md:1: trailing whitespace."

# Nor after a leftover conflict marker, which Git reports without echoing the line.
start_case conflict-marker
printf 'text\n<<<<<<< ours\n' > a-marker.md
printf 'text \n' > b-trailing.md
commit_case 'add a conflict marker, then trailing whitespace'
assert_rejected conflict-marker "$BASE" HEAD
assert_reports conflict-marker "a-marker.md:2: leftover conflict marker"
assert_reports conflict-marker "b-trailing.md:1: trailing whitespace."

# Git prints a path with a newline across lines, so a period ending its first
# line must not pass for a diagnostic whose echoed line comes next.
start_case newline-path
printf 'nl-sentinel-value \n' > "$(printf 'a.\nb.txt')"
commit_case 'add trailing whitespace to a file whose name holds a newline'
assert_rejected newline-path "$BASE" HEAD
assert_reports newline-path "b.txt:1: trailing whitespace."
assert_hides newline-path "nl-sentinel-value"

# Nor may a path line that looks like a whitespace diagnostic, which Git would
# then seem to follow with the real diagnostic as its echoed line.
start_case diagnostic-shaped-path
printf 'shaped-sentinel-value \n' > "$(printf 'a:1: trailing whitespace.\nb.txt')"
commit_case 'add trailing whitespace to a file whose name looks like a diagnostic'
assert_rejected diagnostic-shaped-path "$BASE" HEAD
assert_reports diagnostic-shaped-path "b.txt:1: trailing whitespace."
assert_hides diagnostic-shaped-path "shaped-sentinel-value"

# Git writes a blank line at EOF without the line prefix, right after the
# file's last echoed line or diagnostic; it is reported and the echo is not.
# The marker file sorts last, so the run ends on diagnostics without an echo.
start_case eof-after-echo
printf 'text \n' > 0-trailing.md
printf 'eof-sentinel-value \n\n' > a-both.md
printf 'text\n<<<<<<< ours\n\n' > b-marker.md
commit_case 'add whitespace errors before blank lines at EOF'
assert_rejected eof-after-echo "$BASE" HEAD
assert_reports eof-after-echo "0-trailing.md:1: trailing whitespace."
assert_reports eof-after-echo "a-both.md:1: trailing whitespace."
assert_reports eof-after-echo "a-both.md:2: new blank line at EOF."
assert_reports eof-after-echo "b-marker.md:2: leftover conflict marker"
assert_reports eof-after-echo "b-marker.md:3: new blank line at EOF."
assert_hides eof-after-echo "eof-sentinel-value"

# One run reports every kind of offence, not only the first.
start_case both
sed -e "3s/.*/first $EM line/" -e '5s/.*/third line /' README.md > "$TMP/file" && cp "$TMP/file" README.md
commit_case 'add a dash and trailing whitespace'
assert_rejected both "$BASE" HEAD
assert_reports both "README.md:3:"
assert_reports both "README.md:5: trailing whitespace."

# The base's own dash and trailing whitespace stay out of a range that only edits around them.
start_case base-offences
printf 'added clean line\n' >> legacy.md
commit_case 'edit next to old offences'
assert_pass base-offences "$BASE" HEAD

start_case delete-dash
sed 1d legacy.md > "$TMP/file" && cp "$TMP/file" legacy.md
commit_case 'delete the dash line'
assert_pass delete-dash "$BASE" HEAD

# Main moving on after the branch point must not blame the branch: removing the
# old offences on main would otherwise read as the branch adding them back.
start_case main-ahead
printf 'kept\n' > legacy.md
commit_case 'fix old offences on main'
AHEAD=$(git rev-parse HEAD)
start_case branch
printf 'branch work\n' > branch.md
commit_case 'branch work'
assert_pass main-ahead "$AHEAD" HEAD

assert_usage() {
  run_check "$@"
  [ "$status" -eq 2 ] || fail "$*: expected usage status 2, got $status"
  assert_reports "$*" "Usage:"
}
assert_usage
assert_usage main
assert_usage main main extra
assert_usage --cached main
assert_usage main --cached

echo "ok"
