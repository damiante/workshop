import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionView, ProviderInfo } from '../../server/src/api-types.ts';
// api.ts opens the live stream on import, which needs a browser.
vi.mock('../src/api.ts', () => ({ api: vi.fn(), useApi: vi.fn() }));

import { ConnectionItem } from '../src/pages/Connections.tsx';

const connection = (kind: ConnectionView['kind']): ConnectionView => ({
  id: 42, kind, provider: 'p', name: 'Box', config: {}, secrets: {}, status: 'ok', checkedAt: null, error: null, paused: false,
});
const provider = (kind: ConnectionView['kind']): ProviderInfo => ({ id: 'p', kind, name: 'P', description: '', fields: [] });

describe('ConnectionItem', () => {
  it('shows a host its ID, for use with the API', () => {
    const html = renderToStaticMarkup(<ConnectionItem c={connection('environment')} provider={provider('environment')} onEdit={() => {}} />);
    expect(html).toContain('Host ID <code>42</code>');
  });

  it('shows no host ID for other connections', () => {
    const html = renderToStaticMarkup(<ConnectionItem c={connection('model')} provider={provider('model')} onEdit={() => {}} />);
    expect(html).not.toContain('Host ID');
  });
});
