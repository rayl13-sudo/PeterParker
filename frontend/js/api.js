import { clearToken, getToken } from "./auth.js";

const BASE_URL = window.APP_CONFIG.API_BASE_URL;

// Called when the server rejects our token, so the app can return to sign-in.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("Can't reach the PeterParker server. Start it with `make dev` and try again.");
  }
  if (res.status === 401 && token) {
    clearToken();
    onUnauthorized();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (!body.detail && (res.status === 404 || res.status === 405)) {
      // Something other than the PeterParker backend answered (e.g. a plain file server).
      throw new Error("This page isn't connected to the PeterParker server. Open http://localhost:8000 instead.");
    }
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
  deleteAccount: ({ currentPassword, confirmation }) => request("/auth/me", {
    method: "DELETE",
    body: JSON.stringify({ current_password: currentPassword, confirmation }),
  }),
  updateMe: ({ username, currentPassword }) =>
    request("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ username, current_password: currentPassword }),
    }),
  setAvatarImage: (image) => request("/auth/me/avatar", { method: "PUT", body: JSON.stringify({ image }) }),
  removeAvatarImage: () => request("/auth/me/avatar", { method: "DELETE" }),
  setAvatarColors: ({ bg, fg }) =>
    request("/auth/me/avatar/colors", { method: "PUT", body: JSON.stringify({ bg, fg }) }),
  shuffleAvatarColors: () => request("/auth/me/avatar/colors", { method: "POST" }),
  changePassword: ({ currentPassword, newPassword }) =>
    request("/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  parking: () => request("/parking"),
  permitCatalogue: () => request("/parking/permits"),
  setPermit: (permit) => request("/auth/me/permit", { method: "PUT", body: JSON.stringify({ permit }) }),
  places: () => request("/places"),
  reviewSummary: () => request("/reviews/summary"),
  reviews: (type, id) => request(`/reviews?target_type=${type}&target_id=${encodeURIComponent(id)}`),
  saveReview: ({ type, id, rating, comment }) =>
    request("/reviews", {
      method: "PUT",
      body: JSON.stringify({ target_type: type, target_id: id, rating, comment }),
    }),
  deleteReview: (reviewId) => request(`/reviews/${reviewId}`, { method: "DELETE" }),
  replyToReview: (reviewId, comment) =>
    request(`/reviews/${reviewId}/replies`, { method: "POST", body: JSON.stringify({ comment }) }),
  deleteReply: (replyId) => request(`/reviews/replies/${replyId}`, { method: "DELETE" }),
  route: (mode, from, to) =>
    request(
      `/route?mode=${mode}&from_lat=${from.lat}&from_lon=${from.lon}&to_lat=${to.lat}&to_lon=${to.lon}`,
    ),
};
