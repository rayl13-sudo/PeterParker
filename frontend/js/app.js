import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken, saveToken } from "./auth.js";

const $ = (id) => document.getElementById(id);

const authView = $("auth-view");
const appView = $("app-view");

// ---------- Auth view ----------

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

// Keep in sync with the password validator in backend/app/api/routes/auth.py.
const PASSWORD_RULES = {
  length: (pw) => pw.length >= 8,
  capital: (pw) => /[A-Z]/.test(pw),
  special: (pw) => /[^A-Za-z0-9\s]/.test(pw),
};
const ruleItems = document.querySelectorAll("#password-rules [data-rule]");

function updatePasswordRules() {
  const pw = authPassword.value;
  ruleItems.forEach((li) => {
    const met = PASSWORD_RULES[li.dataset.rule](pw);
    li.classList.toggle("met", met);
    li.setAttribute("aria-checked", String(met));
  });
}

function passwordMeetsRules(pw) {
  return Object.values(PASSWORD_RULES).every((rule) => rule(pw));
}

authPassword.addEventListener("input", updatePasswordRules);
ruleItems.forEach((li) => li.setAttribute("role", "checkbox"));
updatePasswordRules();

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

function validateAuthForm(password) {
  if (mode === "login") {
    if (!authIdentifier.value.trim() || !password) return "Enter your username or email and password.";
    return null;
  }
  if (!authUsername.value.trim() || !authEmail.value.trim()) return "Enter a username and email.";
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
  try {
    const { token, user } =
      mode === "login"
        ? await api.login({ identifier: authIdentifier.value.trim(), password, rememberMe })
        : await api.signup({
            username: authUsername.value.trim(),
            email: authEmail.value.trim(),
            password,
            rememberMe,
          });
    saveToken(token, rememberMe);
    authForm.reset();
    updatePasswordRules();
    showApp(user);
  } catch (err) {
    showAuthError(err);
  } finally {
    authSubmit.disabled = false;
  }
});

function showAuth() {
  appView.hidden = true;
  authView.hidden = false;
  firstField().focus();
}

// ---------- App view ----------

const statusEl = $("api-status");
const itemForm = $("item-form");
const itemInput = $("item-name");
const list = $("item-list");
const errorEl = $("error");

function showError(err) {
  errorEl.textContent = err ? err.message : "";
  errorEl.hidden = !err;
}

function renderItems(items) {
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = item.name;
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "secondary";
      del.addEventListener("click", async () => {
        try {
          await api.deleteItem(item.id);
          await loadItems();
        } catch (err) {
          showError(err);
        }
      });
      li.append(label, del);
      return li;
    }),
  );
}

async function loadItems() {
  renderItems(await api.listItems());
  showError(null);
}

itemForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api.createItem(itemInput.value.trim());
    itemInput.value = "";
    await loadItems();
  } catch (err) {
    showError(err);
  }
});

$("logout").addEventListener("click", async () => {
  try {
    await api.logout();
  } finally {
    clearToken();
    renderItems([]);
    showAuth();
  }
});

async function showApp(user) {
  $("user-name").textContent = user.username ?? user.email;
  $("user-name").title = user.email;
  authView.hidden = true;
  appView.hidden = false;

  try {
    await api.health();
    statusEl.textContent = "online";
    statusEl.className = "badge ok";
    await loadItems();
  } catch (err) {
    statusEl.textContent = "offline";
    statusEl.className = "badge down";
    showError(err);
  }
}

// ---------- Boot ----------

setUnauthorizedHandler(showAuth);

async function init() {
  if (!getToken()) return showAuth();
  try {
    showApp(await api.me());
  } catch {
    clearToken();
    showAuth();
  }
}

init();
