import { api } from "./api.js";
import { clearToken, getToken } from "./auth.js";
import { finishTutorial } from "./tutorial-state.js";

const steps = [...document.querySelectorAll(".tour-step")];
const counter = document.getElementById("tour-counter");
const progress = document.getElementById("tour-progress");
const back = document.getElementById("tour-back");
const next = document.getElementById("tour-next");
const skip = document.getElementById("tour-skip");
let current = 0;
let user;

function render(focusHeading = false) {
  steps.forEach((step, index) => { step.hidden = index !== current; });
  counter.textContent = `Step ${current + 1} of ${steps.length}`;
  progress.style.width = `${((current + 1) / steps.length) * 100}%`;
  progress.parentElement.setAttribute("aria-valuenow", String(current + 1));
  back.disabled = current === 0;
  next.textContent = current === steps.length - 1 ? "Open map" : "Next feature";
  if (focusHeading) steps[current].querySelector("h1").focus();
}

function openMap() {
  finishTutorial(user);
  location.replace("map.html");
}

back.addEventListener("click", () => {
  if (current > 0) { current -= 1; render(true); }
});
next.addEventListener("click", () => {
  if (current === steps.length - 1) return openMap();
  current += 1;
  render(true);
});
skip.addEventListener("click", openMap);

async function init() {
  if (!getToken()) return location.replace("index.html");
  try {
    user = await api.me();
    render();
    document.getElementById("tour-loading").hidden = true;
    document.getElementById("tour-shell").hidden = false;
    skip.hidden = false;
  } catch {
    clearToken();
    location.replace("index.html");
  }
}

init();
