// Sign-in / sign-up page. The map shows a tour to newly signed-up users.
import { api } from "./api.js";
import { clearToken, getToken, saveToken } from "./auth.js";
import { bindRuleChecklist, passwordMeetsRules } from "./password-rules.js";
import { TERMS_VERSION, renderTerms } from "./terms.js";
import { noteSignup } from "./tutorial-state.js";

const MAP_PAGE = "map.html";

const $ = (id) => document.getElementById(id);

const authView = $("auth-view");

const authForm = $("auth-form");
const authIdentifier = $("auth-identifier");
const authUsername = $("auth-username");
const authEmail = $("auth-email");
const authPassword = $("auth-password");
const authRemember = $("auth-remember");
const authSubmit = $("auth-submit");
const authError = $("auth-error");
const tabs = document.querySelectorAll(".tab");
const modeFields = document.querySelectorAll("[data-show]");

let mode = "login";

const updatePasswordRules = bindRuleChecklist(authPassword, $("password-rules"));

function setMode(next) {
  mode = next;
  if (termsStep && !termsStep.hidden) hideTerms();
  document.querySelector(".tabs").dataset.mode = mode;
  tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  modeFields.forEach((el) => (el.hidden = el.dataset.show !== mode));
  authSubmit.textContent = mode === "login" ? "Sign in" : "Create account";
  $("auth-title").textContent = mode === "login" ? "Welcome back" : "Create your account";
  $("auth-subtitle").textContent =
    mode === "login" ? "Sign in to continue." : "It only takes a minute.";
  authPassword.autocomplete = mode === "login" ? "current-password" : "new-password";
  showAuthError(null);
  firstField().focus();
}

function firstField() {
  return mode === "login" ? authIdentifier : authUsername;
}

function showAuthError(err) {
  authError.textContent = err ? err.message : "";
  authError.hidden = !err;
}

// Any email works; UCI emails (name@uci.edu, name@ics.uci.edu) also unlock UCI permits.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateAuthForm(password) {
  if (mode === "login") {
    const identifier = authIdentifier.value.trim();
    if (!identifier || !password) return "Enter your email or username, and your password.";
    return null;
  }
  if (!authUsername.value.trim() || !authEmail.value.trim()) return "Enter a username and your email.";
  const nameProblem = usernameProblem(authUsername.value.trim());
  if (nameProblem) return `Username: ${nameProblem.toLowerCase()}.`;
  if (!EMAIL.test(authEmail.value.trim())) return "Enter a valid email address.";
  if (!passwordMeetsRules(password)) return "Password doesn't meet all the requirements below.";
  return null;
}

tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

// ---------- Live username hints while signing up ----------

const USERNAME_MIN = 3;
const USERNAME_MAX = 67; // same limits as the server
const usernameStatus = $("username-status");
let usernameTimer = null;
let usernameRequest = 0; // only the latest lookup may update the hint

function setUsernameStatus(text, tone) {
  if (usernameStatus.textContent === text && usernameStatus.dataset.tone === tone) return;
  usernameStatus.textContent = text;
  usernameStatus.dataset.tone = tone ?? "";
  usernameStatus.classList.remove("pop");
  void usernameStatus.offsetWidth; // replay the entrance
  if (text) usernameStatus.classList.add("pop");
}

// Problems you can see without asking the server; null when the shape is fine.
function usernameProblem(name) {
  if (/[\s@]/.test(name)) return "No spaces or “@”";
  if (name.length < USERNAME_MIN) return `Too short: at least ${USERNAME_MIN} characters`;
  if (name.length > USERNAME_MAX) return `Too long: ${USERNAME_MAX} characters max (${name.length})`;
  return null;
}

authUsername.addEventListener("input", () => {
  clearTimeout(usernameTimer);
  const request = ++usernameRequest;
  const name = authUsername.value.trim();
  if (!name) return setUsernameStatus("", null);
  const problem = usernameProblem(name);
  if (problem) return setUsernameStatus(problem, "error");
  setUsernameStatus("Checking…", "pending");
  usernameTimer = setTimeout(async () => {
    try {
      const { available } = await api.usernameAvailable(name);
      if (request !== usernameRequest) return; // you've kept typing
      setUsernameStatus(available ? "Username available" : "That username is taken", available ? "ok" : "error");
    } catch {
      if (request === usernameRequest) setUsernameStatus("", null); // offline: the form re-checks on submit
    }
  }, 300);
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = authPassword.value;
  const problem = validateAuthForm(password);
  if (problem) return showAuthError(new Error(problem));
  // New accounts go through the Terms of Service first; that step creates the account.
  // Check the username and email are free before asking anyone to read the terms.
  if (mode === "signup") {
    authSubmit.disabled = true;
    authSubmit.setAttribute("aria-busy", "true");
    try {
      await api.checkSignup({ username: authUsername.value.trim(), email: authEmail.value.trim() });
    } catch (err) {
      return showAuthError(err);
    } finally {
      authSubmit.disabled = false;
      authSubmit.removeAttribute("aria-busy");
    }
    return showTerms();
  }
  await submitAuth(authSubmit, () =>
    api.login({ identifier: authIdentifier.value.trim(), password, rememberMe: authRemember.checked }),
  );
});

// Runs a sign-in or sign-up request from `button`, then opens the map.
async function submitAuth(button, send) {
  const rememberMe = authRemember.checked;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  let done = false;
  try {
    const result = await send();
    if (result.confirmation_required) {
      // No app session exists until email confirmation; show the map tour at first sign-in.
      noteSignup(authEmail.value);
      authForm.reset();
      setUsernameStatus("", null);
      updatePasswordRules();
      setMode("login");
      showAuthError(new Error(result.message));
      return;
    }
    saveToken(result.token, rememberMe);
    if (mode === "signup") {
      noteSignup(result.user.email);
      // A beat of "Welcome!" on the button before the map takes over.
      done = true;
      button.classList.add("success");
      button.textContent = "Welcome to PeterParker!";
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    window.ppNavigate(MAP_PAGE, { replace: true });
  } catch (err) {
    if (mode === "signup") hideTerms(); // e.g. username taken: fix it on the form
    showAuthError(err);
  } finally {
    if (!done) button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

// ---------- Sign up, step 2: Terms of Service ----------

const authCard = document.querySelector(".auth-card");
const termsStep = $("terms-step");
const termsBox = $("terms-box");
const termsAgree = $("terms-agree");
const termsSubmit = $("terms-submit");
let termsRendered = false;
let termsRead = false; // set once every section has been on screen long enough to read
let readTimer = null;
// A section counts as read after it has been (mostly) on screen this long, so jumping
// straight to the bottom, or flicking past it, doesn't count.
const SECTION_READ_MS = 1000;
const READ_TICK_MS = 100;
const sectionTime = new Map(); // section element -> ms on screen

function showTerms() {
  if (!termsRendered) {
    renderTerms(termsBox);
    termsRendered = true;
  }
  showAuthError(null);
  $("terms-error").hidden = true;
  authCard.dataset.step = "terms";
  authForm.hidden = true;
  termsStep.hidden = false;
  termsBox.scrollTop = 0;
  updateTermsProgress();
  clearInterval(readTimer);
  if (!termsRead) readTimer = setInterval(tickReading, READ_TICK_MS);
  termsBox.focus({ preventScroll: true });
}

function hideTerms() {
  delete authCard.dataset.step;
  termsStep.hidden = true;
  clearInterval(readTimer);
  authForm.hidden = false;
  authForm.classList.add("returning");
  authForm.addEventListener("animationend", () => authForm.classList.remove("returning"), { once: true });
}

// Time each section spends on screen while the page is visible.
function tickReading() {
  if (document.hidden) return;
  const box = termsBox.getBoundingClientRect();
  for (const section of termsBox.querySelectorAll(".terms-section")) {
    const r = section.getBoundingClientRect();
    const onScreen = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
    if (onScreen >= Math.min(r.height, box.height) * 0.6) {
      sectionTime.set(section, (sectionTime.get(section) ?? 0) + READ_TICK_MS);
    }
  }
  updateTermsProgress();
}

// Reading every section unlocks the checkbox; the bar under the text fills as you read.
function updateTermsProgress() {
  const sections = [...termsBox.querySelectorAll(".terms-section")];
  const done = sections.filter((s) => (sectionTime.get(s) ?? 0) >= SECTION_READ_MS);
  for (const s of done) s.classList.add("read");
  const read = sections.length ? done.length / sections.length : 0;
  $("terms-progress-bar").style.transform = `scaleX(${read})`;
  if (!termsRead && done.length && read < 1) {
    $("terms-hint").textContent = `Keep reading… ${done.length} of ${sections.length} sections`;
  }
  if (read >= 1 && !termsRead) {
    termsRead = true;
    clearInterval(readTimer);
    termsAgree.disabled = false;
    $("terms-agree-label").classList.add("unlocked");
    $("terms-hint").textContent = "Thanks for reading. Check the box to continue.";
    $("terms-hint").classList.add("done");
  }
}
termsBox.addEventListener("scroll", updateTermsProgress, { passive: true });

// Trying to agree before reading to the end: point back at the unread terms.
$("terms-agree-label").addEventListener("click", (e) => {
  if (termsRead) return;
  e.preventDefault();
  const hint = $("terms-hint");
  const total = termsBox.querySelectorAll(".terms-section").length;
  const read = termsBox.querySelectorAll(".terms-section.read").length;
  hint.textContent = `Please read all of the Terms of Service first (${read} of ${total} sections read).`;
  hint.classList.remove("nudge");
  void hint.offsetWidth; // replay the shake
  hint.classList.add("nudge");
  termsBox.focus({ preventScroll: true });
});

termsAgree.addEventListener("change", () => {
  if (!termsRead) termsAgree.checked = false;
  termsSubmit.disabled = !(termsRead && termsAgree.checked);
  termsSubmit.classList.toggle("ready", termsAgree.checked);
});

$("terms-back").addEventListener("click", () => {
  hideTerms();
  firstField().focus();
});

termsSubmit.addEventListener("click", () => {
  if (!termsRead || !termsAgree.checked) return; // must read all of the terms, then agree
  submitAuth(termsSubmit, () =>
    api.signup({
      username: authUsername.value.trim(),
      email: authEmail.value.trim(),
      password: authPassword.value,
      rememberMe: authRemember.checked,
      termsVersion: TERMS_VERSION,
    }),
  );
});

// Decorative, non-interactive campus map behind the card. Skipped if Leaflet
// didn't load (e.g. offline); the page works the same without it.
function showBackgroundMap() {
  if (!window.L) return;
  const map = L.map("auth-map", {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
  }).setView([33.6461, -117.8427], 16); // Aldrich Park, UC Irvine
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
}

function showAuth() {
  authView.hidden = false;
  showBackgroundMap();
  if (sessionStorage.getItem("pp_account_deleted") === "1") {
    sessionStorage.removeItem("pp_account_deleted");
    showAuthError(new Error("Your account has been deleted."));
  }
  firstField().focus();
}

// Already signed in? The map decides whether to show the on-map tour.
async function init() {
  if (!getToken()) return showAuth();
  try {
    await api.me();
    location.replace(MAP_PAGE); // already signed in: skip straight there
  } catch {
    clearToken();
    showAuth();
  }
}

init();
