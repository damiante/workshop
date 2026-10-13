import { raiseAlert } from '../alerts.ts';
import { run } from '../db.ts';
import { getSettings } from '../settings.ts';
import { branchOf, editLabels, getRepo, labelsOf, repoRef, sourceFor, vcsFor, type TicketRow } from '../tickets.ts';
import { label, moveTo } from '../workflow/labels.ts';

const setPrStatus = (t: TicketRow, status: string) => run('UPDATE tickets SET pr_status = ? WHERE id = ?', status, t.id);

/** PR merged (by Workshop or by you): close the ticket and clear Workshop's stage labels. */
export async function finishMerged(t: TicketRow) {
  const repo = getRepo(t.repo_id)!;
  await sourceFor(repo).close(repoRef(repo), t.number);
  await editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running]);
  run("UPDATE tickets SET state = 'closed', pr_status = 'merged' WHERE id = ?", t.id);
}

/** You closed the pull request without merging: stop rather than start the ticket over. */
export async function stopAfterClosedPr(t: TicketRow) {
  const repo = getRepo(t.repo_id)!;
  await editLabels(t, [label.skip], [...moveTo(labelsOf(t), null).remove, label.running]);
  run("UPDATE tickets SET pr_status = 'closed' WHERE id = ?", t.id);
  await sourceFor(repo).comment(
    repoRef(repo),
    t.number,
    `The pull request was closed without merging, so Workshop has stopped working on this ticket. Remove the \`${label.skip}\` label to start again from classification.`,
  );
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
