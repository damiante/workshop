import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/components/Markdown.tsx';

describe('Markdown', () => {
  it('escapes HTML', () => {
    const html = renderToStaticMarkup(<Markdown text="<script>alert(1)</script>" />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders headings below the page headings', () => {
    expect(renderToStaticMarkup(<Markdown text="# T" />)).toContain('<h3>T</h3>');
  });

  it('opens links in a new tab', () => {
    const html = renderToStaticMarkup(<Markdown text="[a](https://x.test)" />);
    expect(html).toContain('href="https://x.test"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});
