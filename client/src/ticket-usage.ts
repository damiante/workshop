import type { TicketSpend } from '../../server/src/api-types.ts';

/** How many tickets the Usage page's cost per ticket shows at once. */
export const TICKETS_SHOWN = 10;

export type TicketSortKey = 'inputTokens' | 'outputTokens' | 'costUsd';
export interface TicketSort {
  key: TicketSortKey;
  desc: boolean;
}
export const DEFAULT_TICKET_SORT: TicketSort = { key: 'costUsd', desc: true };

/** Clicking the sorted column flips its direction; another column starts biggest first. */
export const nextSort = (sort: TicketSort, key: TicketSortKey): TicketSort => (sort.key === key ? { key, desc: !sort.desc } : { key, desc: true });

/** Tickets whose `owner/name#number` or title contain every word of `query`, ignoring case. */
export function filterTickets(tickets: TicketSpend[], query: string): TicketSpend[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return tickets;
  return tickets.filter((t) => {
    const text = `${t.repo}#${t.number} ${t.title ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** A sorted copy; ties keep the server's order, most expensive first. */
export const sortTickets = (tickets: TicketSpend[], sort: TicketSort): TicketSpend[] =>
  [...tickets].sort((a, b) => (sort.desc ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key]));
