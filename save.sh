#!/bin/sh
# Pushes the data folder to the `data` branch as a single commit, replaced
# each time, so the repository doesn't grow by a commit every 5 minutes.
# Run by check.js after each round: sh save.sh <data folder>
# Needs REPO and TOKEN (set by the workflow).
set -e
cd "$1"
rm -rf .git
git init --quiet -b data
git config user.name "muster-status"
git config user.email "muster-status@users.noreply.github.com"
git add status.json daily.json outages.json
git commit --quiet -m "Checks at $(date -u +%FT%TZ)"
git push --quiet --force "https://x-access-token:${TOKEN}@github.com/${REPO}.git" data
