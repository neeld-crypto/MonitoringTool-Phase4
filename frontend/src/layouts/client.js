/** Saved layouts live on the server (/__layouts), so every browser that opens Pulse sees the same ones. */
async function request(method, body) {
  const res = await fetch('/__layouts', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) location.assign('/login');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `server answered ${res.status}`);
  return data.layouts;
}

export const loadLayouts = () => request('GET');
export const saveLayouts = (layouts) => request('PUT', { layouts });
