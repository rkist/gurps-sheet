#!/bin/sh
# Releases a new version from origin/main: pushes the tag, waits for the Docker
# workflow to test the image and publish it to GHCR, then creates the GitHub
# release. A failed workflow leaves no release behind.
#
#   make publish                  next patch after the latest v* tag
#   make publish VERSION=1.0.0
set -eu

gh auth status >/dev/null 2>&1 || { echo "Log in to GitHub first: gh auth login"; exit 1; }
git fetch --quiet --tags origin main

latest=$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)
if [ -n "${1:-}" ]; then
  version=${1#v}
elif [ -n "$latest" ]; then
  version=$(echo "${latest#v}" | awk -F. '{ printf "%d.%d.%d", $1, $2, $3 + 1 }')
else
  version=$(node -p 'require("./package.json").version')
fi
if ! echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Not a version: $version (expected x.y.z)"
  exit 1
fi
tag=v$version
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists."
  exit 1
fi

image=ghcr.io/$(gh repo view --json nameWithOwner --jq .nameWithOwner | tr '[:upper:]' '[:lower:]')
commit=$(git rev-parse origin/main)
echo "Release:  $tag (previous: ${latest:-none})"
echo "Commit:   $(git log -1 --format='%h %s' "$commit") (origin/main)"
echo "Image:    $image:$version"
printf 'Continue? [y/N] '
read -r answer
case $answer in
  y | Y | yes) ;;
  *) echo "Cancelled."; exit 1 ;;
esac

git tag -a "$tag" -m "$tag" "$commit"
git push --quiet origin "$tag"

echo "Waiting for the Docker workflow to test and publish the image..."
run=
for _ in $(seq 30); do
  run=$(gh run list --workflow docker.yml --branch "$tag" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  [ -n "$run" ] && break
  sleep 2
done
if [ -z "$run" ]; then
  echo "No workflow run started for $tag. Check the Actions tab; once the image is"
  echo "published, finish with: gh release create $tag --verify-tag --generate-notes"
  exit 1
fi
if ! gh run watch "$run" --exit-status --compact; then
  echo "The workflow failed: $image:$version was not published and no release was created."
  echo "To retry after a fix, delete the tag: git push --delete origin $tag && git tag -d $tag"
  exit 1
fi

gh release create "$tag" --verify-tag --title "$tag" --generate-notes
echo "Published $image:$version"
