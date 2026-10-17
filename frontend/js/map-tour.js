import { finishTutorial, needsTutorial } from "./tutorial-state.js";

const STEPS = [
  {
    target: ".search",
    title: "Search for a destination",
    body: "Type a building or place here and choose a result. For example, search Student Center to find parking nearby.",
  },
  {
    target: ".list-tabs",
    title: "Filter parking types",
    body: "Switch between Free, Permit, Paid, and Limited lots. The counts show how many lots are in each category.",
  },
  {
    target: "#map-key",
    title: "Understand the colors",
    body: "The map key explains each colored area. Blue is free, dark gray needs a permit, dashed gray is paid, and red warns of limits or tow risk.",
  },
  {
    target: "#spot-list .spot-item .spot-text",
    fallback: "#spot-list",
    example: true,
    title: "Compare nearby lots",
    body: "Here is Student Center as an example. Nearby lots are ranked by approximate walking distance. Select a lot to see its rules, rates, and rating.",
    fallbackBody: "Choose a destination such as Student Center to rank nearby lots by approximate walking distance. Select a lot to see its rules, rates, and rating.",
  },
  {
    target: "#spot-list .item-actions",
    fallback: "#spot-list .spot-item",
    title: "Get directions or read reviews",
    body: "Directions shows the drive to a lot and the walk to your destination. Reviews contains ratings and tips from the community; you can add your own.",
    fallbackBody: "Select a lot to open its details. From there you can get directions, read community ratings and tips, or add a review.",
  },
  {
    target: ".account .icon-button[href='settings.html']",
    title: "Manage your account",
    body: "Open Settings to change your username, photo, avatar colors, or password. You can return to this tour with the ? button.",
  },
];

let activeTour = null;

export function startMapTour(user, { showExample, clearExample }, force = false) {
  if (activeTour || (!force && !needsTutorial(user))) return;

  const layer = document.createElement("div");
  layer.className = "map-tour-layer";
  layer.innerHTML = `
    <div class="map-tour-blocker"></div>
    <div class="map-tour-spotlight" aria-hidden="true"></div>
    <section class="map-tour-card" role="dialog" aria-modal="true" aria-labelledby="map-tour-title" tabindex="-1">
      <div class="map-tour-heading"><span id="map-tour-count"></span><button class="map-tour-skip" type="button">Skip tour</button></div>
      <h2 id="map-tour-title"></h2>
      <p id="map-tour-body"></p>
      <div class="map-tour-actions"><button class="map-tour-back" type="button">Back</button><button class="map-tour-next" type="button">Next</button></div>
    </section>`;
  document.body.append(layer);

  const spotlight = layer.querySelector(".map-tour-spotlight");
  const card = layer.querySelector(".map-tour-card");
  const back = layer.querySelector(".map-tour-back");
  const next = layer.querySelector(".map-tour-next");
  const skip = layer.querySelector(".map-tour-skip");
  let stepIndex = 0;
  let exampleShown = false;
  let updateFrame = 0;
  let settleTimer = 0;
  activeTour = layer;

  function position() {
    const step = STEPS[stepIndex];
    const target = document.querySelector(step.target) ?? document.querySelector(step.fallback ?? "#panel");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const pad = 7;
    const left = Math.max(4, rect.left - pad);
    const top = Math.max(4, rect.top - pad);
    const width = Math.min(window.innerWidth - left - 4, rect.width + pad * 2);
    const height = Math.min(window.innerHeight - top - 4, rect.height + pad * 2);
    Object.assign(spotlight.style, {
      left: `${left}px`, top: `${top}px`, width: `${Math.max(20, width)}px`, height: `${Math.max(20, height)}px`,
    });

    const gap = 18;
    const margin = 12;
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const clamp = (value, max) => Math.max(margin, Math.min(value, max - margin));
    const centerY = clamp(top + height / 2 - cardHeight / 2, window.innerHeight - cardHeight);
    const centerX = clamp(left + width / 2 - cardWidth / 2, window.innerWidth - cardWidth);
    let x, y;
    if (window.innerWidth - (left + width) >= cardWidth + gap + margin) {
      x = left + width + gap; y = centerY;
    } else if (left >= cardWidth + gap + margin) {
      x = left - cardWidth - gap; y = centerY;
    } else if (top >= cardHeight + gap + margin) {
      x = centerX; y = top - cardHeight - gap;
    } else if (window.innerHeight - (top + height) >= cardHeight + gap + margin) {
      x = centerX; y = top + height + gap;
    } else {
      x = clamp((window.innerWidth - cardWidth) / 2, window.innerWidth - cardWidth);
      y = top > window.innerHeight / 2 ? margin : window.innerHeight - cardHeight - margin;
    }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function schedulePosition() {
    cancelAnimationFrame(updateFrame);
    updateFrame = requestAnimationFrame(position);
  }

  function render() {
    const step = STEPS[stepIndex];
    if (stepIndex < 5 && stepIndex !== 2 && document.getElementById("panel").classList.contains("collapsed")) {
      document.getElementById("panel-toggle").click();
    }
    if (stepIndex === 2 && document.getElementById("map-key").classList.contains("collapsed")) {
      document.getElementById("key-toggle").click();
    }
    if (step.example && !exampleShown) {
      exampleShown = Boolean(showExample());
      document.getElementById("spot-list").scrollTop = 0;
    }
    if (stepIndex === 3 || stepIndex === 4) {
      document.querySelector(step.target)?.scrollIntoView({ block: "nearest" });
    }
    layer.querySelector("#map-tour-count").textContent = `${stepIndex + 1} / ${STEPS.length}`;
    layer.querySelector("#map-tour-title").textContent = step.title;
    layer.querySelector("#map-tour-body").textContent = !exampleShown && step.fallbackBody ? step.fallbackBody : step.body;
    back.disabled = stepIndex === 0;
    next.textContent = stepIndex === STEPS.length - 1 ? "Start exploring" : "Next";
    schedulePosition();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(schedulePosition, 450); // panel and map animations can move the target
  }

  function close() {
    finishTutorial(user);
    if (exampleShown) clearExample();
    cancelAnimationFrame(updateFrame);
    clearTimeout(settleTimer);
    window.removeEventListener("resize", schedulePosition);
    document.removeEventListener("scroll", schedulePosition, true);
    document.removeEventListener("keydown", onKeydown);
    layer.remove();
    activeTour = null;
    document.getElementById("tour-help").focus();
  }

  function onKeydown(event) {
    if (event.key === "Escape") return close();
    if (event.key !== "Tab") return;
    const buttons = [skip, back, next].filter((button) => !button.disabled);
    const first = buttons[0];
    const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  back.addEventListener("click", () => { if (stepIndex > 0) { stepIndex--; render(); card.focus(); } });
  next.addEventListener("click", () => {
    if (stepIndex === STEPS.length - 1) return close();
    stepIndex++;
    render();
    card.focus();
  });
  skip.addEventListener("click", close);
  window.addEventListener("resize", schedulePosition);
  document.addEventListener("scroll", schedulePosition, true);
  document.addEventListener("keydown", onKeydown);
  render();
  skip.focus();
}
