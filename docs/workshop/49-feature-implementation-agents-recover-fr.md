# Recover from rejected pushes (#49)

## Context

The `publish` step (`agent/entrypoint.sh`) runs a bare `git push "$PUSH_URL" "HEAD:refs/heads/$BRANCH"`. When the branch moved on GitHub after `prepare` fetched it (the owner pushed a fix, GitHub's "Update branch" or `advanceMerge`'s `vcs.updateBranch` merged base into it, …), the push is rejected as non-fast-forward, `publish` exits non-zero, and `publishRun` fails the run. The retry is a new run on a new volume whose `prepare` checks out `origin/$BRANCH` with `checkout -f -B`, so the agent's commits are lost, and the failed run's volume is deleted by cleanup.

Outcome: `publish` integrates whatever is on the remote branch and confirms the push before reporting success. If it can't integrate automatically (real conflict), the agent's commits are saved on a separate branch, the owner is told where, and the run fails with a clear message. This covers every agent that publishes (Design, Implementation, Merge), not only Implementation.

## Approach

- **Fetch, merge, push, up to 3 times.** On a rejected push, `publish` fetches the remote branch and runs `git merge --no-edit` into HEAD, then pushes again. A merge rather than a rebase: the remote changes are usually merge commits from base (update-branch), which rebase handles badly, merging never rewrites the agent's commits, and the Merge agent already works with merge commits. Three tries cover a branch that moves again between fetch and push.
- **Conflicts: rescue branch, then fail.** If the merge conflicts, `publish` runs `git merge --abort` immediately (so no conflict markers stay in the tree, and the "uncommitted changes" auto-commit can never commit them on a re-run), pushes HEAD to `$BRANCH-unmerged-<short sha>`, prints a JSON line naming that branch, and exits 3. The runner comments on the issue with the branch name and fails the run with a readable message. Handing off to the Merge agent was considered, but it only merges the base branch and only runs on approved PRs; a rescue branch keeps the work safe with no new state in the workflow. Conflicts here should be rare: the remote changes are normally a base merge.
- **Success only after a confirmed push.** The success JSON line is printed only after `git push` exits 0, as today. `before` becomes the remote tip that the successful push replaced (from the last fetch/`ls-remote`), so `openOrUpdatePr`'s "new commits" check (`before === after`) still works: if the agent committed nothing and the remote moved, the merge fast-forwards HEAD to the remote tip, the push is a no-op, and `before === after` still fails the run as "without committing any changes".
- **No credentials left on the volume.** Fetch with the credentialled `PUSH_URL` on the command line only, into `refs/remotes/origin/$BRANCH`, and `rm -f .git/FETCH_HEAD` afterwards, matching `prepare`.

## Changes

### `agent/entrypoint.sh`

- Top: `cd "${WORKSHOP_DIR:-/work}"` instead of `cd /work`, so a test can run the script against a temporary directory. Nothing in the containers sets it.
- Replace the `publish` push with roughly:

  ```sh
  pushed=
  for attempt in 1 2 3; do
    before=$(git ls-remote "$PUSH_URL" "refs/heads/$BRANCH" | cut -f1)
    if git push "$PUSH_URL" "HEAD:refs/heads/$BRANCH"; then pushed=1; break; fi
    # Rejected: the branch moved on the remote since prepare. Bring its commits in and try again.
    git fetch -q "$PUSH_URL" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
    rm -f .git/FETCH_HEAD
    if ! git merge -q --no-edit "origin/$BRANCH"; then
      git merge --abort
      rescue="$BRANCH-unmerged-$(git rev-parse --short HEAD)"
      git push "$PUSH_URL" "HEAD:refs/heads/$rescue"
      printf '{"rescued":"%s"}\n' "$rescue"
      exit 3
    fi
  done
  if [ -z "$pushed" ]; then echo "Gave up pushing $BRANCH after 3 attempts." >&2; exit 1; fi
  ```

  The `ahead` count and final JSON line stay as they are. Under `set -e`, a failing `git push` inside `if` doesn't exit; a failing fetch or rescue push still exits non-zero (generic failure, as today). Keep the existing comment style: one short comment per non-obvious step.

### `server/src/scheduler/runner.ts`

- `Pushed` gains `rescued?: string`.
- In `publishRun`, when the publish container exits non-zero and `pushed.rescued` is set:
  - comment on the issue: ``${branch} changed on GitHub while the ${agent label} agent was working, and its commits conflict with the new ones. Workshop saved the agent's work on [`${rescued}`](branch URL) and will try again from the current branch.`` (use `AGENT_INFO[r.agent].label`; branch URL from `vcs.fileUrl`'s pattern or plain backticks if no helper exists — don't add a provider method just for this);
  - throw ``Couldn't push ${branch}: it changed on GitHub and the agent's commits conflict with it. The work is saved on ${rescued}.``
- Exit code 3 without `rescued` (shouldn't happen) and other non-zero exits keep today's message.
- The comment must not be posted twice if `publish` is re-attached: it's posted in the runner after the container finished, right before `fail()`, so it happens once per run.

### Docs

- `server/AGENTS.md`, "Run lifecycle": one bullet: `publish` merges in commits that appeared on the remote branch and retries the push; on conflict it saves the work on `<branch>-unmerged-<sha>` and the run fails.
- `docs/design/workflow.md`: if it describes the publish step, add the same sentence there.

## Data and interfaces

- `publish` stdout JSON gains an alternative line `{"rescued":"<branch>"}` (with exit 3). The success line is unchanged.
- New optional env var `WORKSHOP_DIR` for the entrypoint (tests only).
- No schema, API or settings changes.

## Tests

- **`server/test/publish.test.ts`** (new, real git, no Docker): in a temp dir, create a bare `remote.git` with `main`, run `bash agent/entrypoint.sh prepare` with `WORKSHOP_DIR`, `REPO_URL`/`CLEAN_URL`/`PUSH_URL` pointing at the bare repo, then commit in `repo/` and run `publish` (via `child_process.spawnSync`). Cases:
  1. Plain push: exit 0, JSON `after` equals the remote branch tip.
  2. Remote moved with a non-conflicting commit (pushed from a second clone after prepare): exit 0, remote tip contains both commits, `before` is the other clone's commit, `after` is the new merge commit.
  3. Remote moved with a conflicting change to the same line: exit 3, JSON `rescued` names a branch that exists on the remote at the agent's commit, `$BRANCH` is unchanged, the working tree has no `MERGE_HEAD` and no conflict markers.
  4. Agent committed nothing, remote moved: exit 0, `before === after`.
  5. `.git/FETCH_HEAD` doesn't exist after cases 2–3.
  Skip the file (`describe.skipIf`) when `git` isn't on PATH. CI's ubuntu runner has git.
- **`server/test/pipeline.test.ts`**: a FakeEnv publish that prints `{"rescued":"workshop/1-x-unmerged-abc1234"}` and exits 3 (extend FakeEnv so a script can set the exit code for a step, e.g. a `exitCodes` map used by `wait`/`inspect`). Expect run `failed` with the error mentioning the rescue branch, one issue comment containing it, and `failures` incremented. Also a plain non-zero exit without `rescued` keeps the old "Pushing … failed" message.
- Run `npm run typecheck` and `npm test`. Optionally try the image by hand with the bare-repo recipe in `server/AGENTS.md`.

## Risks and open questions

- **Merge instead of rebase** adds a merge commit to the PR when the remote moved. Acceptable for review; squash merges hide it anyway.
- **Merge runs the repo's hooks?** `git merge` runs no client hooks except `post-merge`/`prepare-commit-msg`/`commit-msg` from `.git/hooks`, which aren't populated from the repo. Fine.
- **Retry after a conflict starts from the remote branch**, so the agent redoes the work on top of the new commits; the old work survives only on the rescue branch (named in the issue comment and run error). Teaching `prepare` to pick up rescue branches was left out to keep the change small; it can follow if conflicts turn out to be common.
- **Rescue branches accumulate** on GitHub; Workshop doesn't delete them. The owner deletes them after looking.
- If a publish container is killed mid-merge, a re-run finds a merge in progress. The window is milliseconds; if it matters, add `[ -f .git/MERGE_HEAD ] && [ -n "$(git ls-files -u)" ] && git merge --abort` at the start of `publish` (only aborts a conflicted merge, so a Merge agent's resolved-but-uncommitted merge is still committed).
