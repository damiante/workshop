import { raiseAlert } from '../alerts.ts';
import { run } from '../db.ts';
import { deleteMedia } from '../media.ts';
import { getSettings } from '../settings.ts';
import { branchOf, editLabels, getRepo, labelsOf, repoRef, sourceFor, vcsFor, type TicketRow } from '../tickets.ts';
import { label, moveTo } from '../workflow/labels.ts';

const setPrStatus = (t: TicketRow, status: string) => run('UPDATE tickets SET pr_status = ? WHERE id = ?', status, t.id);

/** PR merged (by Workshop or by you): close the ticket and clear Workshop's stage labels. */
export async function finishMerged(t: TicketRow) {
  const repo = getRepo(t.repo_id)!;
  if (t.state !== 'closed') await sourceFor(repo).close(repoRef(repo), t.number);
  await editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running]);
  run("UPDATE tickets SET state = 'closed', pr_status = 'merged' WHERE id = ?", t.id);
  deleteMedia(t.id);
}

/** You closed the pull request without merging: close the issue as not planned. Reopening it starts again. */
export async function stopAfterClosedPr(t: TicketRow) {
  const repo = getRepo(t.repo_id)!;
  await editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running, label.needsInfo]);
  await sourceFor(repo).close(repoRef(repo), t.number, 'not_planned');
  run("UPDATE tickets SET state = 'closed', pr_status = 'closed' WHERE id = ?", t.id);
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
  await editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running, label.needsInfo]);
}

/**
 * Moves an approved ticket towards merged without an LLM where possible.
 * Returns 'agent' when only the Merge agent can help (conflicts).
 */
export async function advanceMerge(t: TicketRow): Promise<'merged' | 'agent' | 'waiting'> {
  const repo = getRepo(t.repo_id)!;
  const vcs = vcsFor(repo);
  const ref = repoRef(repo);
  const number = t.pr_number ?? (await vcs.findPullRequest(ref, branchOf(t)));
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
      if (pr.decision !== 'approved') {
        const back = moveTo(labelsOf(t), 'pr-review');
        await editLabels(t, back.add, back.remove);
        await vcs.requestReview(ref, number, t.author);
      }
      return 'waiting';
    default:
      return 'waiting'; // GitHub is still computing mergeability
  }
}
