import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  createBulkhead,
  type RejectReason,
  type Stats,
  type Token,
} from "async-bulkhead-ts";

export interface ExpressBulkheadStats {
  name?: string;
  inFlight: number;
  pending: number;
  maxConcurrent: number;
  maxQueue: number;
  closed: boolean;
}

export type ExpressBulkheadRejectReason =
  | "bulkhead_rejected"
  | "bulkhead_closed"
  | "queue_timeout"
  | "request_aborted";

export type ExpressBulkheadReleaseCause = "finish" | "close";

export type ExpressBulkheadPathMode = "path" | "originalUrl" | "route";

export type ExpressBulkheadMetadata = Record<string, unknown>;

interface ExpressBulkheadEventBase extends ExpressBulkheadStats {
  method: string;
  path: string;
  route?: string;
  metadata?: ExpressBulkheadMetadata;
}

export interface ExpressBulkheadAdmitEvent extends ExpressBulkheadEventBase {
  admittedAt: number;
  queued: boolean;
  waitMs: number;
}

export interface ExpressBulkheadRejectEvent extends ExpressBulkheadEventBase {
  rejectedAt: number;
  reason: ExpressBulkheadRejectReason;
}

export interface ExpressBulkheadReleaseEvent extends ExpressBulkheadEventBase {
  releasedAt: number;
  durationMs: number;
  releaseCause: ExpressBulkheadReleaseCause;
}

export interface ExpressBulkheadRejectResponseContext extends ExpressBulkheadRejectEvent {
  req: Request;
  res: Response;
}

export interface ExpressBulkheadOptions {
  name?: string;
  maxConcurrent: number;
  maxQueue?: number;

  /** Maximum time a queued request may wait for capacity. Applies to queue wait only. */
  queueWaitTimeoutMs?: number;

  /** Abort queued acquisition when the client disconnects. Defaults to true. */
  abortOnClientClose?: boolean;

  /** Skip bulkhead admission for selected requests, such as health checks or CORS preflight. */
  skip?: (req: Request) => boolean;

  /** Controls the high-level path string attached to hook events. Defaults to `path`. */
  pathMode?: ExpressBulkheadPathMode;

  /** Stable low-cardinality route label for observability. */
  routeLabel?: string | ((req: Request) => string | undefined);

  /** Request-scoped metadata attached to hook events and reject-response context. */
  metadata?: (req: Request) => ExpressBulkheadMetadata | undefined;

  /** Custom overload response. If it does not send a response, the default 503 body is used. */
  rejectResponse?: (
    context: ExpressBulkheadRejectResponseContext,
  ) => void | Promise<void>;

  onAdmit?: (event: ExpressBulkheadAdmitEvent) => void;
  onReject?: (event: ExpressBulkheadRejectEvent) => void;
  onRelease?: (event: ExpressBulkheadReleaseEvent) => void;
}

export interface ExpressBulkhead {
  middleware(): RequestHandler;
  stats(): ExpressBulkheadStats;
  close(): void;
  drain(): Promise<void>;
}

function mapStats(
  name: string | undefined,
  stats: Stats,
): ExpressBulkheadStats {
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
    case "shutdown":
      return "bulkhead_closed";
    case "timeout":
      return "queue_timeout";
    case "aborted":
      return "request_aborted";
    case "concurrency_limit":
    case "queue_limit":
      return "bulkhead_rejected";
  }
  return "bulkhead_rejected";
}

function getObservedPath(req: Request, mode: ExpressBulkheadPathMode): string {
  if (mode === "route") return getRoute(req) ?? getObservedPath(req, "path");
  if (mode === "originalUrl") {
    if (typeof req.originalUrl === "string" && req.originalUrl.length > 0)
      return req.originalUrl;
  }
  if (typeof req.path === "string" && req.path.length > 0) return req.path;
  return req.url;
}

function stringifyRoutePath(routePath: unknown): string | undefined {
  if (typeof routePath === "string") return routePath;
  if (routePath instanceof RegExp) return routePath.toString();
  if (Array.isArray(routePath)) {
    const parts = routePath
      .map((part) => stringifyRoutePath(part))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("|") : undefined;
  }
  return undefined;
}

function joinRoutePath(baseUrl: string | undefined, routePath: string): string {
  const base = baseUrl && baseUrl !== "/" ? baseUrl.replace(/\/$/, "") : "";
  const route = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${base}${route}` || "/";
}

function getRoute(
  req: Request,
  routeLabel?: ExpressBulkheadOptions["routeLabel"],
): string | undefined {
  if (typeof routeLabel === "string") return routeLabel;
  if (typeof routeLabel === "function") {
    try {
      return routeLabel(req);
    } catch {
      return undefined;
    }
  }

  const routePath = stringifyRoutePath(req.route?.path);
  return routePath ? joinRoutePath(req.baseUrl, routePath) : undefined;
}

function getMetadata(
  req: Request,
  metadata?: ExpressBulkheadOptions["metadata"],
): ExpressBulkheadMetadata | undefined {
  if (!metadata) return undefined;
  try {
    return metadata(req);
  } catch {
    return undefined;
  }
}

function callHook<T>(hook: ((event: T) => void) | undefined, event: T): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    // Hook exceptions must not break request flow.
  }
}

function responseClosed(req: Request, res: Response): boolean {
  return req.destroyed || res.destroyed || res.writableEnded;
}

function defaultReject(
  res: Response,
  reason: ExpressBulkheadRejectReason,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(503).json({ error: "service_unavailable", reason });
}

function validateOptions(options: ExpressBulkheadOptions): void {
  if (options.queueWaitTimeoutMs !== undefined) {
    if (
      !Number.isFinite(options.queueWaitTimeoutMs) ||
      options.queueWaitTimeoutMs < 0
    ) {
      throw new Error("queueWaitTimeoutMs must be a finite number >= 0");
    }
  }
}

export function createExpressBulkhead(
  options: ExpressBulkheadOptions,
): ExpressBulkhead {
  validateOptions(options);

  const bulkhead = createBulkhead({
    maxConcurrent: options.maxConcurrent,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
  });
  const stats = (): ExpressBulkheadStats =>
    mapStats(options.name, bulkhead.stats());
  const pathMode = options.pathMode ?? "path";
  const abortOnClientClose = options.abortOnClientClose ?? true;

  const eventBase = (req: Request): ExpressBulkheadEventBase => {
    const route = getRoute(req, options.routeLabel);
    const metadata = getMetadata(req, options.metadata);
    const path =
      pathMode === "route"
        ? (route ?? getObservedPath(req, "path"))
        : getObservedPath(req, pathMode);
    return {
      ...stats(),
      method: req.method,
      path,
      ...(route !== undefined ? { route } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
  };

  const handleReject = async (
    req: Request,
    res: Response,
    next: NextFunction,
    event: ExpressBulkheadRejectEvent,
  ): Promise<void> => {
    callHook(options.onReject, event);

    if (event.reason === "request_aborted" || responseClosed(req, res)) return;

    if (options.rejectResponse) {
      try {
        await options.rejectResponse({ ...event, req, res });
      } catch (err) {
        next(err);
        return;
      }

      if (responseClosed(req, res) || res.headersSent) return;
    }

    defaultReject(res, event.reason);
  };

  const middleware = (): RequestHandler => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (options.skip?.(req)) {
          next();
          return;
        }
      } catch (err) {
        next(err);
        return;
      }

      const acquireStartedAt = Date.now();
      const queued = stats().inFlight >= options.maxConcurrent;
      const abortController = abortOnClientClose
        ? new AbortController()
        : undefined;
      let closedBeforeAdmission = false;

      const abortAcquire = (): void => {
        closedBeforeAdmission = true;
        abortController?.abort();
      };

      if (abortController) {
        req.once("aborted", abortAcquire);
        res.once("close", abortAcquire);
      }

      const cleanupAcquireAbort = (): void => {
        if (!abortController) return;
        req.off("aborted", abortAcquire);
        res.off("close", abortAcquire);
      };

      const acquireResult = await bulkhead.acquire({
        ...(abortController ? { signal: abortController.signal } : {}),
        ...(options.queueWaitTimeoutMs !== undefined
          ? { timeoutMs: options.queueWaitTimeoutMs }
          : {}),
      });

      cleanupAcquireAbort();

      if (!acquireResult.ok) {
        const event: ExpressBulkheadRejectEvent = {
          ...eventBase(req),
          rejectedAt: Date.now(),
          reason: mapRejectReason(acquireResult.reason),
        };
        await handleReject(req, res, next, event);
        return;
      }

      const token: Token = acquireResult.token;
      const admittedAt = Date.now();

      if (closedBeforeAdmission || responseClosed(req, res)) {
        token.release();
        return;
      }

      let released = false;
      const release = (releaseCause: ExpressBulkheadReleaseCause): void => {
        if (released) return;
        released = true;
        token.release();
        const releasedAt = Date.now();
        const event: ExpressBulkheadReleaseEvent = {
          ...eventBase(req),
          releasedAt,
          durationMs: releasedAt - admittedAt,
          releaseCause,
        };
        callHook(options.onRelease, event);
      };

      res.once("finish", () => release("finish"));
      res.once("close", () => release("close"));

      callHook(options.onAdmit, {
        ...eventBase(req),
        admittedAt,
        queued,
        waitMs: admittedAt - acquireStartedAt,
      });

      next();
    };
  };

  return {
    middleware,
    stats,
    close: () => bulkhead.close(),
    drain: () => bulkhead.drain(),
  };
}

export function createBulkheadMiddleware(
  options: ExpressBulkheadOptions,
): RequestHandler {
  return createExpressBulkhead(options).middleware();
}
``;
