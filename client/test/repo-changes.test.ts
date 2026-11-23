import { describe, expect, it } from 'vitest';
import { repoChanges } from '../src/repo-settings.ts';

const repo = { selection: 'nominated' as const, priority: 0, image: null, mergeWithoutReview: false };
const draft = { selection: 'nominated', priority: '0', image: '', mergeWithoutReview: false };

describe('repoChanges', () => {
  it('is empty when nothing differs from what is saved', () => {
    expect(repoChanges(repo, draft)).toEqual({});
    expect(repoChanges({ ...repo, image: 'a:1' }, { ...draft, image: ' a:1 ' })).toEqual({});
    expect(repoChanges({ ...repo, mergeWithoutReview: true }, { ...draft, mergeWithoutReview: true })).toEqual({});
  });

  it('sends only the fields that changed', () => {
    expect(repoChanges(repo, { ...draft, selection: 'all', priority: '3' })).toEqual({ selection: 'all', priority: 3 });
    expect(repoChanges({ ...repo, image: 'a:1' }, draft)).toEqual({ image: '' });
    expect(repoChanges(repo, { ...draft, mergeWithoutReview: true })).toEqual({ mergeWithoutReview: true });
    expect(repoChanges({ ...repo, mergeWithoutReview: true }, draft)).toEqual({ mergeWithoutReview: false });
  });
});
