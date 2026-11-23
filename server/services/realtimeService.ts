import type { Request, Response } from 'express';

export type RealtimeEventType =
  | 'connected'
  | 'message:created'
  | 'conversation:updated'
  | 'order:created'
  | 'order:updated';

interface SseClient {
  id: string;
  res: Response;
}

const clients = new Set<SseClient>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let clientSeq = 0;

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
    if (clients.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, 25_000);
  heartbeatTimer.unref?.();
}

export function attachSseClient(req: Request, res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const id = `sse_${++clientSeq}`;
  const client: SseClient = { id, res };
  clients.add(client);
  ensureHeartbeat();

  const helloPayload = JSON.stringify({ clientId: id, serverTime: new Date().toISOString() });
  res.write(`event: connected\ndata: ${helloPayload}\n\n`);

  const cleanup = () => {
    clients.delete(client);
    if (clients.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
}

export function emitRealtimeEvent(type: Exclude<RealtimeEventType, 'connected'>, payload: unknown): void {
  if (clients.size === 0) return;
  const serialized = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(serialized);
    } catch {
      clients.delete(client);
    }
  }
}

export function stopRealtimeHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const client of clients) {
    try {
      client.res.end();
    } catch {
      // Ignore already-closed responses
    }
  }
  clients.clear();
}
