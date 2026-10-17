// A pending sign-up is kept in this browser so email-confirmed accounts can
// take the tour after their first successful sign-in.
const PENDING_EMAIL_KEY = "pp_tutorial_pending_email";
const DONE_KEY_PREFIX = "pp_tutorial_done_";

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

export function noteSignup(email) {
  const normalized = normalizeEmail(email);
  if (normalized) localStorage.setItem(PENDING_EMAIL_KEY, normalized);
}

export function needsTutorial(user) {
  const email = normalizeEmail(user?.email);
  return Boolean(email && user?.id)
    && localStorage.getItem(PENDING_EMAIL_KEY) === email
    && localStorage.getItem(`${DONE_KEY_PREFIX}${user.id}`) !== "1";
}

export function finishTutorial(user) {
  if (!user?.id) return;
  localStorage.setItem(`${DONE_KEY_PREFIX}${user.id}`, "1");
  if (localStorage.getItem(PENDING_EMAIL_KEY) === normalizeEmail(user.email)) {
    localStorage.removeItem(PENDING_EMAIL_KEY);
  }
}
