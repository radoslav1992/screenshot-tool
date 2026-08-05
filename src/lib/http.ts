export interface ApiErrorBody {
  error: { type: string; message: string; param?: string };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string> | undefined) },
  });
}

export function apiError(
  status: number,
  type: string,
  message: string,
  extra: { param?: string; headers?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = { error: { type, message } };
  if (extra.param) body.error.param = extra.param;
  return json(body, { status, headers: extra.headers });
}

/** Thrown by validators and caught by route handlers. */
export class HttpError extends Error {
  status: number;
  type: string;
  param?: string;

  constructor(status: number, type: string, message: string, param?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
    this.param = param;
  }

  toResponse(): Response {
    return apiError(this.status, this.type, this.message, { param: this.param });
  }
}

export function badRequest(message: string, param?: string): HttpError {
  return new HttpError(400, 'invalid_request', message, param);
}

/**
 * Reads a request body as a plain object, accepting JSON, form-encoded and
 * multipart bodies so `curl -d url=…` works exactly like the docs promise.
 */
export async function readBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw badRequest('Request body must be a JSON object.');
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        out[key] = typeof value === 'string' ? value : String(value);
      }
      return out;
    }
    const form = await request.formData();
    const out: Record<string, string> = {};
    for (const [key, value] of form.entries()) out[key] = String(value);
    return out;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest('Could not parse the request body.');
  }
}

/** Same-origin check for cookie-authenticated mutations (CSRF defence). */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return; // Non-CORS clients (curl) send no Origin; cookies need one to be forged.
  const target = new URL(request.url).origin;
  if (origin !== target) {
    throw new HttpError(403, 'forbidden', 'Cross-origin request rejected.');
  }
}

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
};
