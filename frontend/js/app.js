import { api } from "./api.js";

const statusEl = document.getElementById("api-status");
const form = document.getElementById("item-form");
const input = document.getElementById("item-name");
const list = document.getElementById("item-list");
const errorEl = document.getElementById("error");

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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api.createItem(input.value.trim());
    input.value = "";
    await loadItems();
  } catch (err) {
    showError(err);
  }
});

async function init() {
  try {
    await api.health();
    statusEl.textContent = "online";
    statusEl.classList.add("ok");
    await loadItems();
  } catch (err) {
    statusEl.textContent = "offline";
    statusEl.classList.add("down");
    showError(err);
  }
}

init();
