import type { ApiResponse } from '@opencrew/shared'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init
  })
  let body: ApiResponse<T>
  try {
    body = (await res.json()) as ApiResponse<T>
  } catch {
    throw new ApiError(`request failed (${res.status})`, res.status)
  }
  if (!res.ok || !body.success) {
    // 402 comes from the opencrew.run relay: a decision past the free tier.
    // The paywall renders once, app-wide (components/PaywallModal.tsx).
    if (res.status === 402) {
      window.dispatchEvent(new CustomEvent('opencrew:paywall', { detail: body }))
    }
    throw new ApiError(body.error ?? `request failed (${res.status})`, res.status)
  }
  return body.data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' })
}
