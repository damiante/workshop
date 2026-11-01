import { describe, expect, it } from 'vitest';
import type { TarEntry } from '../src/providers/docker/tar.ts';
import { checkAgentFile, captionLine, cleanCaption, imageKey, isGitHubImageUrl, isGitHubRedirect, MAX_FILE, replaceImageLinks, screenshotsLine, sniffImage, validName } from '../src/workflow/media.ts';
import { imageRefs } from '../src/providers/github/index.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const UUID = '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

const file = (name: string, content: Buffer | string, type: TarEntry['type'] = 'file'): TarEntry => ({ name, type, content: Buffer.from(content) });

describe('sniffImage', () => {
  it('recognises the four formats by their bytes', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('jpeg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(Buffer.from('<svg></svg>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('validName', () => {
  it('accepts plain file names only', () => {
    expect(validName('after-1.png')).toBe(true);
    for (const bad of ['', '..', 'a..png', '../x.png', '.hidden.png', 'a/b.png', 'a b.png', 'x'.repeat(81)]) expect(validName(bad)).toBe(false);
  });
});

describe('GitHub image URLs', () => {
  it('fetches only GitHub image hosts', () => {
    expect(isGitHubImageUrl('https://private-user-images.githubusercontent.com/1/2-x.png?jwt=a')).toBe(true);
    expect(isGitHubImageUrl('https://user-images.githubusercontent.com/1/x.png')).toBe(true);
    expect(isGitHubImageUrl(`https://github.com/user-attachments/assets/${UUID}`)).toBe(true);
    for (const bad of ['http://user-images.githubusercontent.com/x.png', 'https://github.com/me/app/x.png', 'https://evil.example/user-attachments/x.png', 'https://user-images.githubusercontent.com.evil.example/x.png', 'file:///etc/passwd', 'nonsense']) {
      expect(isGitHubImageUrl(bad)).toBe(false);
    }
  });

  it('follows redirects only to GitHub storage', () => {
    expect(isGitHubRedirect('https://objects.githubusercontent.com/abc')).toBe(true);
    expect(isGitHubRedirect('https://github-production-user-asset-6210df.s3.amazonaws.com/1/x.png')).toBe(true);
    expect(isGitHubRedirect('https://evil.s3.amazonaws.com/x.png')).toBe(false);
    expect(isGitHubRedirect('http://objects.githubusercontent.com/abc')).toBe(false);
    expect(isGitHubRedirect('http://169.254.169.254/latest')).toBe(false);
  });

  it('gives the same key to the markdown and signed URLs of one attachment', () => {
    const a = imageKey(`https://github.com/user-attachments/assets/${UUID.toUpperCase()}`);
    const b = imageKey(`https://private-user-images.githubusercontent.com/123/456-${UUID}.png?jwt=zzz`);
    expect(a).toBe(UUID);
    expect(b).toBe(UUID);
    expect(imageKey('https://user-images.githubusercontent.com/1/x.png?a=1')).toBe('user-images.githubusercontent.com/1/x.png');
  });
});

describe('imageRefs', () => {
  it('reads allowed images from rendered HTML', () => {
    const html = [
      `<p><img src="https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=a&amp;b=c" alt="x"></p>`,
      `<img src="https://camo.githubusercontent.com/abc" data-canonical-src="https://user-images.githubusercontent.com/9/y.png">`,
      '<img src="https://evil.example/pixel.png">',
      `<img src="https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=other">`,
    ].join('');
    const refs = imageRefs(html);
    expect(refs).toEqual([
      { url: `https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=a&b=c`, key: UUID },
      { url: 'https://user-images.githubusercontent.com/9/y.png', key: 'user-images.githubusercontent.com/9/y.png' },
    ]);
    expect(imageRefs('')).toEqual([]);
  });
});

describe('checkAgentFile', () => {
  it('accepts a real image under media/', () => {
    expect(checkAgentFile(file('media/a.png', PNG), undefined, 0)).toEqual({ ok: true });
  });

  it('rejects links, folders, odd names, wrong types and contents that are not the claimed image', () => {
    const reason = (e: TarEntry, existing?: { source: string; size: number }, used = 0) => {
      const r = checkAgentFile(e, existing, used);
      return r.ok ? null : r.reason;
    };
    expect(reason(file('media/a.png', '', 'link'))).toMatch(/link/);
    expect(reason(file('media/sub/', '', 'dir'))).toMatch(/subfolders/);
    expect(reason(file('media/sub/a.png', PNG))).toMatch(/subfolders/);
    expect(reason(file('/etc/a.png', PNG))).toMatch(/outside/);
    expect(reason(file('media/../a.png', PNG))).toBeTruthy();
    expect(reason(file('media/a..png', PNG))).toBeTruthy();
    expect(reason(file('media/a.svg', '<svg/>'))).toMatch(/only png/);
    expect(reason(file('media/a.png', 'not an image'))).toMatch(/aren't a PNG/);
    expect(reason(file('media/a.jpg', PNG))).toMatch(/aren't a JPEG/);
    expect(reason(file('media/a.png', Buffer.concat([PNG, Buffer.alloc(MAX_FILE)])))).toMatch(/10 MB/);
    expect(reason(file('media/a.png', PNG), { source: 'issue', size: 5 })).toMatch(/issue/);
  });

  it('counts only the size difference when replacing a file', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(1000)]);
    const used = 100 * 1024 * 1024 - 10;
    expect(checkAgentFile(file('media/a.png', big), undefined, used).ok).toBe(false);
    expect(checkAgentFile(file('media/a.png', big), { source: 'Implementation', size: big.length }, used).ok).toBe(true);
  });
});

describe('prompt and PR text', () => {
  it('replaces GitHub image links with local paths and leaves others alone', () => {
    const byKey = new Map([[UUID, 'issue-1.png']]);
    const text = `![](https://github.com/user-attachments/assets/${UUID}) and <img src="https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=a"> and ![](https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111) and ![](https://evil.example/${UUID}.png)`;
    expect(replaceImageLinks(text, byKey)).toBe(
      `![](/work/media/issue-1.png) and <img src="/work/media/issue-1.png"> and ![](https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111) and ![](https://evil.example/${UUID}.png)`,
    );
  });

  it('links at most 20 screenshots and says how many more there are', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({ name: `s${i}.png`, caption: null }));
    const line = screenshotsLine(items, 'https://w.example', 3);
    expect(line.match(/\/media\/s\d+\.png/g)).toHaveLength(20);
    expect(line).toContain('3 more on the page');
  });

  it('cleans captions, keeping line breaks', () => {
    expect(cleanCaption('a\r\n\r\n\r\n  b   c \n[d]')).toBe('a\n\nb c\n[d]');
    expect(cleanCaption('x'.repeat(1200))).toHaveLength(1000);
  });

  it('makes a caption one line', () => {
    expect(captionLine('a\n\n b')).toBe('a b');
    const cut = captionLine('x'.repeat(200), 120);
    expect(cut).toHaveLength(120);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('builds the Screenshots line, with a fallback when there is no public URL', () => {
    const items = [{ name: 'a.png', caption: 'Dark [mode]' }, { name: 'b.png', caption: null }, { name: 'c.png', caption: 'Line one\nline two' }];
    expect(screenshotsLine([], 'https://w.example', 3)).toBe('');
    expect(screenshotsLine(items, null, 3)).toBe('**Screenshots:** open this ticket in Workshop');
    expect(screenshotsLine(items, 'https://w.example/', 3)).toBe(
      '**Screenshots:** [all screenshots](https://w.example/tickets/3/media) · [Dark mode](https://w.example/api/tickets/3/media/a.png) · [b.png](https://w.example/api/tickets/3/media/b.png) · [Line one line two](https://w.example/api/tickets/3/media/c.png)',
    );
  });
});
