#!/bin/sh
# Usage: check-dashes-whitespace.sh <base-rev> <head-rev>
#
# Rejects en and em dashes on lines that head adds to text files since its
# merge base with base, like the no-dashes pre-commit hook does for staged
# files, and the whitespace errors those lines add, with Git's --check
# diagnostics. Reports name locations only, so a secret on an offending line
# never reaches the CI log.
set -eu

usage() {
  echo "Usage: check-dashes-whitespace.sh <base-rev> <head-rev>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
# A revision that starts with a dash would reach git diff as an option.
case $1 in -*) usage ;; esac
case $2 in -*) usage ;; esac

cd "$(dirname "$0")/.."
base=$(git merge-base -- "$1" "$2")

# Git warnings can quote source content (for example an invalid attribute name).
# Keep raw stderr private and replace it with a content-free diagnostic.
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
git_diff() {
  result=0
  git "$@" 2> "$errors" || result=$?
  if [ -s "$errors" ]; then
    echo 'Git diff emitted diagnostics; source-bearing details omitted.' >&2
  fi
  return "$result"
}

# Keep non-ASCII paths unquoted and disable color, external diff drivers and
# text conversion so every added line reaches awk verbatim; Git reports binary
# files without their lines.
diff=$(git_diff -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --inter-hunk-context=0 -U0 "$base" "$2")

# Built from octal escapes, as the hook does, so this script holds no dash of its own.
en=$(printf '\342\200\223')
em=$(printf '\342\200\224')
dashes=0
# LC_ALL=C makes index() compare bytes whatever the line's encoding.
printf '%s\n' "$diff" | LC_ALL=C awk -v en="$en" -v em="$em" '
  function pathname(value,  result, i, c, octal, j) {
    sub(/\t$/, "", value)
    if (substr(value, 1, 1) == "\"") {
      value = substr(value, 2, length(value) - 2)
      for (i = 1; i <= length(value); i++) {
        c = substr(value, i, 1)
        if (c == "\\") {
          c = substr(value, ++i, 1)
          if (c == "t") c = "\t"
          else if (c == "n") c = "\n"
          else if (c == "a") c = sprintf("%c", 7)
          else if (c == "b") c = "\b"
          else if (c == "f") c = "\f"
          else if (c == "r") c = "\r"
          else if (c == "v") c = "\v"
          else if (c ~ /[0-7]/) {
            octal = c + 0
            for (j = 0; j < 2; j++) octal = octal * 8 + substr(value, ++i, 1)
            c = sprintf("%c", octal)
          }
        }
        result = result c
      }
      value = result
    }
    sub(/^b\//, "", value)
    return value
  }
  /^diff --git / { header = 1; next }
  header && /^\+\+\+ / { file = pathname(substr($0, 5)); next }
  /^@@ / {
    header = 0
    split($3, new, ",")
    line = substr(new[1], 2) + 0
    next
  }
  /^\+/ {
    if (index($0, en) || index($0, em)) {
      # Location only: the line may hold a secret that the CI log must not repeat.
      print file ":" line ": en or em dash."
      found = 1
    }
    line++
  }
  END { exit found }
  ' >&2 || dashes=1
if [ "$dashes" = 1 ]; then
  echo "En or em dash found. AGENTS.md bans them: rewrite the sentence." >&2
fi

whitespace=0
# Git starts the lines it writes with --line-prefix, while a path holding a
# newline goes on in lines without it, so a random prefix that no path can
# predict marks where each diagnostic and each echoed line begins. Only the
# blank line at EOF diagnostic comes without the prefix.
prefix="check-dashes-whitespace:$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n'):"
report=$(git_diff diff --check --line-prefix="$prefix" "$base" "$2") || whitespace=1
if [ "$whitespace" = 1 ]; then
  # Git follows each whitespace diagnostic ("path:N: <error>.") with the
  # offending line, except a blank line at EOF; a leftover conflict marker gets
  # no period and no echo. No message holds ": ", so the text after a group's
  # last ": " is its last message. An echoed line is one line: what follows it
  # in its group is blank line at EOF diagnostics. Print the diagnostics only.
  printf '%s\n' "$report" | awk -v prefix="$prefix" '
    function flush(  message, i) {
      if (echo) {
        i = index(group, "\n")
        group = i ? substr(group, i + 1) : ""
      }
      if (group != "") print group
      message = group
      while ((i = index(message, ": ")) > 0) message = substr(message, i + 2)
      echo = message ~ /\.$/ && message != "new blank line at EOF."
    }
    index($0, prefix) == 1 { flush(); group = substr($0, length(prefix) + 1); grouped = 1; next }
    { group = grouped ? group "\n" $0 : $0; grouped = 1 }
    END { flush() }
    ' >&2
fi

[ "$dashes" = 0 ] && [ "$whitespace" = 0 ]
