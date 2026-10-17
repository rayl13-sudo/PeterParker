// Map page: OpenStreetMap of UC Irvine with every parking lot shaded by category
// (free, permit, paid, limited/tow risk) and marked, with UCI permit and
// daily-pass details, what each lot is for, and tow/time-limit warnings in popups.
// Leaflet is loaded as a global (L) by map.html.
import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken } from "./auth.js";
import { renderAvatar } from "./avatar.js";
import { averageRating, initReviews, openReviews, ratingLabel } from "./reviews.js";
import { startMapTour } from "./map-tour.js";
import { createMapHistory } from "./map-history.mjs";

const SIGN_IN_PAGE = "index.html";
const UCI_CENTER = [33.6461, -117.8427]; // Aldrich Park, middle of campus
// Start this many zoom levels past the fit-all-lots view. Each level is 2x, so 2 = 4x.
const EXTRA_ZOOM = 2;

// One entry per lot category: drives the map shading, markers, popups, the key and
// the list order. Blue = free, gray = costs something, light red = you might be
// ticketed or towed. Paid lots get a dashed edge to read differently from permit lots.
const CATEGORIES = {
  free: { label: "Free", color: "#3f5fae", fillOpacity: 0.55, marker: "pin" },
  permit: { label: "Permit required", color: "#3d4457", fillOpacity: 0.4 },
  paid: { label: "Paid", color: "#6b7184", fillOpacity: 0.12, dashArray: "5 4", weight: 2 },
  limited: { label: "Limited / may be towed", color: "#e06f68", fillOpacity: 0.3, marker: "dot" },
};
const CATEGORY_ORDER = Object.keys(CATEGORIES);
const isFree = (lot) => lot.category === "free";

const $ = (id) => document.getElementById(id);
let mapHistory = null;
let savedView = false;

function rememberTarget(type, id) {
  mapHistory?.remember({ type, id });
  renderRecentShortcuts();
}

function saveButton(type, id, name, compact = false) {
  const button = el("button", "save-place");
  button.type = "button";
  const update = () => {
    const saved = mapHistory?.isSaved({ type, id }) ?? false;
    button.setAttribute("aria-pressed", String(saved));
    button.setAttribute("aria-label", `${saved ? "Remove" : "Save"} ${name} ${saved ? "from" : "to"} saved places`);
    button.title = saved ? "Remove from saved places" : "Save place";
    button.textContent = compact ? (saved ? "★" : "☆") : (saved ? "★ Saved" : "☆ Save");
  };
  update();
  button.addEventListener("click", () => {
    mapHistory?.toggleSaved({ type, id });
    update();
    updateSavedButton();
    renderList();
  });
  return button;
}

function updateSavedButton() {
  $("saved-count").textContent = mapHistory?.saved().length ? `(${mapHistory.saved().length})` : "";
  $("saved-toggle").setAttribute("aria-pressed", String(savedView));
}

function toSignIn() {
  clearToken();
  window.ppNavigate(SIGN_IN_PAGE, { replace: true });
}

if (!getToken()) toSignIn();
setUnauthorizedHandler(toSignIn);

// ---------- Remembered UI state (best effort; storage may be unavailable) ----------

function loadFlag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Not critical.
  }
}

// ---------- Map ----------

const map = L.map("map", { zoomControl: false, dragging: true }).setView(UCI_CENTER, 16);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

function pinIcon(lot) {
  return L.divIcon({
    className: "pin",
    html: `<svg viewBox="0 0 28 36" width="28" height="36" aria-hidden="true">
      <path fill="${CATEGORIES[lot.category].color}"
            d="M14 1C7 1 1.5 6.4 1.5 13.3 1.5 22.6 14 35 14 35s12.5-12.4 12.5-21.7C26.5 6.4 21 1 14 1Z"/>
      <text x="14" y="18" text-anchor="middle">P</text>
    </svg>`,
    iconSize: [28, 36],
    iconAnchor: [14, 35],
    popupAnchor: [0, -32],
  });
}

// Visitor prices and hours from UCI (filled in from the API response).
let permitInfo = null;
const VISITOR_PERMIT = "GNA"; // one-day General visitor permit

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const memberPermits = (lot) => lot.permits.filter((p) => p.code !== VISITOR_PERMIT);
const takesVisitorPass = (lot) => lot.permits.some((p) => p.code === VISITOR_PERMIT);

function permitSection(lot) {
  const section = el("div", "popup-section");
  section.append(el("h4", null, "Permits accepted"));
  const permits = memberPermits(lot);
  if (!permits.length) {
    section.append(el("p", null, "UCI permit required. UCI's public permit pages don't say which permit this lot takes."));
    return section;
  }
  const list = el("ul", "permit-list");
  for (const permit of permits) {
    const li = el("li");
    li.append(el("b", null, permit.name), el("span", null, `${permit.who} · ${permit.price}`));
    list.append(li);
  }
  section.append(list);
  if (lot.permit_note) section.append(el("p", "popup-note", lot.permit_note));
  return section;
}

function dailyPassSection(lot) {
  const section = el("div", "popup-section");
  section.append(el("h4", null, "Daily pass"));
  const surface = lot.parking === "surface";
  const rates = permitInfo.visitor_rates.filter((r) => !r.name.startsWith("Overnight") || (surface && takesVisitorPass(lot)));
  const table = el("ul", "rate-list");
  for (const rate of rates) {
    const li = el("li");
    li.title = rate.where;
    li.append(el("span", null, rate.name), el("b", null, rate.price));
    table.append(li);
  }
  section.append(table);
  section.append(
    el("p", "popup-note", takesVisitorPass(lot)
      ? "Weekdays 7 a.m.–midnight in general stalls; buy at a kiosk, dispenser or PARKbyPLATE."
      : "Weekdays: check the signs or dispenser at this lot for which pass applies."),
    el("p", "popup-note", "Evenings after 5 p.m. and weekends: the $16 one-day General pass works in general, P and AR stalls."),
  );
  return section;
}

function warningBox(lot) {
  const box = el("div", "popup-warning");
  box.append(el("b", null, lot.time_limit ? `⚠ ${lot.time_limit} max · tow risk` : "⚠ May be ticketed or towed"));
  box.append(el("p", null, lot.warning ?? "This isn't public parking. Park only if you're visiting what it serves, and check the posted signs."));
  if (lot.warning_source) {
    const src = el("a", null, "Source");
    src.href = lot.warning_source;
    src.target = "_blank";
    src.rel = "noopener";
    box.append(src);
  }
  return box;
}

function popupContent(lot) {
  rememberTarget("lot", lot.id);
  const cat = CATEGORIES[lot.category];
  const root = el("div", "popup");

  const tag = el("span", "tag", cat.label);
  tag.style.setProperty("--tag-color", cat.color);
  root.append(el("strong", null, lot.name), tag);

  if (lot.serves.length) {
    const serves = el("p", "popup-serves");
    serves.append(el("b", null, "For: "), document.createTextNode(lot.serves.join(" · ")));
    root.append(serves);
  }

  const details = [
    lot.restriction && `Who can park: ${lot.restriction}`,
    lot.time_limit && `Time limit: ${lot.time_limit}`,
    lot.permit_accepted && "UCI permits also accepted",
    lot.inferred,
    lot.capacity && `${lot.capacity.toLocaleString()} spaces`,
    lot.opening_hours && `Hours: ${lot.opening_hours}`,
  ].filter(Boolean);
  for (const text of details) root.append(el("p", null, text));

  if (lot.category === "limited") root.append(warningBox(lot));

  if (lot.uci && (lot.category === "permit" || lot.category === "paid")) {
    root.append(permitSection(lot));
    if (lot.category === "paid" || takesVisitorPass(lot)) {
      root.append(dailyPassSection(lot));
    } else {
      root.append(el("p", "popup-note", "Evenings after 5 p.m. and weekends: a $16 one-day General pass works in general, P and AR stalls."));
    }
    const source = el("a", "popup-source", `Rates: UCI Transportation, ${permitInfo.academic_year}`);
    source.href = "https://parking.uci.edu/permits/visitor";
    source.target = "_blank";
    source.rel = "noopener";
    root.append(source);
  }

  const rating = ratingLabel("lot", lot.id);
  const actions = el("div", "popup-actions");
  const go = el("button", "pill-button primary", "Directions");
  go.type = "button";
  go.addEventListener("click", () => {
    map.closePopup();
    startDirections(lot);
  });
  const reviews = el("button", "pill-button", rating ? `Reviews · ${rating}` : "Reviews");
  reviews.type = "button";
  reviews.addEventListener("click", () => {
    map.closePopup();
    showLotReviews(lot);
  });
  actions.append(go, reviews, saveButton("lot", lot.id, lot.name));
  root.append(actions);
  return root;
}

const POPUP_OPTIONS = { maxWidth: 300, maxHeight: 380 };

function dot(lot) {
  const cat = CATEGORIES[lot.category];
  return L.circleMarker([lot.lat, lot.lon], {
    radius: 6,
    color: "#fff",
    weight: 2,
    fillColor: cat.color,
    fillOpacity: 1,
  });
}

// Each lot is shaded by its outline; free lots also get a pin and limited lots a dot
// so every spot is easy to find. Lots mapped as a single point only get the marker.
function addLot(lot) {
  const cat = CATEGORIES[lot.category];
  const area = lot.outline.length
    ? L.polygon(lot.outline, {
        color: cat.color,
        weight: cat.weight ?? 1.5,
        fillColor: cat.color,
        fillOpacity: cat.fillOpacity,
        dashArray: cat.dashArray,
      })
        .bindPopup(() => popupContent(lot), POPUP_OPTIONS)
        .addTo(map)
    : null;

  const marker =
    cat.marker === "pin"
      ? L.marker([lot.lat, lot.lon], { icon: pinIcon(lot), title: lot.name, zIndexOffset: 500 })
      : cat.marker === "dot" || !area
        ? dot(lot)
        : null;
  if (marker) {
    marker.addTo(map);
    if (area) marker.on("click", () => area.openPopup([lot.lat, lot.lon]));
    else marker.bindPopup(() => popupContent(lot), POPUP_OPTIONS);
  }
  // `primary` is what a list click "clicks" to open the popup.
  return { area, marker, primary: marker ?? area };
}

// ---------- Side list ----------

let listEntries = []; // [{ lot, area, marker, primary }]

function listMeta(lot) {
  const cat = CATEGORIES[lot.category];
  if (lot.category === "paid") return "One-day pass $16 · Reserved $20 · Hourly $4–$5";
  if (lot.category === "limited") {
    if (lot.utc) return `University Town Center · ${lot.time_limit} max · tow risk`;
    return [lot.restriction.split(":")[0].split(";")[0], lot.serves[0]?.split(" (")[0]].filter(Boolean).join(" · ");
  }
  if (lot.category === "permit") {
    const codes = memberPermits(lot).map((p) => (p.code === "S-ANY" ? "any S/P zone" : p.code));
    const visitors = takesVisitorPass(lot) ? "Visitors $16/day" : null;
    if (!codes.length) {
      if (!lot.uci) return cat.label;
      return visitors ? `${visitors} · permit type not published` : "UCI permit (type not published)";
    }
    return [`Permits: ${codes.join(", ")}`, visitors].filter(Boolean).join(" · ");
  }
  return cat.label + (lot.capacity ? ` · ${lot.capacity} spaces` : "");
}

function listItem({ lot, primary: layer }, walkMeters) {
  const btn = el("button", "spot-item");
  btn.type = "button";
  const swatch = el("i", "swatch");
  swatch.style.background = CATEGORIES[lot.category].color;
  const text = el("span", "spot-text");
  const meta = walkMeters == null ? listMeta(lot) : `${walkLabel(walkMeters)} · ${CATEGORIES[lot.category].label}`;
  text.append(el("span", null, lot.name), el("small", null, meta));
  const rating = ratingLabel("lot", lot.id);
  if (rating) text.append(el("small", "rating-line", rating));
  btn.append(swatch, text);
  btn.addEventListener("click", () => focusLot({ lot, primary: layer }));
  const li = el("li");
  li.className = "savable-row";
  li.append(btn, saveButton("lot", lot.id, lot.name, true));
  if (walkMeters != null) {
    const actions = el("div", "item-actions");
    const go = el("button", "pill-button primary", "Directions");
    go.type = "button";
    go.setAttribute("aria-label", `Directions via ${lot.name}`);
    go.addEventListener("click", () => startDirections(lot));
    const reviews = el("button", "pill-button", "Reviews");
    reviews.type = "button";
    reviews.setAttribute("aria-label", `Reviews of ${lot.name}`);
    reviews.addEventListener("click", () => showLotReviews(lot));
    actions.append(go, reviews);
    li.append(actions);
  }
  return li;
}

function placeItem(place) {
  const btn = el("button", "spot-item place-item");
  btn.type = "button";
  btn.innerHTML = PLACE_ICON;
  const text = el("span", "spot-text");
  text.append(el("span", null, place.name), el("small", null, place.kind ? `${place.kind} · show nearby parking` : "Show nearby parking"));
  const rating = ratingLabel("place", place.id);
  if (rating) text.append(el("small", "rating-line", rating));
  btn.append(text);
  btn.addEventListener("click", () => setDestination(place));
  const li = el("li");
  li.className = "savable-row";
  li.append(btn, saveButton("place", place.id, place.name, true));
  return li;
}

const sectionHeading = (text) => el("li", "list-heading", text);

// Shown above the closest lots once a destination is picked, inviting a look at its reviews.
function placeCard(place) {
  const li = el("li", "place-card");
  li.append(el("strong", null, place.name));
  li.append(saveButton("place", place.id, place.name));
  if (place.kind) li.append(el("small", null, place.kind));
  const rating = ratingLabel("place", place.id);
  li.append(el("p", "rating-line", rating ?? "No reviews yet"));
  const btn = el("button", "pill-button", rating ? "See reviews" : "Be the first to review");
  btn.type = "button";
  btn.addEventListener("click", () => showPlaceReviews(place));
  li.append(btn);
  return li;
}

function showLotReviews(lot) {
  openReviews({ type: "lot", id: lot.id, name: lot.name, kind: CATEGORIES[lot.category].label });
}

function showPlaceReviews(place) {
  openReviews({ type: "place", id: place.id, name: place.name, kind: place.kind });
}

function listTitle(cats, minStars) {
  const names = CATEGORY_ORDER.filter((c) => cats.has(c)).map((c) => FILTER_NAMES[c]);
  const what = names.length ? `${names.join(" & ")} parking` : "Parking";
  const title = `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
  return minStars ? `${title} rated ${minStars}+ ★` : `${title} near UCI`;
}

// Rebuilds the side list. With `animate`, items cascade in (used for chip clicks,
// picking a destination, first load; not on every keystroke).
function renderList({ animate = false } = {}) {
  if (!animate) $("spot-list").classList.remove("enter");
  buildList();
  if (animate) animateList();
}

function animateList() {
  const list = $("spot-list");
  [...list.children].slice(0, 14).forEach((li, i) => li.style.setProperty("--i", i));
  list.classList.remove("enter");
  void list.offsetWidth; // restart the animation
  list.classList.add("enter");
}

function buildList() {
  const { categories: cats, minStars, text } = activeFilters();
  updateSavedButton();

  if (savedView && !destination) {
    const items = (mapHistory?.saved() ?? []).map((item) => {
      if (item.type === "place") {
        const place = places.find((candidate) => candidate.id === item.id);
        return place ? placeItem(place) : null;
      }
      const entry = listEntries.find((candidate) => candidate.lot.id === item.id);
      return entry ? listItem(entry) : null;
    }).filter(Boolean);
    $("panel-title").textContent = "Saved places";
    $("spot-count").textContent = `${items.length} saved ${items.length === 1 ? "place" : "places"}`;
    $("spot-list").replaceChildren(...(items.length ? items : [el("li", "no-results", "Use ☆ beside a place or parking lot to save it here.")]));
    return;
  }

  if (destination) {
    $("panel-title").textContent = `Parking near ${destination.name}`;
    const usable = nearest.filter(({ entry }) => entry.lot.category !== "limited");
    const risky = nearest.filter(({ entry }) => entry.lot.category === "limited");
    const filtered = cats.size || minStars;
    $("spot-count").textContent = filtered ? `Closest ${listTitle(cats, minStars).toLowerCase().replace(" near uci", "")}` : "Closest lots by walking distance";
    const items = [placeCard(destination)];
    if (usable.length) items.push(sectionHeading("Closest parking"), ...usable.map(({ entry, meters }) => listItem(entry, meters)));
    if (risky.length) items.push(sectionHeading(usable.length ? "Also nearby: may be towed" : "Closest (may be towed)"), ...risky.map(({ entry, meters }) => listItem(entry, meters)));
    if (!usable.length && !risky.length) items.push(el("li", "no-results", "No nearby lots match these filters."));
    $("spot-list").replaceChildren(...items);
    return;
  }

  const lots = filteredEntries;
  $("panel-title").textContent = text ? "Search results" : listTitle(cats, minStars);
  const parts = [];
  if (placeResults.length) parts.push(`${placeResults.length} ${placeResults.length === 1 ? "place" : "places"}`);
  parts.push(`${lots.length} ${lots.length === 1 ? "lot" : "lots"}`);
  $("spot-count").textContent = text ? `${parts.join(" and ")} for “${text}”` : parts.join(" and ");
  const items = [];
  if (placeResults.length) items.push(sectionHeading("Places: pick one to see the closest parking"), ...placeResults.map(placeItem));
  if (lots.length) items.push(...(placeResults.length ? [sectionHeading("Parking lots")] : []), ...lots.map((e) => listItem(e)));
  if (!items.length) {
    const hint = minStars ? "No rated lots match yet. Try a lower rating." : "Nothing matches. Try a shorter or different word.";
    items.push(el("li", "no-results", hint));
  }
  $("spot-list").replaceChildren(...items);
}

$("saved-toggle").addEventListener("click", () => {
  const opening = !savedView;
  clearSearch();
  savedView = opening;
  $("search-shortcuts").hidden = true;
  renderList();
});

// ---------- Search: bold matching lots, fade the rest, as you type ----------

let filteredEntries = []; // lots passing the current filters (all lots when none are on)
let placeResults = []; // buildings/places matching the search
let places = []; // searchable destinations, from /api/places
let destination = null; // the chosen place, once picked
let nearest = []; // [{ entry, meters }] closest lots to the destination
let destinationMarker = null;
let fitTimer = null;
const NEAREST_LOTS = 6;
const NEAREST_RISKY = 2;
const MAX_PLACE_RESULTS = 6;

// Chips under the search box. Words typed in the search box can switch these on too.
const chipFilters = { categories: new Set(), minStars: 0 };
const FILTER_NAMES = { free: "free", permit: "permit", paid: "paid", limited: "limited" };
const CATEGORY_WORDS = {
  free: "free", paid: "paid", pay: "paid", meter: "paid", metered: "paid", fee: "paid",
  permit: "permit", permits: "permit", uci: "permit",
  limited: "limited", tow: "limited", towing: "limited", private: "limited", customers: "limited",
};
// Only dropped when a category or rating word is typed, so "parking" alone still matches names.
const FILLER_WORDS = new Set(["parking", "park", "lot", "lots", "spot", "spots", "space", "spaces", "near", "with", "and", "or", "rated", "rating", "only"]);

let parsedQuery = { tokens: [], categories: new Set(), minStars: 0, text: "" };

// "free parking", "paid lots", "4+ stars", "permit 4 stars mesa" -> categories, rating, words.
function parseQuery(raw) {
  let rest = raw.toLowerCase();
  let minStars = 0;
  const stars = rest.match(/(\d(?:\.\d)?)\s*\+?\s*(?:stars?|★)/);
  if (stars) {
    minStars = Math.min(5, Math.max(1, Number(stars[1])));
    rest = rest.replace(stars[0], " ");
  }
  let tokens = normalize(rest).split(" ").filter(Boolean);
  const categories = new Set(tokens.filter((t) => CATEGORY_WORDS[t]).map((t) => CATEGORY_WORDS[t]));
  if (categories.size || minStars) {
    tokens = tokens.filter((t) => !CATEGORY_WORDS[t] && !FILLER_WORDS.has(t));
  }
  return { tokens, categories, minStars, text: raw.trim() };
}

// Chips and typed words combined.
function activeFilters() {
  return {
    categories: new Set([...chipFilters.categories, ...parsedQuery.categories]),
    minStars: Math.max(chipFilters.minStars, parsedQuery.minStars),
    tokens: parsedQuery.tokens,
    text: parsedQuery.text,
  };
}

function passes(lot, { categories, minStars, tokens }, { ignoreText = false } = {}) {
  if (categories.size && !categories.has(lot.category)) return false;
  if (minStars && !((averageRating("lot", lot.id) ?? 0) >= minStars)) return false;
  return ignoreText || tokens.every((t) => searchableText(lot).includes(t));
}

// After a chip removes typed filter words, drop leftovers like "parking" or "lots" too.
function setSearchText(text) {
  let value = text.replace(/\s+/g, " ").trim();
  if (normalize(value).split(" ").filter(Boolean).every((t) => FILLER_WORDS.has(t))) value = "";
  $("search").value = value;
  $("search-clear").hidden = !value;
  parsedQuery = parseQuery(value);
}

function syncChips() {
  document.querySelectorAll(".chip-toggle[data-category]").forEach((chip) => {
    const c = chip.dataset.category;
    const byChip = chipFilters.categories.has(c);
    const byText = parsedQuery.categories.has(c);
    chip.setAttribute("aria-pressed", String(byChip || byText));
    chip.classList.toggle("implied", byText && !byChip); // switched on by typing
  });
  const stars = Math.max(chipFilters.minStars, parsedQuery.minStars);
  document.querySelectorAll(".star-chip").forEach((chip) => {
    const on = Number(chip.dataset.stars) === stars;
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("implied", on && parsedQuery.minStars > chipFilters.minStars);
  });
}

const PLACE_ICON =
  '<svg class="place-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/></svg>';

// Lowercase, no accents or punctuation, so "trader joes" finds "Trader Joe's".
const normalize = (text) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, "") // apostrophes vanish: "Joe's" -> "joes"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const searchIndex = new Map(); // lot id -> normalized name + the places it serves
const searchableText = (lot) => {
  if (!searchIndex.has(lot.id)) searchIndex.set(lot.id, normalize([lot.name, ...lot.serves].join(" ")));
  return searchIndex.get(lot.id);
};

function setLotState({ lot, area, marker }, state) {
  const cat = CATEGORIES[lot.category];
  const weight = cat.weight ?? 1.5;
  const styles = {
    normal: { weight, opacity: 1, fillOpacity: cat.fillOpacity },
    match: { weight: weight + 2.5, opacity: 1, fillOpacity: Math.min(cat.fillOpacity + 0.3, 0.85) },
    dim: { weight: 1, opacity: 0.15, fillOpacity: cat.fillOpacity * 0.15 },
  };
  if (area) {
    area.setStyle(styles[state]);
    if (state === "match") area.bringToFront();
  }
  if (!marker) return;
  if (marker instanceof L.CircleMarker) {
    const faded = state === "dim" ? 0.2 : 1;
    marker.setStyle({ opacity: faded, fillOpacity: faded }).setRadius(state === "match" ? 8 : 6);
    if (state === "match") marker.bringToFront();
  } else {
    marker.setOpacity(state === "dim" ? 0.2 : 1);
    marker.setZIndexOffset(state === "match" ? 1000 : 500);
    marker.getElement()?.classList.toggle("match", state === "match");
  }
}

function fitToResults(entries, extraPoint) {
  if (!entries.length && !extraPoint) return;
  const bounds = L.latLngBounds([]);
  if (extraPoint) bounds.extend(L.latLng(extraPoint.lat, extraPoint.lon));
  for (const { lot, area } of entries) {
    bounds.extend(area ? area.getBounds() : L.latLng(lot.lat, lot.lon));
  }
  fitBoundsAroundPanel(bounds, 17);
}

function fitBoundsAroundPanel(bounds, maxZoom) {
  // Keep what we're showing clear of the side panel (or bottom sheet) and the key.
  const panel = $("panel");
  const key = $("map-key");
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  const panelOpen = !panel.classList.contains("collapsed");
  const rect = panel.getBoundingClientRect();
  const keyRect = key.getBoundingClientRect();
  const keyBottom = !mobile && !key.classList.contains("collapsed") ? keyRect.height + 40 : 48;
  map.flyToBounds(bounds, {
    paddingTopLeft: [!mobile && panelOpen ? rect.right + 32 : 32, mobile ? keyRect.bottom + 16 : 48],
    paddingBottomRight: [48, mobile && panelOpen ? window.innerHeight - rect.top + 32 : keyBottom],
    maxZoom,
    duration: 0.5,
  });
}

function findPlaces(tokens, minStars) {
  const query = tokens.join(" ");
  return places
    .filter((place) => tokens.every((t) => place.search.includes(t)))
    .filter((place) => !minStars || (averageRating("place", place.id) ?? 0) >= minStars)
    .sort((a, b) => (b.search.startsWith(query) - a.search.startsWith(query)) || a.name.length - b.name.length)
    .slice(0, MAX_PLACE_RESULTS);
}

function focusLot({ lot, primary: layer }) {
  rememberTarget("lot", lot.id);
  savedView = false;
  $("search-shortcuts").hidden = true;
  renderList();
  if (window.matchMedia("(max-width: 640px)").matches) setPanelExpanded(false);
  map.flyTo([lot.lat, lot.lon], 18, { duration: 0.6 });
  map.once("moveend", () => layer.fire("click", { latlng: L.latLng(lot.lat, lot.lon) }));
}

function renderRecentShortcuts(showOnFocus = false) {
  const box = $("search-shortcuts");
  if (!mapHistory || document.activeElement !== $("search") || (!showOnFocus && $("search").value.trim())) {
    box.hidden = true;
    return;
  }
  const targets = mapHistory.recent().map((item) => {
    const target = item.type === "place"
      ? places.find((place) => place.id === item.id)
      : listEntries.find((entry) => entry.lot.id === item.id);
    return target ? { type: item.type, target } : null;
  }).filter(Boolean);
  if (!targets.length) { box.hidden = true; return; }
  const title = el("strong", null, "Recent searches");
  const buttons = targets.map(({ type, target }) => {
    const name = type === "place" ? target.name : target.lot.name;
    const button = el("button", null, name);
    button.type = "button";
    button.addEventListener("click", () => {
      box.hidden = true;
      if (type === "place") setDestination(target);
      else focusLot(target);
    });
    return button;
  });
  box.replaceChildren(title, ...buttons);
  box.hidden = false;
}

// Re-applies search text + chips: highlights matching lots, fades the rest, refreshes the list.
function applyFilters({ fit = true, animate = false } = {}) {
  clearTimeout(fitTimer);
  syncChips();
  if (destination) {
    rankNearest();
    renderList({ animate });
    if (fit) fitToResults(nearest.map(({ entry }) => entry), destination);
    return;
  }
  const filters = activeFilters();
  const active = filters.categories.size || filters.minStars || filters.tokens.length;
  placeResults = filters.tokens.length ? findPlaces(filters.tokens, filters.minStars) : [];
  filteredEntries = listEntries.filter(({ lot }) => passes(lot, filters));
  const matched = new Set(filteredEntries);
  listEntries.forEach((entry) => setLotState(entry, !active ? "normal" : matched.has(entry) ? "match" : "dim"));
  renderList({ animate });
  // Move the map once typing pauses, so it doesn't jump on every letter.
  if (fit && active && filteredEntries.length) fitTimer = setTimeout(() => fitToResults(filteredEntries), 350);
}

function runSearch() {
  const raw = $("search").value;
  $("search-clear").hidden = !raw;
  if (raw.trim()) savedView = false;
  renderRecentShortcuts();
  clearDestination(); // typing again means looking for something new
  parsedQuery = parseQuery(raw);
  applyFilters();
}

document.querySelectorAll(".chip-toggle[data-category]").forEach((chip) =>
  chip.addEventListener("click", () => {
    savedView = false;
    const c = chip.dataset.category;
    if (parsedQuery.categories.has(c) && !chipFilters.categories.has(c)) {
      // Turning off a filter that came from the search text: remove those words.
      const words = Object.keys(CATEGORY_WORDS).filter((w) => CATEGORY_WORDS[w] === c).join("|");
      setSearchText($("search").value.replace(new RegExp(`\\b(${words})\\b`, "gi"), ""));
    } else if (chipFilters.categories.has(c)) chipFilters.categories.delete(c);
    else chipFilters.categories.add(c);
    applyFilters({ animate: true });
  }),
);
document.querySelectorAll(".star-chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    savedView = false;
    const value = Number(chip.dataset.stars);
    const current = Math.max(chipFilters.minStars, parsedQuery.minStars);
    // Clicking the rating that's already on turns it off, like the type chips.
    chipFilters.minStars = value === current ? 0 : value;
    if (parsedQuery.minStars) {
      setSearchText($("search").value.replace(/(\d(?:\.\d)?)\s*\+?\s*(?:stars?|★)/i, ""));
    }
    applyFilters({ animate: true });
  }),
);

function clearSearch() {
  $("search").value = "";
  if (!$("directions-view").hidden) closeDirections();
  runSearch();
}

// ---------- Destination: a building or place, and the lots closest to it ----------

function meters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const formatDistance = (m) => (m < 160 ? `${Math.max(50, Math.round((m * 3.281) / 50) * 50)} ft` : `${(m / 1609.34).toFixed(1)} mi`);
const formatDuration = (s) => {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
// Paths aren't straight lines: assume ~25% detour at a ~5 km/h walk.
const walkLabel = (straightMeters) => `~${formatDuration((straightMeters * 1.25) / 1.4)} walk · ${formatDistance(straightMeters)}`;

const destinationIcon = L.divIcon({
  className: "destination-pin",
  html: '<svg viewBox="0 0 32 40" width="32" height="40" aria-hidden="true"><path d="M16 1C8 1 1.5 7.3 1.5 15.2 1.5 26 16 39 16 39s14.5-13 14.5-23.8C30.5 7.3 24 1 16 1Z"/><path class="flag" d="M12 9v14M12 9.5h8.5l-2 3 2 3H12"/></svg>',
  iconSize: [32, 40],
  iconAnchor: [16, 39],
  tooltipAnchor: [0, -36],
});

function setDestination(place, { remember = true } = {}) {
  clearTimeout(fitTimer);
  savedView = false;
  destination = place;
  placeResults = [];
  $("search").value = place.name;
  $("search-clear").hidden = false;
  $("search-shortcuts").hidden = true;
  if (remember) rememberTarget("place", place.id);

  showDestinationMarker(place);

  parsedQuery = parseQuery(""); // the box now names the destination, not a filter
  applyFilters({ animate: true });
}

// Closest lots to the destination among those passing the chips: usable lots first,
// then a couple of nearby tow-risk lots, flagged (or only those, if that's the filter).
function rankNearest() {
  const filters = activeFilters();
  const ranked = listEntries
    .filter(({ lot }) => passes(lot, filters, { ignoreText: true }))
    .map((entry) => ({ entry, meters: meters(destination, entry.lot) }))
    .sort((a, b) => a.meters - b.meters);
  const usable = ranked.filter(({ entry }) => entry.lot.category !== "limited").slice(0, NEAREST_LOTS);
  const farthest = usable.length ? usable.at(-1).meters : Infinity;
  const risky = ranked
    .filter(({ entry, meters }) => entry.lot.category === "limited" && meters < farthest)
    .slice(0, usable.length ? NEAREST_RISKY : NEAREST_LOTS);
  nearest = [...usable, ...risky];
  const close = new Set(nearest.map(({ entry }) => entry));
  listEntries.forEach((entry) => setLotState(entry, close.has(entry) ? "match" : "dim"));
}

function showDestinationMarker(place) {
  destinationMarker?.remove();
  destinationMarker = L.marker([place.lat, place.lon], { icon: destinationIcon, zIndexOffset: 2000, keyboard: false })
    .bindTooltip(place.name, { direction: "top", permanent: true, className: "destination-label" })
    .on("click", () => showPlaceReviews(place))
    .addTo(map);
}

function clearDestination() {
  if (!destination) return;
  destination = null;
  nearest = [];
  destinationMarker?.remove();
  destinationMarker = null;
}

$("search").addEventListener("input", runSearch);
$("search").addEventListener("focus", () => renderRecentShortcuts(true));
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".search")) $("search-shortcuts").hidden = true;
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("search-shortcuts").hidden) $("search-shortcuts").hidden = true;
    else clearSearch();
  }
  if (e.key === "Enter" && placeResults.length) setDestination(placeResults[0]);
  else if (e.key === "Enter" && $("search").value.trim() && filteredEntries.length) focusLot(filteredEntries[0]);
});
$("search-clear").addEventListener("click", () => {
  clearSearch();
  $("search").focus();
});
// "/" jumps to search from anywhere on the page (opening the panel if it's pushed in).
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.target.closest("input, textarea")) return;
  e.preventDefault();
  if ($("panel").classList.contains("collapsed")) $("panel-toggle").click();
  $("search").focus();
});

function renderLots(lots) {
  lots = [...lots].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  listEntries = lots.map((lot) => ({ lot, ...addLot(lot) }));
  for (const chip of document.querySelectorAll(".chip-toggle[data-category]")) {
    const c = chip.dataset.category;
    chip.querySelector(".count").textContent = lots.filter((lot) => lot.category === c).length;
    chip.querySelector(".swatch").style.background = CATEGORIES[c].color;
  }
  applyFilters({ fit: false, animate: true });
  if (lots.length) fitToLots(lots);
}

function fitToLots(lots) {
  // Leave room for the side panel (desktop) or bottom sheet (mobile).
  const panel = $("panel").getBoundingClientRect();
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  map.fitBounds(L.latLngBounds(lots.map((lot) => [lot.lat, lot.lon])), {
    paddingTopLeft: [mobile ? 32 : panel.right + 32, 48],
    paddingBottomRight: [48, mobile ? window.innerHeight - panel.top + 32 : 48],
    maxZoom: 16,
    animate: false,
  });
  // Zoom in 4x, keeping campus where it is on screen. Drag to see the rest.
  map.setZoomAround(UCI_CENTER, map.getZoom() + EXTRA_ZOOM, { animate: false });
}

// ---------- Collapsible side panel and key ----------

function setupCollapsible({ container, toggle, storageKey, labels }) {
  const apply = (collapsed) => {
    container.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (labels) toggle.setAttribute("aria-label", collapsed ? labels.show : labels.hide);
  };
  apply(container.id === "panel" && window.matchMedia("(max-width: 640px)").matches
    ? false : loadFlag(storageKey));
  toggle.addEventListener("click", () => {
    const collapsed = !container.classList.contains("collapsed");
    apply(collapsed);
    saveFlag(storageKey, collapsed);
  });
}

setupCollapsible({
  container: $("panel"),
  toggle: $("panel-toggle"),
  storageKey: "pp_panel_collapsed",
  labels: { show: "Show free parking list", hide: "Hide free parking list" },
});
setupCollapsible({ container: $("map-key"), toggle: $("key-toggle"), storageKey: "pp_key_collapsed" });

// Four mobile snap points, including a handle-only position to reveal the map.
const panelHandle = $("panel-handle");
const panel = $("panel");
const sheetLevels = [0, 0.42, 0.7, 1];
const sheetNames = ["Minimized", "Preview", "Medium height", "Full height"];
let sheetLevel = 1;
function setPanelLevel(level) {
  sheetLevel = Math.max(0, Math.min(sheetLevels.length - 1, level));
  panel.dataset.level = String(sheetLevel);
  panel.classList.toggle("expanded", sheetLevel === 3);
  panel.style.removeProperty("--sheet-height");
  panel.querySelector(".panel-body").inert = sheetLevel === 0 && window.matchMedia("(max-width: 640px)").matches;
  panelHandle.setAttribute("aria-valuenow", String(sheetLevel + 1));
  panelHandle.setAttribute("aria-valuetext", sheetNames[sheetLevel]);
}
function setPanelExpanded(expanded) {
  setPanelLevel(expanded ? 3 : 1);
}
panelHandle.addEventListener("keydown", (event) => {
  const levels = { ArrowUp: sheetLevel + 1, ArrowDown: sheetLevel - 1, Home: 0, End: 3 };
  if (!(event.key in levels)) return;
  event.preventDefault();
  setPanelLevel(levels[event.key]);
});
let sheetDrag = null;
panelHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !window.matchMedia("(max-width: 640px)").matches) return;
  sheetDrag = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height,
    available: panel.parentElement.clientHeight, level: sheetLevel };
  panelHandle.setPointerCapture(event.pointerId);
});
panelHandle.addEventListener("pointermove", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const fraction = (sheetDrag.height + sheetDrag.y - event.clientY) / sheetDrag.available;
  sheetDrag.fraction = Math.max(sheetLevels[0], Math.min(1, fraction));
  // Keep the handle reachable while dragging toward the full-screen snap point.
  panel.classList.add("dragging");
  panel.classList.remove("expanded");
  panel.style.setProperty("--sheet-height", `${Math.min(0.92, sheetDrag.fraction) * 100}%`);
});
function finishSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const drag = sheetDrag;
  sheetDrag = null;
  panel.classList.remove("dragging");
  const fraction = event.type === "pointercancel" ? sheetLevels[drag.level]
    : drag.fraction ?? sheetLevels[drag.level];
  const nearest = sheetLevels.reduce((best, point, index) =>
    Math.abs(point - fraction) < Math.abs(sheetLevels[best] - fraction) ? index : best, 0);
  setPanelLevel(nearest);
  if (panelHandle.hasPointerCapture(event.pointerId)) panelHandle.releasePointerCapture(event.pointerId);
}
panelHandle.addEventListener("pointerup", finishSheetDrag);
panelHandle.addEventListener("pointercancel", finishSheetDrag);
panelHandle.addEventListener("lostpointercapture", finishSheetDrag);
setPanelLevel(1);
window.matchMedia("(max-width: 640px)").addEventListener("change", (event) => {
  if (event.matches && panel.classList.contains("collapsed")) $("panel-toggle").click();
  setPanelLevel(sheetLevel);
});

function renderKey() {
  $("key-list").replaceChildren(
    ...Object.values(CATEGORIES).map((cat) => {
      const li = document.createElement("li");
      const swatch = document.createElement("i");
      swatch.className = "key-swatch";
      swatch.style.setProperty("--swatch", cat.color);
      swatch.style.setProperty("--swatch-fill", cat.fillOpacity);
      if (cat.dashArray) swatch.classList.add("dashed");
      const label = document.createElement("span");
      label.textContent = cat.label;
      li.append(swatch, label);
      return li;
    }),
  );
}
renderKey();

// ---------- Your live location ----------

const FRESH_FIX_MS = 60_000; // a fix this recent is good enough to route from
let here = null; // { lat, lon, accuracy, time }
let watchId = null;
let recenterOnFix = false;
const hereLayer = L.layerGroup().addTo(map);
const hereIcon = L.divIcon({ className: "you-dot", html: "<span></span>", iconSize: [18, 18], iconAnchor: [9, 9] });
let hereMarker = null;
let hereAccuracy = null;

const LocateControl = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const btn = L.DomUtil.create("button", "locate-button");
    btn.type = "button";
    btn.id = "locate";
    btn.title = "Show my location";
    btn.setAttribute("aria-label", "Show my location");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>';
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", () => watchLocation({ recenter: true }));
    return btn;
  },
});
new LocateControl().addTo(map);

function setLocateState(state, message) {
  const btn = $("locate");
  btn.dataset.state = state; // off | locating | on | error
  btn.title = message ?? (state === "on" ? "Centre on my location" : "Show my location");
}

function onPosition(pos) {
  here = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, time: Date.now() };
  const latlng = [here.lat, here.lon];
  if (!hereMarker) {
    hereAccuracy = L.circle(latlng, { radius: here.accuracy, color: "#2f55c4", weight: 1, opacity: 0.4, fillOpacity: 0.12, interactive: false });
    hereMarker = L.marker(latlng, { icon: hereIcon, zIndexOffset: 3000, keyboard: false, title: "You are here" })
      .bindTooltip("You", { direction: "top", offset: [0, -8], className: "destination-label" });
    hereLayer.addLayer(hereAccuracy).addLayer(hereMarker);
  } else {
    hereMarker.setLatLng(latlng);
    hereAccuracy.setLatLng(latlng).setRadius(here.accuracy);
  }
  setLocateState("on");
  if (recenterOnFix) {
    recenterOnFix = false;
    map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 0.6 });
  }
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    stopWatching();
    setLocateState("error", "Location access is turned off in your browser");
  } else if (!here) {
    setLocateState("error", "Your location isn't available right now");
  }
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// Start following your location (the browser asks the first time). With
// `recenter`, the map moves to you once there's a fix.
function watchLocation({ recenter = false } = {}) {
  if (!navigator.geolocation) {
    setLocateState("error", "Your browser can't share your location");
    return;
  }
  if (recenter && here) map.flyTo([here.lat, here.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
  else recenterOnFix = recenter;
  if (watchId !== null) return;
  setLocateState("locating");
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 10_000,
    timeout: 20_000,
  });
}

// If you've already allowed location for this site, show it without asking again.
navigator.permissions
  ?.query({ name: "geolocation" })
  .then((status) => {
    if (status.state === "granted") watchLocation();
  })
  .catch(() => {});

// ---------- Directions: drive to a lot, then walk to the destination ----------

const routeLayer = L.layerGroup().addTo(map);
let directionsRun = 0; // bumps on every new request so stale answers are ignored

const PANEL_VIEWS = ["list-view", "directions-view", "reviews-view"];

function showPanelView(name) {
  for (const view of PANEL_VIEWS) $(view).hidden = view !== name;
  document.querySelector(".filters").hidden = name !== "list-view"; // filters only apply to the list
  if ($("panel").classList.contains("collapsed")) $("panel-toggle").click();
}

const showDirectionsView = (show) => showPanelView(show ? "directions-view" : "list-view");

function directionsStatus(text, kind) {
  const status = $("directions-status");
  status.textContent = text ?? "";
  status.className = `panel-sub ${kind ?? ""}`;
}

function currentPosition() {
  if (here && Date.now() - here.time < FRESH_FIX_MS) return Promise.resolve(here);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Your browser can't share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onPosition(pos);
        watchLocation(); // keep the dot following you from now on
        resolve(here);
      },
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location access was turned off."
              : err.code === err.TIMEOUT
                ? "Finding your location took too long."
                : "Your location isn't available right now.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

function stepList(route, onClick) {
  const list = el("ol", "step-list");
  for (const step of route.steps) {
    const li = el("li");
    const btn = el("button");
    btn.type = "button";
    btn.append(el("span", null, step.instruction));
    if (step.distance >= 5) btn.append(el("small", null, formatDistance(step.distance)));
    btn.addEventListener("click", () => onClick(step));
    li.append(btn);
    list.append(li);
  }
  return list;
}

function routeSection(title, route, kind) {
  const section = el("section", `route-section ${kind}`);
  const head = el("h3");
  head.append(el("span", `route-mark ${kind}`), el("span", null, title));
  section.append(head, el("p", "route-meta", `${formatDuration(route.duration)} · ${formatDistance(route.distance)}`));
  section.append(stepList(route, (step) => map.flyTo([step.lat, step.lon], 18, { duration: 0.5 })));
  return section;
}

// ---------- Trip planner: From -(drive)-> parking lot -(walk)-> To ----------
//
// From and To can each be your live location, a place, a lot, or a pin dropped
// on the map. Change either (type, pick on the map, drag its marker, swap) and
// the route is planned again.

const HERE = { kind: "here", name: "My location" };
const trip = { from: null, to: null, lot: null, lotChosen: false };
const tripLayer = L.layerGroup().addTo(map);
let pendingPick = null; // map-click handler while picking a point
let suggestFor = null; // "from" | "to" while suggestions are open
let suggestions = [];

const placeEndpoint = (place) => ({ kind: "place", name: place.name, lat: place.lat, lon: place.lon, place });
const lotEndpoint = (lot) => ({ kind: "lot", name: lot.name, lat: lot.lat, lon: lot.lon, lot });
const pinEndpoint = ({ lat, lng }) => ({ kind: "pin", name: "Dropped pin", lat, lon: lng });

const startIcon = L.divIcon({ className: "trip-start", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] });

// Directions from the list or a popup: keep your start, go via this lot.
function startDirections(lot) {
  trip.from = trip.from ?? HERE;
  trip.to = destination ? placeEndpoint(destination) : lotEndpoint(lot);
  trip.lot = lot;
  trip.lotChosen = true;
  destinationMarker?.remove(); // the trip's own markers take over
  showDirectionsView(true);
  renderTripFields();
  planTrip();
}

function renderTripFields() {
  for (const end of ["from", "to"]) {
    const input = $(`trip-${end}`);
    if (document.activeElement !== input) input.value = trip[end]?.name ?? "";
    input.closest(".trip-field").classList.toggle("is-here", trip[end]?.kind === "here");
    document.querySelector(`.trip-clear[data-end="${end}"]`).hidden = !input.value;
  }
}

// Closest lots you can use near a point (respecting the filter chips).
function closestLots(point, count = 4) {
  const filters = activeFilters();
  const candidates = listEntries.filter(({ lot }) => passes(lot, filters, { ignoreText: true }));
  const usable = candidates.filter(({ lot }) => lot.category !== "limited");
  return (usable.length ? usable : candidates)
    .map((entry) => ({ lot: entry.lot, meters: meters(point, entry.lot) }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, count);
}

function setEndpoint(end, endpoint, { fit = true } = {}) {
  cancelPick();
  // Done typing: let the field show the chosen name.
  if (document.activeElement?.matches("#trip-from, #trip-to")) document.activeElement.blur();
  trip[end] = endpoint;
  if (end === "to") {
    trip.lotChosen = false; // new destination: pick its closest lot again
    if (endpoint?.kind === "place") {
      destination = endpoint.place; // "Back to results" shows parking near it
      rankNearest();
      renderList();
    }
  }
  hideSuggestions();
  renderTripFields();
  planTrip({ fit });
}

function drawTripMarkers() {
  tripLayer.clearLayers();
  const { from, to } = trip;
  if (from && from.kind !== "here") {
    tripLayer.addLayer(
      L.marker([from.lat, from.lon], { icon: startIcon, draggable: true, zIndexOffset: 2500, title: "Drag to move the start" })
        .bindTooltip(from.kind === "pin" ? "Start" : from.name, { direction: "top", offset: [0, -10], className: "destination-label" })
        .on("dragend", (e) => setEndpoint("from", pinEndpoint(e.target.getLatLng()), { fit: false })),
    );
  }
  if (to && to.kind !== "here") {
    tripLayer.addLayer(
      L.marker([to.lat, to.lon], { icon: destinationIcon, draggable: true, zIndexOffset: 2600, title: "Drag to move the destination" })
        .bindTooltip(to.kind === "pin" ? "Destination" : to.name, { direction: "top", permanent: true, className: "destination-label" })
        .on("dragend", (e) => setEndpoint("to", pinEndpoint(e.target.getLatLng()), { fit: false })),
    );
  }
}

// Pills for the closest lots to the destination; click one to park there instead.
function renderLotOptions(lot) {
  const box = $("trip-lots");
  if (!trip.to || trip.to.kind === "lot") return box.replaceChildren();
  const options = closestLots(trip.to);
  if (!options.some((o) => o.lot === lot)) options.push({ lot, meters: meters(trip.to, lot) });
  box.replaceChildren(
    el("span", "trip-lots-label", "Park at"),
    ...options.map(({ lot: option, meters: m }) => {
      const pill = el("button", "chip-toggle trip-lot");
      pill.type = "button";
      pill.setAttribute("aria-pressed", String(option === lot));
      const swatch = el("i", "swatch");
      swatch.style.background = CATEGORIES[option.category].color;
      pill.append(swatch, el("span", null, option.name), el("span", "count", `~${formatDuration((m * 1.25) / 1.4)}`));
      pill.title = `${option.name} · ${CATEGORIES[option.category].label} · ${walkLabel(m)} to ${trip.to.name}`;
      pill.addEventListener("click", () => {
        trip.lot = option;
        trip.lotChosen = true;
        planTrip({ fit: false });
      });
      return pill;
    }),
  );
}

async function planTrip({ fit = true } = {}) {
  const run = ++directionsRun;
  routeLayer.clearLayers();
  drawTripMarkers();
  $("directions-summary").hidden = true;
  $("directions-steps").replaceChildren();
  $("directions-reroute").hidden = true;
  const { from, to } = trip;
  if (!from || !to) {
    $("trip-lots").replaceChildren();
    directionsStatus(!from && !to ? "Choose where you're starting and where you're going." : !from ? "Choose a starting point." : "Choose a destination.");
    return;
  }

  // Going to a lot means parking there; otherwise the lot you picked, or the closest usable one.
  if (to.kind === "lot") trip.lot = to.lot;
  else if (!trip.lotChosen || !trip.lot) trip.lot = closestLots(to)[0]?.lot ?? null;
  const lot = trip.lot;
  renderLotOptions(lot);
  if (!lot) {
    directionsStatus("No parking lots match your filters near there.", "warn");
    return;
  }

  let start = from;
  if (from.kind === "here") {
    directionsStatus("Finding your location… your browser may ask for permission.");
    try {
      start = await currentPosition();
    } catch (err) {
      if (run !== directionsRun) return;
      trip.from = null;
      renderTripFields();
      directionsStatus(`${err.message} Choose another starting point, or pick one on the map.`, "warn");
      $("trip-from").focus();
      return;
    }
  }
  if (run !== directionsRun) return;

  const walkNeeded = to.kind !== "lot";
  directionsStatus("Finding the best route…");
  let drive, walk;
  try {
    [drive, walk] = await Promise.all([
      api.route("car", start, lot),
      walkNeeded ? api.route("foot", lot, to.kind === "here" ? start : to).catch((err) => ({ error: err })) : null,
    ]);
  } catch (err) {
    if (run !== directionsRun) return;
    directionsStatus(`Couldn't get driving directions: ${err.message}`, "error");
    return;
  }
  if (run !== directionsRun) return;

  // Draw: start -> lot (solid) and lot -> destination (dotted walk). Lines start
  // hidden and draw in once the map has finished moving to them.
  const driveCasing = L.polyline(drive.path, { color: "#fff", weight: 10, opacity: 0 });
  const driveLine = L.polyline(drive.path, { color: "#2f55c4", weight: 6, opacity: 0, lineCap: "round" });
  routeLayer.addLayer(driveCasing).addLayer(driveLine);
  let walkLine = null;
  const bounds = driveLine.getBounds();
  if (walk && !walk.error) {
    walkLine = L.polyline(walk.path, { color: "#3d4457", weight: 4, opacity: 0, dashArray: "1 9", lineCap: "round" });
    routeLayer.addLayer(walkLine);
    bounds.extend(walkLine.getBounds());
  }
  if (fit) fitBoundsAroundPanel(bounds, 18);
  revealRoute(run, driveCasing, driveLine, walkLine, { immediate: !fit });

  // Summary + steps
  const walked = walk && !walk.error;
  const total = drive.duration + (walked ? walk.duration : 0);
  const summary = $("directions-summary");
  summary.replaceChildren(
    el("span", "chip drive", `Drive ${formatDuration(drive.duration)}`),
    ...(walked ? [el("span", "chip walk", `Walk ${formatDuration(walk.duration)}`)] : []),
    el("span", "chip total", `About ${formatDuration(total)} total`),
  );
  summary.hidden = false;

  const parkNote = el("div", "park-note");
  parkNote.append(el("b", null, `Park at ${lot.name}`), el("span", null, ` · ${CATEGORIES[lot.category].label}`));
  if (lot.category === "limited") parkNote.append(el("small", null, lot.time_limit ? `${lot.time_limit} max · tow risk` : "Not public parking: you may be towed"));
  if (lot.category === "permit") parkNote.append(el("small", null, "Needs a UCI permit or visitor pass"));
  if (lot.category === "paid") parkNote.append(el("small", null, "One-day pass $16 · hourly $4–$5"));

  const sections = [routeSection(`Drive to ${lot.name}`, drive, "drive"), parkNote];
  if (walkNeeded) {
    sections.push(
      walk.error
        ? el("p", "map-error", `Couldn't get walking directions: ${walk.error.message}`)
        : routeSection(`Walk to ${to.name}`, walk, "walk"),
    );
  }
  $("directions-steps").replaceChildren(...sections);
  directionsStatus("");
  $("directions-reroute").hidden = from.kind !== "here";
}

// ----- From / To fields: type to search, or use your location / the map -----

function suggestionsFor(end, text) {
  const tokens = normalize(text).split(" ").filter(Boolean);
  const items = [];
  if (trip[end]?.kind !== "here") items.push({ label: "Use my location", detail: "Follows you live", icon: "here", pick: () => setEndpoint(end, HERE) });
  items.push({ label: "Pick a point on the map", detail: "Click anywhere on the map", icon: "pin", pick: () => startPick(end) });
  if (tokens.length) {
    for (const place of findPlaces(tokens, 0).slice(0, 5)) {
      items.push({ label: place.name, detail: place.kind ?? "Place", icon: "place", pick: () => setEndpoint(end, placeEndpoint(place)) });
    }
    const lots = listEntries.filter(({ lot }) => tokens.every((t) => searchableText(lot).includes(t))).slice(0, 4);
    for (const { lot } of lots) {
      items.push({ label: lot.name, detail: CATEGORIES[lot.category].label, icon: "lot", color: CATEGORIES[lot.category].color, pick: () => setEndpoint(end, lotEndpoint(lot)) });
    }
  }
  return items;
}

const SUGGESTION_ICONS = {
  here: '<span class="sugg-icon here"></span>',
  pin: '<svg class="sugg-icon" viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><path d="M9 10h6M12 7v6"/></svg>',
  place: PLACE_ICON,
};

function showSuggestions(end) {
  suggestFor = end;
  const input = $(`trip-${end}`);
  const text = input.value === trip[end]?.name ? "" : input.value;
  suggestions = suggestionsFor(end, text);
  const list = $("trip-suggestions");
  list.replaceChildren(
    ...suggestions.map((item, i) => {
      const li = el("li");
      li.setAttribute("role", "option");
      li.id = `sugg-${i}`;
      const btn = el("button", "sugg");
      btn.type = "button";
      btn.tabIndex = -1;
      if (item.icon === "lot") {
        const swatch = el("i", "swatch");
        swatch.style.background = item.color;
        btn.append(swatch);
      } else btn.insertAdjacentHTML("beforeend", SUGGESTION_ICONS[item.icon]);
      const text = el("span", "spot-text");
      text.append(el("span", null, item.label), el("small", null, item.detail));
      btn.append(text);
      btn.addEventListener("click", item.pick);
      li.append(btn);
      return li;
    }),
  );
  list.dataset.end = end;
  list.hidden = false;
}

function hideSuggestions() {
  suggestFor = null;
  $("trip-suggestions").hidden = true;
}

function startPick(end) {
  cancelPick();
  hideSuggestions();
  document.activeElement?.blur();
  renderTripFields();
  directionsStatus(`Click the map to set your ${end === "from" ? "starting point" : "destination"}.`, "warn");
  map.getContainer().classList.add("picking-start");
  pendingPick = (e) => setEndpoint(end, pinEndpoint(e.latlng));
  map.once("click", pendingPick);
}

function cancelPick() {
  if (pendingPick) map.off("click", pendingPick);
  pendingPick = null;
  map.getContainer().classList.remove("picking-start");
}

for (const end of ["from", "to"]) {
  const input = $(`trip-${end}`);
  input.addEventListener("focus", () => {
    input.select();
    showSuggestions(end);
  });
  input.addEventListener("input", () => {
    document.querySelector(`.trip-clear[data-end="${end}"]`).hidden = !input.value;
    showSuggestions(end);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideSuggestions();
      input.value = trip[end]?.name ?? "";
      input.blur();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Typed something: take the first search match; otherwise the first option.
      const typed = suggestions.filter((s) => s.icon === "place" || s.icon === "lot");
      (typed[0] ?? suggestions[0])?.pick();
    }
  });
  input.addEventListener("blur", () =>
    setTimeout(() => {
      if (suggestFor === end && !$("trip-suggestions").contains(document.activeElement)) {
        hideSuggestions();
        renderTripFields();
      }
    }, 150),
  );
}
// Keep focus in the field while clicking a suggestion.
$("trip-suggestions").addEventListener("pointerdown", (e) => e.preventDefault());

document.querySelectorAll(".trip-clear").forEach((btn) =>
  btn.addEventListener("click", () => {
    const end = btn.dataset.end;
    cancelPick();
    trip[end] = null;
    if (end === "to") trip.lotChosen = false;
    const input = $(`trip-${end}`);
    input.value = "";
    planTrip();
    renderTripFields();
    input.focus();
  }),
);

$("trip-swap").addEventListener("click", () => {
  cancelPick();
  [trip.from, trip.to] = [trip.to, trip.from];
  trip.lotChosen = false;
  if (trip.to?.kind === "place") destination = trip.to.place;
  const swap = $("trip-swap");
  swap.classList.remove("spun");
  void swap.offsetWidth;
  swap.classList.add("spun");
  renderTripFields();
  planTrip();
});

// Draws the driving line along its path, then fades in the walking leg.
function revealRoute(run, casing, line, walkLine, { immediate = false } = {}) {
  let shown = false;
  const show = () => {
    if (shown || run !== directionsRun) return;
    shown = true;
    casing.setStyle({ opacity: 0.8 });
    line.setStyle({ opacity: 0.9 });
    const path = line.getElement();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      if (path) Object.assign(path.style, { strokeDasharray: "", strokeDashoffset: "", transition: "" });
      walkLine?.setStyle({ opacity: 1 });
    };
    if (!path || reduce) return finish();
    const length = path.getTotalLength();
    Object.assign(path.style, { strokeDasharray: `${length}`, strokeDashoffset: `${length}`, transition: "none" });
    path.getBoundingClientRect(); // apply the start state before animating
    Object.assign(path.style, {
      transition: `stroke-dashoffset ${Math.min(1400, 500 + length / 3)}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      strokeDashoffset: "0",
    });
    path.addEventListener("transitionend", finish, { once: true });
    map.once("zoomstart", finish); // zooming redraws the path, so stop drawing
  };
  if (immediate) return show();
  map.once("moveend", show);
  setTimeout(show, 1000); // in case the map didn't need to move
}

function closeDirections() {
  directionsRun++;
  cancelPick();
  hideSuggestions();
  routeLayer.clearLayers();
  tripLayer.clearLayers();
  showDirectionsView(false);
  if (destination) {
    showDestinationMarker(destination);
    $("search").value = destination.name;
    $("search-clear").hidden = false;
    applyFilters({ fit: false, animate: true });
  }
}

$("directions-back").addEventListener("click", closeDirections);
$("directions-reroute").addEventListener("click", () => planTrip());

// ---------- Boot ----------

$("logout").addEventListener("click", async () => {
  try {
    await api.logout();
  } finally {
    toSignIn();
  }
});

async function init() {
  try {
    const [user, parking, placeData] = await Promise.all([
      api.me(),
      api.parking(),
      api.places().catch(() => ({ places: [] })), // search still works for lots without these
      initReviews({ showPanelView, onChange: () => listEntries.length && applyFilters({ fit: false }) }),
    ]);
    places = placeData.places.map((place) => ({
      ...place,
      search: normalize([place.name, place.kind ?? ""].join(" ")),
    }));
    mapHistory = createMapHistory(user.id);
    $("user-name").textContent = user.username ?? user.email;
    $("user-name").title = user.email;
    renderAvatar($("user-avatar"), user.avatar);
    permitInfo = parking.permit_info;
    renderLots(parking.lots);
    const tourActions = {
      showExample: () => {
        const studentCenter = places.find((place) => place.name === "Student Center");
        if (!studentCenter) return false;
        setDestination(studentCenter, { remember: false });
        return true;
      },
      clearExample: clearSearch,
    };
    $("tour-help").addEventListener("click", () => startMapTour(user, tourActions, true));
    $("tour-help").hidden = false;
    startMapTour(user, tourActions);
  } catch (err) {
    $("spot-count").textContent = "";
    $("map-error").textContent = err.message;
    $("map-error").hidden = false;
  }
}

init();
