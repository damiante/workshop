import { describe, expect, it } from 'vitest';
import type { TicketSpend } from '../../server/src/api-types.ts';
import { DEFAULT_TICKET_SORT, filterTickets, nextSort, sortTickets } from '../src/ticket-usage.ts';

const t = (number: number, costUsd: number, inputTokens: number, outputTokens: number, title: string | null = null, repo = 'me/app'): TicketSpend => ({
  repo,
  number,
  title,
  url: null,
  runs: 1,
  inputTokens,
  outputTokens,
  costUsd,
});

const tickets = [t(1, 5, 100, 30, 'Fix the login page'), t(2, 3, 300, 10, 'Usage page: sort tickets'), t(3, 1, 200, 20, null, 'you/site')];
const numbers = (list: TicketSpend[]) => list.map((x) => x.number);

describe('sortTickets', () => {
  it('sorts by any column in either direction without changing its input', () => {
    expect(numbers(sortTickets(tickets, DEFAULT_TICKET_SORT))).toEqual([1, 2, 3]);
    expect(numbers(sortTickets(tickets, { key: 'costUsd', desc: false }))).toEqual([3, 2, 1]);
    expect(numbers(sortTickets(tickets, { key: 'inputTokens', desc: true }))).toEqual([2, 3, 1]);
    expect(numbers(sortTickets(tickets, { key: 'outputTokens', desc: false }))).toEqual([2, 3, 1]);
    expect(numbers(tickets)).toEqual([1, 2, 3]);
  });

  it('keeps the given order for ties', () => {
    expect(numbers(sortTickets([t(1, 1, 5, 0), t(2, 2, 5, 0), t(3, 3, 5, 0)], { key: 'inputTokens', desc: true }))).toEqual([1, 2, 3]);
  });
});

describe('nextSort', () => {
  it('flips the sorted column and starts a new one biggest first', () => {
    expect(nextSort(DEFAULT_TICKET_SORT, 'costUsd')).toEqual({ key: 'costUsd', desc: false });
    expect(nextSort({ key: 'costUsd', desc: false }, 'costUsd')).toEqual({ key: 'costUsd', desc: true });
    expect(nextSort({ key: 'costUsd', desc: false }, 'inputTokens')).toEqual({ key: 'inputTokens', desc: true });
  });
});

describe('filterTickets', () => {
  it('matches the repository, number and title, ignoring case and word order', () => {
    expect(numbers(filterTickets(tickets, ''))).toEqual([1, 2, 3]);
    expect(numbers(filterTickets(tickets, '  '))).toEqual([1, 2, 3]);
    expect(numbers(filterTickets(tickets, 'PAGE'))).toEqual([1, 2]);
    expect(numbers(filterTickets(tickets, 'tickets usage'))).toEqual([2]);
    expect(numbers(filterTickets(tickets, 'you/site'))).toEqual([3]);
    expect(numbers(filterTickets(tickets, 'app#2'))).toEqual([2]);
    expect(numbers(filterTickets(tickets, 'nothing'))).toEqual([]);
  });
});
