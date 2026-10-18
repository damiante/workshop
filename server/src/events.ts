import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { Topic } from './api-types.ts';

/** In-process pub/sub. Topics tell the browser which views to refetch. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(topic: Topic) {
  bus.emit('topic', topic);
}

export const HEARTBEAT_MS = 15_000;

/** Starts a Server-Sent Events response; returns a function that sends one event. */
export function openSse(res: Response, onClose: () => void) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  // A named event, so page code can see it (an SSE comment is invisible to JavaScript) and tell a silent stream from a quiet one.
  const ping = () => res.write('event: ping\ndata: {}\n\n');
  ping();
  const heartbeat = setInterval(ping, HEARTBEAT_MS);
  res.on('error', () => {}); // a write after the client left is not worth crashing for
  res.on('close', () => {
    clearInterval(heartbeat);
    onClose();
  });
  return (data: unknown, id?: number, event?: string) => {
    res.write(`${event ? `event: ${event}\n` : ''}${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
  };
}
