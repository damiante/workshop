import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { Topic } from './api-types.ts';

/** In-process pub/sub. Topics tell the browser which views to refetch. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(topic: Topic) {
  bus.emit('topic', topic);
}

/** Starts a Server-Sent Events response; returns a function that sends one event. */
export function openSse(res: Response, onClose: () => void) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    onClose();
  });
  return (data: unknown, id?: number) => {
    res.write(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
  };
}
