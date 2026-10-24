#!/usr/bin/env bash
# Workshop runs each step of an agent run in its own container on the run's volume (/work).
# Git credentials only ever exist in `prepare` and `publish`; the container running Claude has none.
set -euo pipefail
cd "${WORKSHOP_DIR:-/work}"

case "${1:-}" in
  prepare)
    # REPO_URL carries a short-lived read token. It's only ever passed on the command line: the
    # remote is the clean URL, so nothing on the volume (which the Claude step mounts) holds it.
    if [ ! -d repo/.git ]; then
      git init -q repo
      git -C repo remote add origin "$CLEAN_URL"
    fi
    cd repo
    git fetch --prune "$REPO_URL" "+refs/heads/*:refs/remotes/origin/*"
    rm -f .git/FETCH_HEAD
    git config user.name "$GIT_NAME"
    git config user.email "$GIT_EMAIL"
    if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
      git checkout -q -f -B "$BRANCH" "origin/$BRANCH"
    else
      git checkout -q -f -B "$BRANCH" "origin/$BASE_BRANCH"
    fi
    echo "Checked out $BRANCH at $(git rev-parse --short HEAD)"
    ;;

  run)
    cd repo
    args=(-p --model "$MODEL" --output-format stream-json --verbose
      --dangerously-skip-permissions --permission-prompts none
      --json-schema "$(cat /work/.workshop/schema.json)")
    if [ -n "${EFFORT:-}" ]; then args+=(--effort "$EFFORT"); fi
    if [ -n "${MAX_TURNS:-}" ]; then args+=(--max-turns "$MAX_TURNS"); fi
    if [ -n "${MAX_BUDGET_USD:-}" ]; then args+=(--max-budget-usd "$MAX_BUDGET_USD"); fi
    if [ -n "${RESUME:-}" ]; then
      # Paused by a usage limit: same session, same workspace.
      exec claude "${args[@]}" --resume "$SESSION_ID" \
        "Continue the task from where you stopped. When it's finished, return the structured result."
    fi
    exec claude "${args[@]}" --session-id "$SESSION_ID" \
      --append-system-prompt-file /work/.workshop/system.md < /work/.workshop/prompt.md
    ;;

  publish)
    cd repo
    # Agents occasionally leave work uncommitted; keep it rather than lose it.
    if [ -n "$(git status --porcelain)" ]; then
      git add -A
      git commit -q -m "Commit changes the agent left uncommitted"
    fi
    # Only report success once a push has gone through. If the branch moved on the remote since
    # prepare, merge its commits in and try again rather than lose the agent's work.
    pushed=
    for _ in 1 2 3; do
      before=$(git ls-remote "$PUSH_URL" "refs/heads/$BRANCH" | cut -f1)
      if git push "$PUSH_URL" "HEAD:refs/heads/$BRANCH"; then pushed=1; break; fi
      git fetch -q "$PUSH_URL" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
      rm -f .git/FETCH_HEAD
      if ! git merge -q --no-edit "origin/$BRANCH"; then
        # A real conflict: keep the work on a separate branch for the owner and fail the run.
        git merge --abort
        rescue="$BRANCH-unmerged-$(git rev-parse --short HEAD)"
        git push "$PUSH_URL" "HEAD:refs/heads/$rescue"
        printf '{"rescued":"%s"}\n' "$rescue"
        exit 3
      fi
    done
    if [ -z "$pushed" ]; then echo "Gave up pushing $BRANCH after 3 attempts." >&2; exit 1; fi
    ahead=$(git rev-list --count "origin/$BASE_BRANCH..HEAD")
    # Workshop reads this line: whether anything new was pushed, and how far the branch is ahead of base.
    printf '{"before":"%s","after":"%s","ahead":%s}\n' "$before" "$(git rev-parse HEAD)" "$ahead"
    ;;

  usage-probe)
    # One tiny turn (~700 tokens): its first API response reports the 5-hour and weekly usage.
    exec claude -p --model "${PROBE_MODEL:-claude-haiku-5-5}" --system-prompt 'Reply with the single word OK.' \
      --tools '' --max-turns 1 --output-format stream-json --verbose --no-session-persistence OK
    ;;

  *)
    echo "usage: workshop-agent prepare|run|publish|usage-probe" >&2
    exit 2
    ;;
esac
