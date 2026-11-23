import type { RepoView } from '../../server/src/api-types.ts';

export type RepoDraft = { selection: string; priority: string; image: string };

/** The fields of a repository's settings form that differ from what's saved, as a PUT body. */
export function repoChanges(repo: Pick<RepoView, 'selection' | 'priority' | 'image'>, draft: RepoDraft): Record<string, string | number> {
  const body: Record<string, string | number> = {};
  if (draft.selection !== repo.selection) body.selection = draft.selection;
  if (Number(draft.priority) !== repo.priority) body.priority = Number(draft.priority);
  if (draft.image.trim() !== (repo.image ?? '')) body.image = draft.image.trim();
  return body;
}
