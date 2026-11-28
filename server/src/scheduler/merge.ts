import { raiseAlert } from '../alerts.ts';
import { run } from '../db.ts';
import { publish } from '../events.ts';
import { deleteMedia } from '../media.ts';
import type { MergeRules } from '../providers/types.ts';
import { getSettings } from '../settings.ts';
import { branchOf, editLabels, followUpsOf, getRepo, labelsOf, repoRef, rescueOf, sourceFor, vcsFor, type TicketRow } from '../tickets.ts';
import { label, moveTo } from '../workflow/labels.ts';
import type { FollowUps } from '../workflow/schemas.ts';
import { raiseFollowUps } from './raise.ts';

const setPrStatus = (t: TicketRow, status: string) => run('UPDATE tickets SET pr_status = ? WHERE id = ?', status, t.id);

/** PR merged (by Workshop or by you): close the ticket, clear Workshop's stage labels and delete its branches. */
export async function finishMerged(t: TicketRow) {
  const repo = getRepo(t.repo_id)!;
  if (t.state !== 'closed') await sourceFor(repo).close(repoRef(repo), t.number);
  await editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running]);
  run("UPDATE tickets SET state = 'closed', pr_status = 'merged', follow_ups = NULL WHERE id = ?", t.id);
  publish('tickets');
  deleteMedia(t.id);
  // The merge already succeeded, so a branch that won't delete (or is already gone) is only logged.
  const vcs = vcsFor(repo);
  const rescue = rescueOf(t);
  for (const branch of [branchOf(t), rescue?.branch]) {
    if (branch) await vcs.deleteBranch(repoRef(repo), branch).catch((err) => console.warn(`Couldn't delete ${branch}: ${(err as Error).message}`));
  }
  if (rescue) run('UPDATE tickets SET rescue = NULL WHERE id = ?', t.id);
}

/** You closed the pull request without merging: close the issue as not planned. Reopening it starts again. */
export async function stopAfterClosedPr(t: TicketRow) {
  const repo = getRepo(t.repo_id)!;
  await editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running, label.needsInfo]);
  await sourceFor(repo).close(repoRef(repo), t.number, 'not_planned');
  run("UPDATE tickets SET state = 'closed', pr_status = 'closed' WHERE id = ?", t.id);
  publish('tickets');
  await sourceFor(repo).comment(
    repoRef(repo),
    t.number,
    'The pull request was closed without merging, so Workshop closed this issue as not planned. Reopen the issue to start again from classification.',
  );
  deleteMedia(t.id);
}

/** You closed the issue: close Workshop's open pull request, delete its branch and clear its labels. */
export async function cleanUpClosedIssue(t: TicketRow) {
  const repo = getRepo(t.repo_id)!;
  const vcs = vcsFor(repo);
  const ref = repoRef(repo);
  const number = t.pr_number ?? (t.branch ? await vcs.findPullRequest(ref, t.branch) : null);
  if (number) {
    const pr = await vcs.pullRequestState(ref, number, getSettings().authors);
    if (pr.state === 'merged') {
      await finishMerged(t); // GitHub closed the issue through "Closes #n"
      return;
    }
    if (pr.state === 'open') {
      await vcs.commentOnPullRequest(ref, number, 'The issue was closed, so Workshop closed this pull request.');
      await vcs.closePullRequest(ref, number);
    }
    setPrStatus(t, 'closed');
  }
  if (t.branch) await vcs.deleteBranch(ref, t.branch);
  const rescue = rescueOf(t);
  if (rescue) {
    await vcs.deleteBranch(ref, rescue.branch).catch((err) => console.warn(`Couldn't delete ${rescue.branch}: ${(err as Error).message}`));
    run('UPDATE tickets SET rescue = NULL WHERE id = ?', t.id);
  }
  await editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running, label.needsInfo]);
}

/** What follows a warning about rules Workshop couldn't read. */
export const UNCHECKED_TAIL = 'If that requires an approving review, pull requests will wait in merge until you approve them.';

/** Whether merge without review can be turned on for `branch`, and what to warn about. */
export function mergeWithoutReviewVerdict(branch: string, rules: MergeRules): { error: string } | { warning: string | null } {
  if (rules.reviewRequired) {
    return {
      error: `${branch} requires an approving review before merging, and the Workshop App can't approve its own pull requests. Remove the review requirement, or add the App as a bypass actor, then turn this on again.`,
    };
  }
  const warnings: string[] = [];
  if (!rules.checksRequired) warnings.push(`No status checks are required on ${branch}, so failing CI won't stop a merge. Make CI a required status check.`);
  if (rules.unknown.length) warnings.push(`Workshop couldn't check ${rules.unknown.join(' or ')}. ${UNCHECKED_TAIL}`);
  return { warning: warnings.join(' ') || null };
}

/** The one commit's message: the branch's first commit says what the work is, in the repository's own style. */
export function pushMessage(t: { number: number; title: string }, subjects: string[]): string {
  const own = subjects.filter((s) => !/^Merge (remote-tracking )?branch /.test(s));
  const first = own[0] ?? t.title;
  const subject = new RegExp(`#${t.number}\\b`).test(first) ? first : `${first} (#${t.number})`;
  const rest = own.slice(1).map((s) => `- ${s}`);
  return rest.length ? `${subject}\n\n${rest.join('\n')}` : subject;
}

/**
 * In a repository that takes work straight on its default branch: brings the ticket's branch up to date, then
 * puts its files on the default branch as one commit, opens tickets for the code review's remaining findings and
 * finishes the ticket. No pull request is involved.
 */
async function pushToDefault(t: TicketRow): Promise<'merged' | 'agent' | 'waiting'> {
  const repo = getRepo(t.repo_id)!;
  const ref = repoRef(repo);
  const follow = followUpsOf(t);
  // An earlier attempt pushed, then failed opening the follow-ups: don't push (or merge) again.
  if (follow?.commit) return finishPush(t, follow.commit, follow);
  const vcs = vcsFor(repo);
  const branch = branchOf(t);
  const state = await vcs.branchState(ref, branch);
  if (state.ahead === 0) {
    await sourceFor(repo).comment(ref, t.number, `Nothing to push: \`${branch}\` has no changes that aren't already on \`${repo.default_branch}\`.`);
    await finishMerged(t);
    return 'merged';
  }
  if (state.behind > 0) {
    // The Merge agent starts on tickets whose status is 'conflict'.
    const merged = await vcs.mergeDefaultInto(ref, branch);
    setPrStatus(t, merged === 'conflict' ? 'conflict' : 'behind');
    return merged === 'conflict' ? 'agent' : 'waiting';
  }
  const pushed = await vcs.pushToDefault(ref, branch, pushMessage(t, state.subjects));
  if (!pushed.ok) {
    setPrStatus(t, 'blocked');
    raiseAlert('warning', 'merge-failed', `Couldn't push ${repo.full_name}#${t.number} to ${repo.default_branch}: ${pushed.message}`, `ticket:${t.id}`);
    return 'waiting';
  }
  const commit = { sha: pushed.sha, url: pushed.url };
  // Recorded first, so a retry after a failure from here on doesn't push again.
  if (follow) run('UPDATE tickets SET follow_ups = ? WHERE id = ?', JSON.stringify({ ...follow, commit }), t.id);
  return finishPush(t, commit, follow);
}

/** After the push: opens the follow-up tickets, says what was pushed, and finishes the ticket. */
async function finishPush(t: TicketRow, commit: { sha: string; url: string }, follow: FollowUps | null): Promise<'merged'> {
  const repo = getRepo(t.repo_id)!;
  const lines = follow ? await raiseFollowUps(t, follow, commit) : [];
  const pushed = `Workshop pushed this to \`${repo.default_branch}\` as [\`${commit.sha.slice(0, 7)}\`](${commit.url}).`;
  const list = lines.length ? `\n\nFollow-up tickets for the code review's remaining findings:\n${lines.join('\n')}` : '';
  await sourceFor(repo).comment(repoRef(repo), t.number, pushed + list);
  await finishMerged(t);
  return 'merged';
}

/**
 * Moves an approved ticket (or any, with merge without review) towards merged without an LLM where possible.
 * Returns 'agent' when only the Merge agent can help (conflicts).
 */
export async function advanceMerge(t: TicketRow): Promise<'merged' | 'agent' | 'waiting'> {
  const repo = getRepo(t.repo_id)!;
  const vcs = vcsFor(repo);
  const ref = repoRef(repo);
  const number = t.pr_number ?? (await vcs.findPullRequest(ref, branchOf(t)));
  if (!number && repo.push_to_default) return pushToDefault(t);
  if (!number) {
    await editLabels(t, [], moveTo(labelsOf(t), null).remove);
    raiseAlert('warning', 'merge-no-pr', `${repo.full_name}#${t.number} was marked for merge but has no pull request.`, `ticket:${t.id}`);
    return 'waiting';
  }
  const pr = await vcs.pullRequestState(ref, number, getSettings().authors);
  if (pr.state === 'merged') {
    await finishMerged(t);
    return 'merged';
  }
  if (pr.state === 'closed') {
    await stopAfterClosedPr(t);
    return 'waiting';
  }
  setPrStatus(t, pr.mergeable);
  // With merge without review, nothing else stops a merge, so requested changes are checked here.
  if (repo.merge_without_review && pr.decision === 'changes_requested') {
    const back = moveTo(labelsOf(t), 'reclassify');
    await editLabels(t, back.add, back.remove);
    return 'waiting';
  }
  switch (pr.mergeable) {
    case 'clean': {
      const result = await vcs.merge(ref, number);
      if (result.merged) {
        await finishMerged(t);
        return 'merged';
      }
      raiseAlert('warning', 'merge-failed', `Couldn't merge ${repo.full_name}#${number}: ${result.message}`, `ticket:${t.id}`);
      return 'waiting';
    }
    case 'conflict':
      return 'agent';
    case 'behind':
      await vcs.updateBranch(ref, number);
      return 'waiting';
    case 'blocked':
      // New commits (e.g. the Merge agent's) can dismiss your approval: ask for a fresh review.
      // With merge without review on, Workshop waits for required checks instead of for you.
      if (pr.decision !== 'approved' && !repo.merge_without_review) {
        const back = moveTo(labelsOf(t), 'pr-review');
        await editLabels(t, back.add, back.remove);
        await vcs.requestReview(ref, number, t.author);
      }
      return 'waiting';
    default:
      return 'waiting'; // GitHub is still computing mergeability
  }
}
