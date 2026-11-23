import { describe, expect, it } from 'vitest';
import { repoChanges } from '../src/repo-settings.ts';

const repo = { selection: 'nominated' as const, priority: 0, image: null };

describe('repoChanges', () => {
  it('is empty when nothing differs from what is saved', () => {
    expect(repoChanges(repo, { selection: 'nominated', priority: '0', image: '' })).toEqual({});
    expect(repoChanges({ ...repo, image: 'a:1' }, { selection: 'nominated', priority: '0', image: ' a:1 ' })).toEqual({});
  });

  it('sends only the fields that changed', () => {
    expect(repoChanges(repo, { selection: 'all', priority: '3', image: '' })).toEqual({ selection: 'all', priority: 3 });
    expect(repoChanges({ ...repo, image: 'a:1' }, { selection: 'nominated', priority: '0', image: '' })).toEqual({ image: '' });
  });
});
