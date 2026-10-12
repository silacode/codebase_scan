import { FetchError, ofetch } from 'ofetch';

export class ApiError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
const api = ofetch.create({ retry: false });
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    return await api<T>(path, options);
  } catch (error) {
    if (error instanceof FetchError && error.response) {
      const e = (error.data as { error?: { code?: string; message?: string; retryable?: boolean } })
        ?.error;
      throw new ApiError(e?.code ?? 'NETWORK', e?.message ?? 'Request failed', !!e?.retryable);
    }
    throw error;
  }
}
