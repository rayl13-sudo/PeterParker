import { finishTutorial, needsTutorial } from "./tutorial-state.js";

const STEPS = [
  {
    target: ".search",
    title: "Search for a destination",
    body: "Type a building or place here and choose a result. For example, search Student Center to find parking nearby.",
  },
  {
    target: ".filters",
    title: "Filter parking",
    body: "Tap Free, Permit, Paid, or Limited to show only those lots (combine as many as you like), and pick a minimum star rating. You can also just type \"free parking\" or \"4 stars\" in the search box.",
  },
  {
    target: "#map-key",
    title: "Understand the colors",
    body: "The map key explains each colored area. Blue is free, dark gray needs a permit, purple is faculty & staff, dashed gray is paid, and red warns of limits or tow risk.",
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
    body: "Directions shows the drive to a lot and the walk to your destination; change From or To any time to re-plan. Reviews contains ratings and tips from the community; you can add your own.",
    fallbackBody: "Select a lot to open its details. From there you can get directions, read community ratings and tips, or add a review.",
  },
  {
    target: "#account-menu summary",
    title: "Manage your account",
    body: "Open the three-dot menu for Settings, Parking tricks, or this tutorial. Settings lets you change your username, photo, avatar colors, or password.",
  },
];

let activeTour = null;

export function startMapTour(user, { showExample, clearExample, prepareStep, onClose }, force = false) {
  if (activeTour || (!force && !needsTutorial(user))) return;

  const layer = document.createElement("div");
  layer.className = "map-tour-layer";
  layer.innerHTML = `
    <div class="map-tour-blocker"></div>
    <div class="map-tour-spotlight" aria-hidden="true"></div>
    <section class="map-tour-card" role="dialog" aria-modal="true" aria-labelledby="map-tour-title" tabindex="-1">
      <div class="map-tour-heading"><span id="map-tour-count"></span><button class="map-tour-skip" type="button">Skip tour</button></div>
      <div class="map-tour-content">
        <h2 id="map-tour-title"></h2>
        <p id="map-tour-body"></p>
      </div>
      <div class="map-tour-actions"><button class="map-tour-back" type="button">Back</button><button class="map-tour-next" type="button">Next</button></div>
    </section>`;
  document.body.append(layer);
  document.body.classList.add("map-tour-active");

  const spotlight = layer.querySelector(".map-tour-spotlight");
  const card = layer.querySelector(".map-tour-card");
  const back = layer.querySelector(".map-tour-back");
  const next = layer.querySelector(".map-tour-next");
  const skip = layer.querySelector(".map-tour-skip");
  let stepIndex = 0;
  let exampleShown = false;
  let exampleAttempted = false;
  let updateFrame = 0;
  let settleTimer = 0;
  activeTour = layer;

  function position() {
    const step = STEPS[stepIndex];
    const target = document.querySelector(step.target) ?? document.querySelector(step.fallback ?? "#panel");
    if (!target) return;
    const viewport = window.visualViewport;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const mobile = window.matchMedia("(max-width: 640px)").matches;
    const landscape = mobile && viewportWidth >= 500 && viewportHeight <= 450 && stepIndex !== 5;
    card.style.width = landscape ? `${Math.min(300, viewportWidth * 0.46)}px` : "";
    const scrollArea = target.closest(".panel-body");
    if (mobile && scrollArea) {
      const delta = target.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top - 10;
      if (Math.abs(delta) > 1) scrollArea.scrollTop += delta;
    }
    const rect = target.getBoundingClientRect();
    const pad = 7;
    const left = Math.max(4, rect.left - pad);
    const top = Math.max(4, rect.top - pad);
    const width = Math.min(viewportWidth - left - 4, rect.width + pad * 2);
    const height = Math.min(viewportHeight - top - 4, rect.height + pad * 2);
    Object.assign(spotlight.style, {
      left: `${left}px`, top: `${top}px`, width: `${Math.max(20, width)}px`, height: `${Math.max(20, height)}px`,
    });

    const gap = 18;
    const margin = 12;
    // On phones keep the explanation below the actual target. The explanation
    // scrolls independently on short/landscape screens; navigation stays visible.
    card.style.maxHeight = mobile && !landscape
      ? `${Math.max(110, Math.min(320, viewportHeight * 0.48, viewportHeight - top - height - gap - margin))}px`
      : `${viewportHeight - margin * 2}px`;
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const clamp = (value, max) => Math.max(margin, Math.min(value, max - margin));
    const centerY = clamp(top + height / 2 - cardHeight / 2, window.innerHeight - cardHeight);
    const centerX = clamp(left + width / 2 - cardWidth / 2, window.innerWidth - cardWidth);
    let x, y;
    if (landscape) {
      x = viewportWidth - cardWidth - margin;
      y = Math.max(margin, (viewportHeight - cardHeight) / 2);
    } else if (mobile) {
      x = Math.max(margin, (viewportWidth - cardWidth) / 2);
      y = viewportHeight - cardHeight - margin;
    } else if (window.innerWidth - (left + width) >= cardWidth + gap + margin) {
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
    prepareStep?.(stepIndex);
    if (stepIndex < 5 && stepIndex !== 2 && document.getElementById("panel").classList.contains("collapsed")) {
      document.getElementById("panel-toggle").click();
    }
    if (stepIndex === 2 && document.getElementById("map-key").classList.contains("collapsed")) {
      document.getElementById("key-toggle").click();
    }
    if (step.example && !exampleShown) {
      exampleAttempted = true;
      exampleShown = Boolean(showExample());
      document.getElementById("spot-list").scrollTop = 0;
    }
    if (stepIndex === 3 || stepIndex === 4) {
      const target = document.querySelector(step.target);
      const scroller = target?.closest(window.matchMedia("(max-width: 640px)").matches ? ".panel-body" : "#spot-list");
      if (scroller) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 10;
    }
    layer.querySelector("#map-tour-count").textContent = `${stepIndex + 1} / ${STEPS.length}`;
    layer.querySelector("#map-tour-title").textContent = step.title;
    layer.querySelector("#map-tour-body").textContent = !exampleShown && step.fallbackBody ? step.fallbackBody : step.body;
    back.disabled = stepIndex === 0;
    next.textContent = stepIndex === STEPS.length - 1 ? "Start exploring" : "Next";
    card.querySelector(".map-tour-content").scrollTop = 0;
    schedulePosition();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(schedulePosition, 450); // panel and map animations can move the target
  }

  function close() {
    finishTutorial(user);
    if (exampleAttempted) clearExample();
    onClose?.();
    cancelAnimationFrame(updateFrame);
    clearTimeout(settleTimer);
    window.removeEventListener("resize", resize);
    window.visualViewport?.removeEventListener("resize", resize);
    observer.disconnect();
    document.removeEventListener("scroll", schedulePosition, true);
    document.removeEventListener("keydown", onKeydown);
    layer.remove();
    document.body.classList.remove("map-tour-active");
    activeTour = null;
    document.querySelector("#account-menu summary").focus({ preventScroll: true });
  }

  function resize() {
    prepareStep?.(stepIndex);
    schedulePosition();
  }

  const observer = new ResizeObserver(schedulePosition);
  observer.observe(card);
  observer.observe(document.getElementById("panel"));

  function onKeydown(event) {
    if (event.key === "Escape") return close();
    if (event.key !== "Tab") return;
    const buttons = [skip, back, next].filter((button) => !button.disabled);
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!buttons.includes(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  back.addEventListener("click", () => { if (stepIndex > 0) { stepIndex--; render(); card.focus({ preventScroll: true }); } });
  next.addEventListener("click", () => {
    if (stepIndex === STEPS.length - 1) return close();
    stepIndex++;
    render();
    card.focus({ preventScroll: true });
  });
  skip.addEventListener("click", close);
  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
  document.addEventListener("scroll", schedulePosition, true);
  document.addEventListener("keydown", onKeydown);
  render();
  skip.focus({ preventScroll: true });
}
