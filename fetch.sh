#!/bin/sh
# Gets the last results (the `data` branch) into the data folder before a run.
# M20 (23 Oct): only start empty when the branch really doesn't exist yet.
# Any other failure (GitHub hiccup, token problem) stops the run, so save.sh
# can't force-push a one-round branch over 90 days of history.
# Usage: sh fetch.sh <remote url> <data folder>
set -u
url="$1"
dir="$2"
for try in 1 2 3; do
  git ls-remote --exit-code --heads "$url" data >/dev/null 2>&1
  found=$?
  # 0: the branch exists. 2: the remote answered and has no such branch.
  # Anything else: couldn't reach it; try again.
  if [ "$found" = 0 ]; then
    rm -rf "$dir"
    if git clone --quiet --depth 1 --branch data "$url" "$dir"; then
      exit 0
    fi
  elif [ "$found" = 2 ]; then
    echo "No data branch yet: starting with no history."
    mkdir -p "$dir"
    exit 0
  fi
  sleep $((try * ${FETCH_RETRY_WAIT:-5}))
done
echo "Couldn't get the data branch; stopping so the history isn't overwritten." >&2
exit 1
