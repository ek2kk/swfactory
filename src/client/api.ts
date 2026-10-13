const pendingRequests = new Map<string, string>();
export async function api<T>(path: string, method = 'GET', body?: Record<string, unknown>): Promise<T> {
  // SSE can advance the version before a lost response is retried; it does not change the user's intent.
  const key = JSON.stringify([method, path, body && { ...body, state_version: undefined }]);
  let payload = body ? JSON.stringify(body) : undefined;
  if (body && path !== '/session') {
    payload = pendingRequests.get(key) ?? JSON.stringify({ ...body, request_id: crypto.randomUUID() });
    pendingRequests.set(key, payload);
  }
  const response = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: payload });
  const data = await response.json();
  // Transport, authentication and server errors do not resolve an earlier uncertain write.
  if (response.ok || [400, 404, 409, 422].includes(response.status)) pendingRequests.delete(key);
  if (!response.ok) throw new Error(data.message ?? 'Backend недоступен. Проверьте терминал.');
  return data as T;
}
