import type { ConfigResponse, Diagnostic, ErrorResponse, InspectResponse } from '@ruhomo/core';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly diagnostics: Diagnostic[];
  constructor(code: string, status: number, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

/** Artifact links are absolute (PUBLIC_BASE_URL); the UI fetches them same-origin. */
export function sameOriginPath(absolute: string): string {
  const u = new URL(absolute);
  return `${u.pathname}${u.search}`;
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ErrorResponse;
    return new ApiError(body.error.code, res.status, body.error.message, body.diagnostics ?? []);
  } catch {
    return new ApiError('HTTP_ERROR', res.status, `服务返回 HTTP ${res.status}`);
  }
}

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { Accept: '*/*' }, credentials: 'omit' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('NETWORK_ERROR', 0, '无法连接服务，请检查网络后重试');
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

export async function fetchConfig(signal?: AbortSignal): Promise<ConfigResponse> {
  return (await (await request('/api/config', signal)).json()) as ConfigResponse;
}

export async function fetchInspect(inspectUrl: string, signal?: AbortSignal): Promise<InspectResponse> {
  return (await (await request(sameOriginPath(inspectUrl), signal)).json()) as InspectResponse;
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  return (await request(sameOriginPath(url), signal)).text();
}
