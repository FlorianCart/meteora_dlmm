import { sleep, jitter } from "../utils/time.js";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly body?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface HttpClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

export class HttpClient {
  private readonly baseUrl: URL;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly minIntervalMs: number;
  private nextAllowedAt = 0;

  constructor(options: HttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!this.baseUrl.pathname.endsWith("/")) {
      this.baseUrl.pathname = `${this.baseUrl.pathname}/`;
    }
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 3;
    this.minIntervalMs = options.minIntervalMs ?? 0;
  }

  getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>("GET", path, options);
  }

  postJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>("POST", path, options);
  }

  private async requestJson<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.waitForRateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const init: RequestInit = {
          method,
          headers: this.buildHeaders(options),
          signal: controller.signal
        };
        if (options.body !== undefined) {
          init.body = JSON.stringify(options.body);
        }

        const response = await fetch(this.buildUrl(path, options.query), init);

        const text = await response.text();
        if (!response.ok) {
          const error = new HttpError(`HTTP ${response.status} for ${method} ${path}`, response.status, text);
          if (attempt < this.retries && this.isRetryableStatus(response.status)) {
            await sleep(this.retryDelay(attempt, response.headers));
            continue;
          }
          throw error;
        }

        return (text.length === 0 ? null : JSON.parse(text)) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError && !this.isRetryableStatus(error.status)) {
          throw error;
        }
        if (attempt >= this.retries) {
          break;
        }
        await sleep(this.retryDelay(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private buildHeaders(options: RequestOptions): HeadersInit {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.defaultHeaders,
      ...options.headers
    };

    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    return headers;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.startsWith("http") ? path : path.replace(/^\//, ""), this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.minIntervalMs <= 0) {
      return;
    }
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minIntervalMs;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  private isRetryableStatus(status: number | null): boolean {
    return status === null || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  private retryDelay(attempt: number, headers?: Headers): number {
    const retryAfter = headers?.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        return seconds * 1000;
      }
    }
    return jitter(Math.min(10_000, 500 * 2 ** attempt), 0.35);
  }
}
