import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken } from "./auth.js";

const $ = (id) => document.getElementById(id);
const categories = {
  parking_data: "Parking information",
  map: "Map or directions",
  account: "Account or sign in",
  other: "Other",
};

function toSignIn() {
  clearToken();
  window.ppNavigate("index.html", { replace: true });
}
if (!getToken()) toSignIn();
setUnauthorizedHandler(toSignIn);

function message(id, text, error = false) {
  const node = $(id);
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle("error", error);
}

function issueCard(issue, admin = false) {
  const li = document.createElement("li");
  li.className = "issue-card";
  const head = document.createElement("div");
  head.className = "issue-card-head";
  const title = document.createElement("h3");
  title.textContent = issue.title;
  const badge = document.createElement("span");
  badge.className = `issue-badge ${issue.status}`;
  badge.textContent = issue.status === "resolved" ? "Resolved" : "Open";
  head.append(title, badge);
  const meta = document.createElement("div");
  meta.className = "issue-meta";
  const date = new Date(issue.created_at).toLocaleDateString();
  meta.textContent = `${categories[issue.category] ?? issue.category} · ${date}${admin ? ` · ${issue.reporter}` : ""}`;
  const detail = document.createElement("p");
  detail.textContent = issue.description;
  li.append(head, meta);
  if (issue.location) {
    const place = document.createElement("div");
    place.className = "issue-meta";
    place.textContent = `Place or URL: ${issue.location}`;
    li.append(place);
  }
  li.append(detail);
  if (admin) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = issue.status === "open" ? "Mark resolved" : "Reopen";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api.updateIssue(issue.id, issue.status === "open" ? "resolved" : "open");
        await Promise.all([loadAdmin(), loadMine()]);
      } catch (error) {
        message("admin-message", error.message, true);
        button.disabled = false;
      }
    });
    li.append(button);
  }
  return li;
}

async function loadMine() {
  try {
    const issues = await api.myIssues();
    $("mine-list").replaceChildren(...issues.map((issue) => issueCard(issue)));
    message("mine-message", issues.length ? "" : "You have not sent any reports yet.");
  } catch (error) {
    message("mine-message", error.message, true);
  }
}

async function loadAdmin() {
  message("admin-message", "Loading…");
  try {
    const issues = await api.adminIssues();
    $("admin-list").replaceChildren(...issues.map((issue) => issueCard(issue, true)));
    const open = issues.filter((issue) => issue.status === "open").length;
    message("admin-message", issues.length ? `${open} open · ${issues.length} reports shown` : "No reports yet.");
  } catch (error) {
    message("admin-message", error.message, true);
  }
}

$("issue-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  message("issue-message", "");
  try {
    await api.reportIssue({
      category: $("issue-category").value,
      title: $("issue-title").value.trim(),
      location: $("issue-location").value.trim(),
      description: $("issue-description").value.trim(),
    });
    form.reset();
    message("issue-message", "Report sent. Thank you for helping improve PeterParker.");
    await loadMine();
    if (!$("admin-board").hidden) await loadAdmin();
  } catch (error) {
    message("issue-message", error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("admin-refresh").addEventListener("click", loadAdmin);

async function init() {
  try {
    const user = await api.me();
    $("report-user").textContent = user.username ?? user.email;
    if (user.is_admin) {
      $("admin-board").hidden = false;
      loadAdmin();
    }
    loadMine();
  } catch (error) {
    message("mine-message", error.message, true);
  }
}
init();
