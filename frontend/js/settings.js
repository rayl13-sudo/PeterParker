// Settings page: view and change the signed-in account, or switch accounts.
import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken } from "./auth.js";
import { imageFileToAvatar, renderAvatar } from "./avatar.js";
import { bindRuleChecklist, passwordMeetsRules } from "./password-rules.js";

const SIGN_IN_PAGE = "index.html";
const $ = (id) => document.getElementById(id);

function toSignIn() {
  clearToken();
  location.replace(SIGN_IN_PAGE);
}

if (!getToken()) toSignIn();
setUnauthorizedHandler(toSignIn);

function showMessage(el, text, kind) {
  el.textContent = text ?? "";
  el.className = `settings-message ${kind ?? ""}`;
  el.hidden = !text;
}

function showUser(user) {
  const name = user.username ?? user.email;
  $("user-name").textContent = name;
  $("profile-name").textContent = name;
  $("profile-email").textContent = user.email;
  $("switch-name").textContent = name;
  $("details-username").value = user.username ?? "";
  renderAvatar($("user-avatar"), user.avatar);
  renderAvatar($("profile-avatar"), user.avatar);
  // With a photo: just "Revert to default icon". Without: pick or shuffle the icon's colors.
  $("photo-remove").hidden = !user.avatar.image;
  $("color-controls").hidden = Boolean(user.avatar.image);
  $("color-bg").value = user.avatar.bg;
  $("color-fg").value = user.avatar.fg;
}

// Runs a form action with its button disabled, showing the result in `message`.
async function submitting(form, message, action) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage(message, null);
  try {
    showMessage(message, await action(), "success");
  } catch (err) {
    showMessage(message, err.message, "error");
  } finally {
    button.disabled = false;
  }
}

// ---------- Profile picture ----------

async function photoAction(action, done) {
  const message = $("photo-message");
  const buttons = document.querySelectorAll(".photo-actions button, #photo-input");
  buttons.forEach((b) => (b.disabled = true));
  showMessage(message, null);
  try {
    current = await action();
    showUser(current);
    showMessage(message, done, "success");
  } catch (err) {
    showMessage(message, err.message, "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$("photo-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow choosing the same file again
  if (!file) return;
  photoAction(async () => api.setAvatarImage(await imageFileToAvatar(file)), "Profile picture updated.");
});
$("photo-remove").addEventListener("click", () =>
  photoAction(() => api.removeAvatarImage(), "Back to your default icon."),
);
$("photo-colors").addEventListener("click", () => photoAction(() => api.shuffleAvatarColors(), null));

// Color pickers: preview while dragging, save when a color is chosen.
const pickedColors = () => ({ bg: $("color-bg").value, fg: $("color-fg").value, image: null });
for (const picker of [$("color-bg"), $("color-fg")]) {
  picker.addEventListener("input", () => {
    renderAvatar($("profile-avatar"), pickedColors());
    renderAvatar($("user-avatar"), pickedColors());
  });
  picker.addEventListener("change", () => {
    const { bg, fg } = pickedColors();
    photoAction(() => api.setAvatarColors({ bg, fg }), null);
  });
}

// ---------- Account details ----------

let current = null;

$("details-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const username = $("details-username").value.trim();
  const currentPassword = $("details-password").value;
  submitting($("details-form"), $("details-message"), async () => {
    if (!username) throw new Error("Enter a username.");
    if (username.toLowerCase() === current.username) return "Nothing to save. Your username is unchanged.";
    if (!currentPassword) throw new Error("Enter your current password to save changes.");
    current = await api.updateMe({ username, currentPassword });
    showUser(current);
    $("details-password").value = "";
    return "Username saved. Use it next time you sign in.";
  });
});

// ---------- Password ----------

const updateRules = bindRuleChecklist($("password-new"), $("new-password-rules"));

$("password-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const currentPassword = $("password-current").value;
  const newPassword = $("password-new").value;
  const confirm = $("password-confirm").value;
  submitting($("password-form"), $("password-message"), async () => {
    if (!currentPassword) throw new Error("Enter your current password.");
    if (!passwordMeetsRules(newPassword)) throw new Error("New password doesn't meet all the requirements.");
    if (newPassword !== confirm) throw new Error("New passwords don't match.");
    await api.changePassword({ currentPassword, newPassword });
    $("password-form").reset();
    updateRules();
    return "Password updated. You've been signed out on your other devices.";
  });
});

// ---------- Switch account ----------

$("switch-account").addEventListener("click", async () => {
  try {
    await api.logout();
  } finally {
    toSignIn();
  }
});

// ---------- Boot ----------

async function init() {
  try {
    current = await api.me();
    showUser(current);
  } catch (err) {
    showMessage($("details-message"), err.message, "error");
  }
}

init();
