import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../src/markdown.ts';

describe('parseMarkdown', () => {
  it('reads the issue example: a paragraph then a list', () => {
    const tree = parseMarkdown('**The setting**\n- Each user gets **Target selection** and `code`.\n- It is saved');
    expect(tree).toEqual([
      { t: 'p', children: [{ t: 'strong', children: ['The setting'] }] },
      {
        t: 'list',
        ordered: false,
        start: 1,
        items: [
          [
            {
              t: 'p',
              children: ['Each user gets ', { t: 'strong', children: ['Target selection'] }, ' and ', { t: 'code', text: 'code' }, '.'],
            },
          ],
          [{ t: 'p', children: ['It is saved'] }],
        ],
      },
    ]);
  });

  it('reads headings and ignores #nospace', () => {
    for (let n = 1; n <= 6; n++) {
      expect(parseMarkdown(`${'#'.repeat(n)} Title ##`)).toEqual([{ t: 'h', level: n, children: ['Title'] }]);
    }
    expect(parseMarkdown('#nospace')[0].t).toBe('p');
  });

  it('nests lists at two and four spaces', () => {
    for (const pad of ['  ', '    ']) {
      const [list] = parseMarkdown(`- a\n${pad}- b\n- c`);
      expect(list).toMatchObject({ t: 'list' });
      if (list.t !== 'list') throw new Error();
      expect(list.items).toHaveLength(2);
      expect(list.items[0].map((b) => b.t)).toEqual(['p', 'list']);
    }
  });

  it('reads ordered lists, loose lists and non-lists', () => {
    expect(parseMarkdown('3. a\n4. b')[0]).toMatchObject({ t: 'list', ordered: true, start: 3 });
    expect(parseMarkdown('1) a\n2) b')[0]).toMatchObject({ t: 'list', ordered: true, start: 1 });
    const loose = parseMarkdown('- a\n\n- b');
    expect(loose).toHaveLength(1);
    expect(loose[0]).toMatchObject({ t: 'list' });
    expect(parseMarkdown('text\n2024. Was busy')).toHaveLength(1);
    expect(parseMarkdown('2024. Was busy')[0].t).toBe('list');
  });

  it('keeps fenced code verbatim', () => {
    expect(parseMarkdown('```ts\n**a**\n\n<b>\n```')).toEqual([{ t: 'code', lang: 'ts', text: '**a**\n\n<b>' }]);
    expect(parseMarkdown('```\nopen\nforever')).toEqual([{ t: 'code', lang: '', text: 'open\nforever' }]);
    const [list] = parseMarkdown('- step\n  ```\n  x\n  ```');
    if (list.t !== 'list') throw new Error();
    expect(list.items[0].map((b) => b.t)).toEqual(['p', 'code']);
  });

  it('reads quotes and rules', () => {
    const [quote] = parseMarkdown('> - a\n> - b');
    expect(quote).toMatchObject({ t: 'quote' });
    if (quote.t !== 'quote') throw new Error();
    expect(quote.children[0].t).toBe('list');
    expect(parseMarkdown('---')).toEqual([{ t: 'hr' }]);
    expect(parseMarkdown('* * *')).toEqual([{ t: 'hr' }]);
  });

  it('reads tables', () => {
    const [table] = parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| x \\| y | 2 |');
    expect(table).toEqual({
      t: 'table',
      align: ['left', 'center', 'right'],
      head: [['a'], ['b'], ['c']],
      rows: [[['x | y'], ['2'], []]],
    });
    expect(parseMarkdown('a | b\nc | d')[0].t).toBe('p');
  });
});

describe('parseInline', () => {
  it('leaves non-emphasis alone', () => {
    expect(parseInline('snake_case_name')).toEqual(['snake_case_name']);
    expect(parseInline('2 * 3 * 4')).toEqual(['2 * 3 * 4']);
    expect(parseInline('**open')).toEqual(['**open']);
  });

  it('handles escapes, code, strikethrough and breaks', () => {
    expect(parseInline('\\*x\\*')).toEqual(['*x*']);
    expect(parseInline('`` a`b ``')).toEqual([{ t: 'code', text: 'a`b' }]);
    expect(parseInline('~~gone~~')).toEqual([{ t: 'del', children: ['gone'] }]);
    expect(parseInline('a\nb')).toEqual(['a', { t: 'br' }, 'b']);
    expect(parseInline('*it* and _it_')).toEqual([{ t: 'em', children: ['it'] }, ' and ', { t: 'em', children: ['it'] }]);
  });

  it('links only safe URLs', () => {
    expect(parseInline('[a](https://x)')).toEqual([{ t: 'link', href: 'https://x', children: ['a'] }]);
    expect(parseInline('[a](javascript:alert(1))')).toEqual(['a']);
    expect(parseInline('see https://github.com/o/r/pull/1).')).toEqual([
      'see ',
      { t: 'link', href: 'https://github.com/o/r/pull/1', children: ['https://github.com/o/r/pull/1'] },
      ').',
    ]);
    expect(parseInline('![shot](https://x/a.png)')).toEqual([{ t: 'link', href: 'https://x/a.png', children: ['shot'] }]);
  });
});
