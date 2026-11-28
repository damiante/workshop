import type { RepoView, ReworkOn } from '../../server/src/api-types.ts';

export type RepoDraft = { selection: string; priority: string; image: string; mergeWithoutReview: boolean; raiseTickets: boolean; pushToDefault: boolean; reworkOn: ReworkOn };

/** The fields of a repository's settings form that differ from what's saved, as a PUT body. */
export function repoChanges(repo: Pick<RepoView, 'selection' | 'priority' | 'image' | 'mergeWithoutReview' | 'raiseTickets' | 'pushToDefault' | 'reworkOn'>, draft: RepoDraft): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = {};
  if (draft.selection !== repo.selection) body.selection = draft.selection;
  if (Number(draft.priority) !== repo.priority) body.priority = Number(draft.priority);
  if (draft.image.trim() !== (repo.image ?? '')) body.image = draft.image.trim();
  if (draft.mergeWithoutReview !== repo.mergeWithoutReview) body.mergeWithoutReview = draft.mergeWithoutReview;
  if (draft.raiseTickets !== repo.raiseTickets) body.raiseTickets = draft.raiseTickets;
  if (draft.pushToDefault !== repo.pushToDefault) body.pushToDefault = draft.pushToDefault;
  if (draft.reworkOn !== repo.reworkOn) body.reworkOn = draft.reworkOn;
  return body;
}
