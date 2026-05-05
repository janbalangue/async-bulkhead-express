import { performance } from "node:perf_hooks";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  createBulkhead,
  type RejectReason,
  type Stats,
  type Token,
} from "async-bulkhead-ts";

export type ExpressBulkheadRejectReason =
  | "bulkhead_rejected"
  | "bulkhead_closed"
  | "queue_timeout"
  | "request_aborted";

export interface ExpressBulkheadStats {
  name?: string;
  inFlight: number;
  pending: number;
  maxConcurrent: number;
  maxQueue: number;
  closed: boolean;
  totalAdmitted: number;
  totalReleased: number;
  rejected: number;
  rejectedByReason: Partial<Record<ExpressBulkheadRejectReason, number>>;
  aborted?: number;
  timedOut?: number;
  doubleRelease?: number;
  inFlightUnderflow?: number;
  hookErrors: number;
}

export type ExpressBulkheadReleaseCause = "finish" | "close";

export type ExpressBulkheadPathMode = "path" | "originalUrl" | "route";

export type ExpressBulkheadMetadata = Record<string, unknown>;

type ExpressBulkheadObservedPathMode = Exclude<
  ExpressBulkheadPathMode,
  "route"
>;

type ExpressBulkheadHook<T> = (event: T) => void | Promise<void>;

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

/**
 * Configuration for an Express bulkhead.
 *
 * Bulkheads in this package are local to the current Node.js process. If an app
 * runs multiple worker processes, containers, or pods, each one has its own
 * independent capacity pool. Size limits per process, not globally.
 *
 * Path and route fields are observability labels. Prefer stable,
 * low-cardinality values such as `GET /users/:id`; avoid raw user IDs, query
 * strings, tenant IDs, or other unbounded values in metric labels.
 */
export interface ExpressBulkheadOptions {
  name?: string;
  maxConcurrent: number;
  maxQueue?: number;

  /** Maximum time a queued request may wait for capacity. Applies to queue wait only. */
  queueWaitTimeoutMs?: number;

  /**
   * Abort queued acquisition when the HTTP connection closes before admission.
   * Defaults to true. This is based on the Node/Express response close lifecycle
   * for HTTP/1.1 requests handled by this process.
   */
  abortOnClientClose?: boolean;

  /** Skip bulkhead admission for selected requests, such as health checks or CORS preflight. */
  skip?: (req: Request) => boolean;

  /**
   * Controls the path string attached to hook events. Defaults to `path`.
   *
   * With router-level middleware mounted via `app.use('/api', bulkhead.middleware(), router)`,
   * the bulkhead can run before Express has selected a leaf route. In that case
   * `pathMode: 'route'` may fall back to `req.path` unless `routeLabel` is set.
   */
  pathMode?: ExpressBulkheadPathMode;

  /**
   * Stable low-cardinality route label for observability.
   *
   * Use this when middleware is mounted on a sub-router or when you want metric
   * labels such as `API router` or `GET /users/:id` instead of raw request paths.
   */
  routeLabel?: string | ((req: Request) => string | undefined);

  /**
   * Request-scoped metadata attached to hook events and reject-response context.
   *
   * Do not use metadata as metric labels unless the values are bounded; request
   * IDs and user IDs are better suited to logs/traces than time-series labels.
   */
  metadata?: (req: Request) => ExpressBulkheadMetadata | undefined;

  /** Custom overload response. If it does not send a response, the default 503 body is used. */
  rejectResponse?: (
    context: ExpressBulkheadRejectResponseContext,
  ) => void | Promise<void>;

  onAdmit?: ExpressBulkheadHook<ExpressBulkheadAdmitEvent>;
  onReject?: ExpressBulkheadHook<ExpressBulkheadRejectEvent>;
  onRelease?: ExpressBulkheadHook<ExpressBulkheadReleaseEvent>;
}

export interface ExpressBulkhead {
  middleware(): RequestHandler;
  stats(): ExpressBulkheadStats;
  close(): void;
  drain(): Promise<void>;
}

type StatsWithOptionalCounters = Stats & {
  totalAdmitted?: number;
  totalReleased?: number;
  aborted?: number;
  timedOut?: number;
  rejected?: number;
  rejectedByReason?: Partial<Record<RejectReason, number>>;
  doubleRelease?: number;
  inFlightUnderflow?: number;
  hookErrors?: number;
};

function addRejectReason(
  target: Partial<Record<ExpressBulkheadRejectReason, number>>,
  reason: ExpressBulkheadRejectReason,
  count: number | undefined,
): void {
  if (!count) return;
  target[reason] = (target[reason] ?? 0) + count;
}

function mapRejectedByReason(
  rejectedByReason: StatsWithOptionalCounters["rejectedByReason"] = {},
): Partial<Record<ExpressBulkheadRejectReason, number>> {
  const mapped: Partial<Record<ExpressBulkheadRejectReason, number>> = {};

  for (const [rawReason, count] of Object.entries(rejectedByReason)) {
    addRejectReason(mapped, mapRejectReason(rawReason as RejectReason), count);
  }

  return mapped;
}

function mapStats(
  name: string | undefined,
  stats: Stats,
  expressHookErrors = 0,
): ExpressBulkheadStats {
  const extended = stats as StatsWithOptionalCounters;
  const rejectedByReason = mapRejectedByReason(extended.rejectedByReason);

  if (
    extended.aborted !== undefined &&
    extended.aborted > 0 &&
    rejectedByReason.request_aborted === undefined
  ) {
    rejectedByReason.request_aborted = extended.aborted;
  }
  if (
    extended.timedOut !== undefined &&
    extended.timedOut > 0 &&
    rejectedByReason.queue_timeout === undefined
  ) {
    rejectedByReason.queue_timeout = extended.timedOut;
  }

  const rejected =
    extended.rejected ??
    Object.values(rejectedByReason).reduce((total, count) => total + count, 0);

  return {
    ...(name !== undefined ? { name } : {}),
    inFlight: stats.inFlight,
    pending: stats.pending,
    maxConcurrent: stats.maxConcurrent,
    maxQueue: stats.maxQueue,
    closed: stats.closed,
    totalAdmitted: extended.totalAdmitted ?? 0,
    totalReleased: extended.totalReleased ?? 0,
    rejected,
    rejectedByReason,
    ...(extended.aborted !== undefined ? { aborted: extended.aborted } : {}),
    ...(extended.timedOut !== undefined ? { timedOut: extended.timedOut } : {}),
    ...(extended.doubleRelease !== undefined
      ? { doubleRelease: extended.doubleRelease }
      : {}),
    ...(extended.inFlightUnderflow !== undefined
      ? { inFlightUnderflow: extended.inFlightUnderflow }
      : {}),
    hookErrors: (extended.hookErrors ?? 0) + expressHookErrors,
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

function getObservedPath(
  req: Request,
  mode: ExpressBulkheadObservedPathMode,
): string {
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

function callHook<T>(
  hook: ExpressBulkheadHook<T> | undefined,
  event: T,
  onError: () => void,
): void {
  if (!hook) return;
  try {
    const result = hook(event);
    if (result && typeof result.catch === "function") {
      result.catch(onError);
    }
  } catch {
    onError();
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

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be an integer >= 0`);
  }
}

function validateOptions(
  options: ExpressBulkheadOptions | null | undefined,
): asserts options is ExpressBulkheadOptions {
  if (options === null || options === undefined || typeof options !== "object") {
    throw new Error("options must be an object");
  }

  assertPositiveInteger(options.maxConcurrent, "maxConcurrent");

  if (options.maxQueue !== undefined) {
    assertNonNegativeInteger(options.maxQueue, "maxQueue");
  }

  if (options.queueWaitTimeoutMs !== undefined) {
    if (
      !Number.isFinite(options.queueWaitTimeoutMs) ||
      options.queueWaitTimeoutMs < 0
    ) {
      throw new Error("queueWaitTimeoutMs must be a finite number >= 0");
    }
  }

  if (
    options.pathMode !== undefined &&
    options.pathMode !== "path" &&
    options.pathMode !== "originalUrl" &&
    options.pathMode !== "route"
  ) {
    throw new Error("pathMode must be one of: path, originalUrl, route");
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
  let expressHookErrors = 0;
  const recordHookError = (): void => {
    expressHookErrors += 1;
  };
  const stats = (): ExpressBulkheadStats =>
    mapStats(options.name, bulkhead.stats(), expressHookErrors);
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
    callHook(options.onReject, event, recordHookError);

    if (event.reason === "request_aborted" || responseClosed(req, res)) return;

    if (options.rejectResponse) {
      try {
        await options.rejectResponse({ ...event, req, res });
      } catch (err) {
        next(err);
        return;
      }

      if (responseClosed(req, res)) return;
    }

    defaultReject(res, event.reason);
  };

  const middleware = (): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction) => {
      void (async (): Promise<void> => {
        if (options.skip?.(req)) {
          next();
          return;
        }

        const acquireStartedAt = performance.now();
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
          res.once("close", abortAcquire);
        }

        const cleanupAcquireAbort = (): void => {
          if (!abortController) return;
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
        const admittedAtMono = performance.now();

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
            durationMs: performance.now() - admittedAtMono,
            releaseCause,
          };
          callHook(options.onRelease, event, recordHookError);
        };

        res.once("finish", () => release("finish"));
        res.once("close", () => release("close"));

        callHook(
          options.onAdmit,
          {
            ...eventBase(req),
            admittedAt,
            queued,
            waitMs: admittedAtMono - acquireStartedAt,
          },
          recordHookError,
        );

        next();
      })().catch(next);
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
