const BASE_URL = window.APP_CONFIG.API_BASE_URL;

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  health: () => request("/health"),
  listItems: () => request("/items"),
  createItem: (name) => request("/items", { method: "POST", body: JSON.stringify({ name }) }),
  deleteItem: (id) => request(`/items/${id}`, { method: "DELETE" }),
};
