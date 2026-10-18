#!/bin/sh
# Usage: directory-branch.sh TAG
#
# Pushes TAG's tree, minus the repository's dev-only files, as a new commit on
# origin's directory branch. Plugin directories track that branch, so they only
# see released versions and never scan scripts, tests, or CI files that plugin
# users do not need.
set -eu

tag="$1"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export GIT_INDEX_FILE="$tmp/index"
git read-tree "$tag"
git rm -rq --cached --ignore-unmatch scripts tests .github
tree="$(git write-tree)"
unset GIT_INDEX_FILE

parent="$(git ls-remote origin refs/heads/directory | cut -f1)"
[ -z "$parent" ] || git fetch -q origin directory
commit="$(git commit-tree ${parent:+-p "$parent"} -m "$tag" "$tree")"
git push -q origin "$commit:refs/heads/directory"
