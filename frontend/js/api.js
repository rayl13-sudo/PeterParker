import { clearToken, getToken } from "./auth.js";

const BASE_URL = window.APP_CONFIG.API_BASE_URL;

// Called when the server rejects our token, so the app can return to sign-in.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });
  if (res.status === 401 && token) {
    clearToken();
    onUnauthorized();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(formatDetail(body.detail) || `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// FastAPI validation errors come back as a list of {msg, ...}.
function formatDetail(detail) {
  if (Array.isArray(detail)) {
    return detail.map((d) => d.msg.replace(/^Value error, /, "")).join(". ");
  }
  return detail;
}

export const api = {
  health: () => request("/health"),

  signup: ({ username, email, password, rememberMe }) =>
    request("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username, email, password, remember_me: rememberMe }),
    }),
  login: ({ identifier, password, rememberMe }) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password, remember_me: rememberMe }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),

  listItems: () => request("/items"),
  createItem: (name) => request("/items", { method: "POST", body: JSON.stringify({ name }) }),
  deleteItem: (id) => request(`/items/${id}`, { method: "DELETE" }),
};
