// Sign-in / sign-up page. The map shows a tour to newly signed-up users.
import { api } from "./api.js";
import { clearToken, getToken, saveToken } from "./auth.js";
import { bindRuleChecklist, passwordMeetsRules } from "./password-rules.js";
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

// Accounts use a UCI email: name@uci.edu or a UCI department address (name@ics.uci.edu).
// The server checks this too.
const UCI_EMAIL = /^[^\s@]+@(?:[a-z0-9-]+\.)*uci\.edu$/i;
const UCI_EMAIL_ERROR = "Invalid email: use your UCI email address (ending in uci.edu).";

function validateAuthForm(password) {
  if (mode === "login") {
    const email = authIdentifier.value.trim();
    if (!email || !password) return "Enter your UCI email and password.";
    if (!UCI_EMAIL.test(email)) return UCI_EMAIL_ERROR;
    return null;
  }
  if (!authUsername.value.trim() || !authEmail.value.trim()) return "Enter a username and your UCI email.";
  if (!UCI_EMAIL.test(authEmail.value.trim())) return UCI_EMAIL_ERROR;
  if (!passwordMeetsRules(password)) return "Password doesn't meet all the requirements below.";
  return null;
}

tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = authPassword.value;
  const rememberMe = authRemember.checked;
  const problem = validateAuthForm(password);
  if (problem) return showAuthError(new Error(problem));

  authSubmit.disabled = true;
  authSubmit.setAttribute("aria-busy", "true");
  try {
    const result =
      mode === "login"
        ? await api.login({ identifier: authIdentifier.value.trim(), password, rememberMe })
        : await api.signup({
            username: authUsername.value.trim(),
            email: authEmail.value.trim(),
            password,
            rememberMe,
          });
    if (result.confirmation_required) {
      // No app session exists until email confirmation; show the map tour at first sign-in.
      noteSignup(authEmail.value);
      authForm.reset();
      updatePasswordRules();
      setMode("login");
      showAuthError(new Error(result.message));
      return;
    }
    saveToken(result.token, rememberMe);
    if (mode === "signup") noteSignup(result.user.email);
    window.ppNavigate(MAP_PAGE, { replace: true });
  } catch (err) {
    showAuthError(err);
  } finally {
    authSubmit.disabled = false;
    authSubmit.removeAttribute("aria-busy");
  }
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
