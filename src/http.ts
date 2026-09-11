import { OsmConfigError, OsmTimeoutError, OsmUpstreamError } from './errors.js';
import type {
  FetchLike,
  RequestHookContext,
  RetryHookContext,
  RetryOptions,
} from './types.js';

export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;

export const DEFAULT_NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504] as const;

export function assertValidUserAgent(userAgent: string): string {
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) {
    throw new OsmConfigError(
      'A non-empty `userAgent` is required by OpenStreetMap Nominatim and Overpass usage policies (e.g. "my-app/1.0 (https://example.com; contact@example.com)").',
    );
  }
  return userAgent.trim();
}

export interface NormalizedRetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOnStatuses: ReadonlySet<number>;
}

export function normalizeRetryOptions(retry?: RetryOptions): NormalizedRetryOptions {
  return {
    retries: Math.max(0, Math.floor(retry?.retries ?? 1)),
    baseDelayMs: Math.max(0, retry?.baseDelayMs ?? 300),
    maxDelayMs: Math.max(0, retry?.maxDelayMs ?? 5000),
    retryOnStatuses: new Set(retry?.retryOnStatuses ?? DEFAULT_RETRY_STATUSES),
  };
}

function parseRetryAfterMs(headerValue: string | null, maxDelayMs: number): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxDelayMs, Math.round(seconds * 1000));
  }
  const targetMs = Date.parse(headerValue);
  if (Number.isFinite(targetMs)) {
    return Math.min(maxDelayMs, Math.max(0, targetMs - Date.now()));
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FetchJsonParams {
  service: 'nominatim' | 'overpass';
  url: string;
  userAgent: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  retry: NormalizedRetryOptions;
  init?: RequestInit;
  signal?: AbortSignal;
  onRequest?: (context: RequestHookContext) => void;
  onRetry?: (context: RetryHookContext) => void;
}

async function fetchOnceWithTimeout<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ ok: true; data: T } | { ok: false; status: number; retryAfterHeader: string | null }> {
  if (externalSignal?.aborted) {
    throw externalSignal.reason ?? new Error('Request aborted');
  }

  const controller = new AbortController();
  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new OsmTimeoutError(url, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        retryAfterHeader: response.headers.get('retry-after'),
      };
    }

    const data = (await Promise.race([response.json() as Promise<T>, timeoutPromise]));
    return { ok: true, data };
  } catch (error) {
    if (error instanceof OsmTimeoutError) {
      throw error;
    }
    if (externalSignal?.aborted) {
      throw error;
    }
    if (controller.signal.aborted && controller.signal.reason instanceof OsmTimeoutError) {
      throw controller.signal.reason;
    }
    throw new OsmUpstreamError(
      `Upstream request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { endpoint: url, cause: error },
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function fetchJsonWithRetry<T>(params: FetchJsonParams): Promise<T> {
  const {
    service,
    url,
    userAgent,
    fetchImpl,
    timeoutMs,
    retry,
    init,
    signal,
    onRequest,
    onRetry,
  } = params;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': userAgent,
  };

  if (init?.headers) {
    const incoming = new Headers(init.headers);
    incoming.forEach((value, key) => {
      headers[key] = value;
    });
    // Always enforce configured User-Agent even if init.headers omitted/varied casing
    headers['User-Agent'] = userAgent;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retry.retries; attempt += 1) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Request aborted');
    }

    onRequest?.({ service, endpoint: url, attempt });

    try {
      const outcome = await fetchOnceWithTimeout<T>(
        fetchImpl,
        url,
        { ...init, headers },
        timeoutMs,
        signal,
      );

      if (outcome.ok) {
        return outcome.data;
      }

      const statusError = new OsmUpstreamError(
        `Upstream ${url} responded with HTTP ${outcome.status}`,
        { status: outcome.status, endpoint: url },
      );
      lastError = statusError;

      const canRetry =
        attempt < retry.retries && retry.retryOnStatuses.has(outcome.status);
      if (!canRetry) {
        throw statusError;
      }

      const backoffMs = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
      const retryAfterMs = parseRetryAfterMs(outcome.retryAfterHeader, retry.maxDelayMs);
      const delayMs = retryAfterMs ?? backoffMs;

      onRetry?.({
        service,
        endpoint: url,
        attempt,
        delayMs,
        reason: `HTTP ${outcome.status}`,
      });

      await sleep(delayMs, signal);
    } catch (error) {
      lastError = error;

      if (signal?.aborted) {
        throw error;
      }

      // Non-retryable HTTP errors (e.g. 400, 403, 404) are thrown immediately.
      if (
        error instanceof OsmUpstreamError &&
        error.status !== undefined &&
        !retry.retryOnStatuses.has(error.status)
      ) {
        throw error;
      }

      if (attempt >= retry.retries) {
        throw error;
      }

      const delayMs = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
      onRetry?.({
        service,
        endpoint: url,
        attempt,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      });

      await sleep(delayMs, signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new OsmUpstreamError(`Upstream request to ${url} failed`, { endpoint: url });
}
