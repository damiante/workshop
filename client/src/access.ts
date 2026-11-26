import type { RunView } from '../../server/src/api-types.ts';
import { AGENT_LABEL, runSubject } from './format.ts';

/** Lifetimes offered when creating an API token; null never expires. */
export const TOKEN_LIFETIMES: { label: string; minutes: number | null }[] = [
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
  { label: '1 day', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
  { label: '30 days', minutes: 43200 },
  { label: 'Never', minutes: null },
];

/** The text to paste into Claude Code so it can look into a run with a read-only token. */
export function claudeBrief({ origin, token, expiresAt, run }: { origin: string; token: string; expiresAt: number; run: Pick<RunView, 'id' | 'ticketId' | 'ticket' | 'repo' | 'task' | 'agent' | 'status'> }) {
  const curl = (path: string) => `curl -H "Authorization: Bearer $TOKEN" $WORKSHOP/api/${path}`;
  return [
    `Help me find out what went wrong in my Workshop instance at ${origin}.`,
    run.task
      ? `Look at run ${run.id} (${AGENT_LABEL[run.agent]} on ${runSubject(run).text}, status ${run.status}).`
      : `Look at run ${run.id} (${AGENT_LABEL[run.agent]} on ${run.ticket}, status ${run.status}).`,
    '',
    `Use this read-only API token. It expires ${new Date(expiresAt).toISOString()}:`,
    `export WORKSHOP=${origin}`,
    `export TOKEN=${token}`,
    'Send it on every request: -H "Authorization: Bearer $TOKEN"',
    '',
    'The API is described at $WORKSHOP/api/openapi.json. Start with:',
    curl(`runs/${run.id}`),
    curl(`runs/${run.id}/export`),
    run.task ? curl(`tasks/${run.task.id}`) : curl(`tickets/${run.ticketId}`),
    curl('alerts'),
  ].join('\n');
}
