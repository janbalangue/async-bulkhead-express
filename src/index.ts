import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createBulkhead, type RejectReason, type Stats, type Token } from 'async-bulkhead-ts';

export interface ExpressBulkheadStats {
  name?: string;
  inFlight: number;
  pending: number;
  maxConcurrent: number;
  maxQueue: number;
  closed: boolean;
}

interface ExpressBulkheadEventBase extends ExpressBulkheadStats {
  method: string;
  path: string;
  route?: string;
}

export interface ExpressBulkheadAdmitEvent extends ExpressBulkheadEventBase {
  admittedAt: number;
  queued: boolean;
  waitMs: number;
}

export type ExpressBulkheadRejectReason = 'bulkhead_rejected' | 'bulkhead_closed' | 'queue_timeout';

export interface ExpressBulkheadRejectEvent extends ExpressBulkheadEventBase {
  rejectedAt: number;
  reason: ExpressBulkheadRejectReason;
}

export interface ExpressBulkheadReleaseEvent extends ExpressBulkheadEventBase {
  releasedAt: number;
  durationMs: number;
  releaseCause: 'finish' | 'close';
}

export interface ExpressBulkheadOptions {
  name?: string;
  maxConcurrent: number;
  maxQueue?: number;
  onAdmit?: (event: ExpressBulkheadAdmitEvent) => void;
  onReject?: (event: ExpressBulkheadRejectEvent) => void;
  onRelease?: (event: ExpressBulkheadReleaseEvent) => void;
}

export interface ExpressBulkhead {
  middleware(): RequestHandler;
  stats(): ExpressBulkheadStats;
}

function mapStats(name: string | undefined, stats: Stats): ExpressBulkheadStats {
  return {
    ...(name !== undefined ? { name } : {}),
    inFlight: stats.inFlight,
    pending: stats.pending,
    maxConcurrent: stats.maxConcurrent,
    maxQueue: stats.maxQueue,
    closed: stats.closed,
  };
}

function mapRejectReason(reason: RejectReason): ExpressBulkheadRejectReason {
  switch (reason) {
    case 'shutdown':
      return 'bulkhead_closed';
    case 'timeout':
      return 'queue_timeout';
    case 'concurrency_limit':
    case 'queue_limit':
    case 'aborted':
      return 'bulkhead_rejected';
  }
}

function getObservedPath(req: Request): string {
  if (typeof req.originalUrl === 'string' && req.originalUrl.length > 0) return req.originalUrl;
  if (typeof req.path === 'string' && req.path.length > 0) return req.path;
  return req.url;
}

function getRoute(req: Request): string | undefined {
  return typeof req.route?.path === 'string' ? req.route.path : undefined;
}

function callHook<T>(hook: ((event: T) => void) | undefined, event: T): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    // Hook exceptions must not break request flow.
  }
}

function defaultReject(res: Response, reason: ExpressBulkheadRejectReason): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(503).json({ error: 'service_unavailable', reason });
}

export function createExpressBulkhead(options: ExpressBulkheadOptions): ExpressBulkhead {
  const bulkhead = createBulkhead({ name: options.name, maxConcurrent: options.maxConcurrent, maxQueue: options.maxQueue });
  const stats = (): ExpressBulkheadStats => mapStats(options.name, bulkhead.stats());

  const middleware = (): RequestHandler => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const admittedAt = Date.now();
      const acquireResult = await bulkhead.acquire();

      if (!acquireResult.ok) {
        const event: ExpressBulkheadRejectEvent = {
          ...stats(),
          method: req.method,
          path: getObservedPath(req),
          route: getRoute(req),
          rejectedAt: Date.now(),
          reason: mapRejectReason(acquireResult.reason),
        };
        callHook(options.onReject, event);
        defaultReject(res, event.reason);
        return;
      }

      const token: Token = acquireResult.token;
      let released = false;
      const release = (releaseCause: 'finish' | 'close'): void => {
        if (released) return;
        released = true;
        token.release();
        const releasedAt = Date.now();
        const event: ExpressBulkheadReleaseEvent = {
          ...stats(),
          method: req.method,
          path: getObservedPath(req),
          route: getRoute(req),
          releasedAt,
          durationMs: releasedAt - admittedAt,
          releaseCause,
        };
        callHook(options.onRelease, event);
      };

      res.once('finish', () => release('finish'));
      res.once('close', () => release('close'));

      callHook(options.onAdmit, {
        ...stats(),
        method: req.method,
        path: getObservedPath(req),
        route: getRoute(req),
        admittedAt,
        queued: false,
        waitMs: 0,
      });

      next();
    };
  };

  return { middleware, stats };
}

export function createBulkheadMiddleware(options: ExpressBulkheadOptions): RequestHandler {
  return createExpressBulkhead(options).middleware();
}
