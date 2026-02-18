#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/release-bump.sh [patch|minor|major|X.Y.Z]

Examples:
  scripts/release-bump.sh patch
  scripts/release-bump.sh minor
  scripts/release-bump.sh 1.2.0

What this does:
  1) Verifies you are on main, clean, and synced with origin/main
  2) Bumps package.json version
  3) Commits release bump
  4) Pushes main
  5) Creates and pushes tag v<version> (triggers GitHub release workflow)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BUMP="${1:-patch}"

if ! [[ "$BUMP" =~ ^(patch|minor|major|[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo "Invalid bump target: $BUMP"
  usage
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required"
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "You must run this from main (current: $BRANCH)."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is not clean. Commit/stash changes first."
  exit 1
fi

git fetch origin main --tags >/dev/null

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  echo "Local main is not in sync with origin/main."
  echo "Run: git pull --ff-only"
  exit 1
fi

OLD_VERSION="$(node -p "require('./package.json').version")"
npm version "$BUMP" --no-git-tag-version >/dev/null
NEW_VERSION="$(node -p "require('./package.json').version")"
TAG="v${NEW_VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally."
  git checkout -- package.json
  exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists on origin."
  git checkout -- package.json
  exit 1
fi

echo "Bumping version: $OLD_VERSION -> $NEW_VERSION"

git add package.json
git commit -m "release: ${TAG}"
git push origin main

git tag "$TAG"
git push origin "$TAG"

echo
echo "Done. Pushed main and tag $TAG."
echo "GitHub Action 'release' should now publish ${NEW_VERSION} to npm."
