// Settings page: view and change the signed-in account, or switch accounts.
import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken } from "./auth.js";
import { bindAvatarPreview, imageFileToAvatar, renderAvatar } from "./avatar.js";
import { bindRuleChecklist, passwordMeetsRules } from "./password-rules.js";
import { RULES_SOURCE, STALL_NOTE, permitSummary } from "./permit-rules.js";
import { clearTutorialState } from "./tutorial-state.js";
import { clearMapHistory } from "./map-history.mjs";

const SIGN_IN_PAGE = "index.html";
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const $ = (id) => document.getElementById(id);

function toSignIn() {
  clearToken();
  window.ppNavigate(SIGN_IN_PAGE, { replace: true });
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
  $("delete-account").disabled = false;
}

// Runs a form action with its button disabled, showing the result in `message`.
async function submitting(form, message, action) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  showMessage(message, null);
  try {
    showMessage(message, await action(), "success");
  } catch (err) {
    showMessage(message, err.message, "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
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
bindAvatarPreview($("user-avatar"), () => current?.avatar);
bindAvatarPreview($("profile-avatar"), () => current?.avatar);

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

// ---------- Delete account ----------

const deleteDialog = $("delete-dialog");
const deleteForm = $("delete-form");
const deleteYes = $("delete-yes");
const deletePassword = $("delete-password");
const deleteConfirm = $("delete-confirm");
const deleteCancel = $("delete-cancel");
let deleting = false;

function updateDeleteConfirmation() {
  deleteConfirm.disabled = !deleteYes.checked || !deletePassword.value;
}

$("delete-account").addEventListener("click", () => {
  if (!current) return;
  deleteDialog.showModal();
  deleteForm.querySelector('input[value="no"]').focus();
});
deleteCancel.addEventListener("click", () => { if (!deleting) deleteDialog.close(); });
deleteDialog.addEventListener("cancel", (event) => { if (deleting) event.preventDefault(); });
deleteDialog.addEventListener("close", () => {
  deleteForm.reset();
  showMessage($("delete-message"), null);
  updateDeleteConfirmation();
});
deleteForm.querySelectorAll('input[name="delete-choice"]').forEach((choice) =>
  choice.addEventListener("change", updateDeleteConfirmation),
);
deletePassword.addEventListener("input", updateDeleteConfirmation);
deleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!deleteYes.checked || !deletePassword.value || !current) return;
  const currentPassword = deletePassword.value;
  const confirmation = deleteYes.checked ? "YES" : "NO";
  deleting = true;
  deleteConfirm.disabled = true;
  deleteConfirm.textContent = "Deleting…";
  deleteCancel.disabled = true;
  deleteForm.querySelectorAll("input").forEach((input) => { input.disabled = true; });
  showMessage($("delete-message"), null);
  try {
    await api.deleteAccount({ currentPassword, confirmation });
    try {
      clearTutorialState(current);
      clearMapHistory(current.id);
      sessionStorage.setItem("pp_account_deleted", "1");
    } catch {
      // Browser storage cleanup is best effort; the server has deleted the account.
    }
    toSignIn();
  } catch (err) {
    showMessage($("delete-message"), err.message, "error");
    deleting = false;
    deleteConfirm.textContent = "Permanently delete account";
    deleteCancel.disabled = false;
    deleteForm.querySelectorAll("input").forEach((input) => { input.disabled = false; });
    updateDeleteConfirmation();
  }
});

// ---------- Your parking permit ----------

const PERMIT_GROUPS = [
  { label: "Commuter “S” zone permit", test: (c) => /^S\d$/.test(c) },
  { label: "Preferred “P” zone permit", test: (c) => /^P\d$/.test(c) },
  { label: "Resident “R” permit", test: (c) => c.startsWith("R-") },
  { label: "Evening permit", test: (c) => c === "E" },
];
let permitCatalogue = null;

function renderPermitDetails(code) {
  const box = $("permit-details");
  if (!code) {
    box.hidden = true;
    return;
  }
  const info = permitCatalogue.permits[code];
  const list = el("ul", "permit-rule-list");
  for (const { where, when } of permitSummary(code)) {
    const li = el("li");
    li.append(el("b", null, when), el("span", null, where));
    list.append(li);
  }
  const note = el("p", "permit-note", `${STALL_NOTE} Overnight parking isn't included unless it's your resident area. `);
  const src = el("a", null, "UCI's permit rules");
  src.href = RULES_SOURCE;
  src.target = "_blank";
  src.rel = "noopener";
  note.append(src);
  box.replaceChildren(
    el("p", "permit-meta", `${info.who} · ${info.price}`),
    el("p", "permit-heading", "Free for you here, at these times"),
    list,
    note,
  );
  box.hidden = false;
  box.classList.remove("enter");
  void box.offsetWidth; // replay the entrance animation
  box.classList.add("enter");
}

async function loadPermits() {
  const select = $("permit-select");
  try {
    permitCatalogue = await api.permitCatalogue();
  } catch (err) {
    showMessage($("permit-message"), err.message, "error");
    return;
  }
  const none = el("option", null, "I don't have a UCI permit");
  none.value = "";
  const groups = PERMIT_GROUPS.map(({ label, test }) => {
    const group = el("optgroup");
    group.label = label;
    for (const code of permitCatalogue.holdable_permits.filter(test)) {
      const option = el("option", null, permitCatalogue.permits[code].name.replaceAll("\"", ""));
      option.value = code;
      group.append(option);
    }
    return group;
  });
  select.replaceChildren(none, ...groups);
  select.value = current?.permit ?? "";
  select.disabled = false;
  renderPermitDetails(select.value);
}

$("permit-select").addEventListener("change", async (e) => {
  const select = e.target;
  const code = select.value || null;
  renderPermitDetails(code);
  select.disabled = true;
  showMessage($("permit-message"), null);
  try {
    current = await api.setPermit(code);
    showMessage(
      $("permit-message"),
      code ? "Saved. The map now shows where this permit lets you park free." : "Saved. The map no longer assumes a permit.",
      "success",
    );
  } catch (err) {
    select.value = current?.permit ?? "";
    renderPermitDetails(select.value);
    showMessage($("permit-message"), err.message, "error");
  } finally {
    select.disabled = false;
  }
});

// ---------- Boot ----------

async function init() {
  try {
    current = await api.me();
    showUser(current);
    loadPermits();
  } catch (err) {
    showMessage($("details-message"), err.message, "error");
  }
}

init();
