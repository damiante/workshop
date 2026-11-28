import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/diff.ts';

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('shows a changed line as removed then added', () => {
    expect(lineDiff('x\nold\ny', 'x\nnew\ny')).toEqual([
      { kind: 'same', text: 'x' },
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
      { kind: 'same', text: 'y' },
    ]);
  });

  it('handles an empty side', () => {
    expect(lineDiff('', 'a\nb')).toEqual([
      { kind: 'added', text: 'a' },
      { kind: 'added', text: 'b' },
    ]);
    expect(lineDiff('a', '')).toEqual([{ kind: 'removed', text: 'a' }]);
    expect(lineDiff('', '')).toEqual([]);
  });
});
