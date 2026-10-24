import { describe, expect, it, vi } from 'vitest';
import { STAGES } from '../../server/src/workflow/labels.ts';
import type { TicketView } from '../../server/src/api-types.ts';

// The page module touches `document` on import; the columns are pure.
vi.stubGlobal('document', { addEventListener: () => {} });
vi.stubGlobal('window', { addEventListener: () => {}, location: { protocol: 'http:', host: 'x' } });
const { COLUMNS } = await import('../src/pages/Tickets.tsx');

describe('ticket board columns', () => {
  it('shows a ticket in every stage, including reconcile', () => {
    for (const stage of STAGES) {
      const t = { stage } as TicketView;
      expect(COLUMNS.filter((c) => c.match(t)).length, stage).toBe(1);
    }
  });
});
