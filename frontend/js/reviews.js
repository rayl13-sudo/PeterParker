// Reviews: 1-5 star ratings and comments on parking lots and places, shown in
// the side panel's reviews view. A target is { type: "lot" | "place", id, name, kind }.
import { api } from "./api.js";
import { renderAvatar } from "./avatar.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

let summary = {}; // "lot:way/123" -> { average, count }
let showPanelView = () => {};
let onChange = () => {};
let target = null;
let previousView = "list-view";
let rating = 0;
let myReviewId = null;
let loadRun = 0;

const key = (type, id) => `${type}:${id}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "★ 4.5 · 3 reviews", or null when nobody has reviewed it yet.
export function ratingLabel(type, id) {
  const s = summary[key(type, id)];
  return s ? `★ ${s.average.toFixed(1)} · ${plural(s.count, "review")}` : null;
}

function stars(value, className = "stars") {
  const wrap = el("span", className);
  wrap.setAttribute("aria-label", `${value.toFixed(1)} out of 5 stars`);
  const rounded = Math.round(value * 2) / 2;
  for (let i = 1; i <= 5; i++) {
    const star = el("span", i <= rounded ? "star on" : i - 0.5 === rounded ? "star half" : "star", "★");
    star.setAttribute("aria-hidden", "true");
    wrap.append(star);
  }
  return wrap;
}

function setRating(value) {
  rating = value;
  document.querySelectorAll("#star-input button").forEach((btn) => {
    const v = Number(btn.dataset.value);
    btn.classList.toggle("on", v <= value);
    btn.setAttribute("aria-checked", String(v === value));
  });
}

function showMessage(text, kind) {
  const msg = $("review-message");
  msg.textContent = text ?? "";
  msg.className = `review-message ${kind ?? ""}`;
  msg.hidden = !text;
}

function updateChars() {
  $("review-chars").textContent = `${$("review-comment").value.length} / 1000`;
}

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function reviewItem(review) {
  const li = el("li", review.mine ? "review mine" : "review");
  const head = el("div", "review-head");
  const avatar = el("span", "avatar review-avatar");
  avatar.setAttribute("aria-hidden", "true");
  renderAvatar(avatar, review.author.avatar);
  const who = el("div", "review-who");
  const name = el("strong", null, review.author.username ?? "UCI parker");
  if (review.mine) name.append(el("span", "you-tag", "You"));
  const when = formatDate(review.updated_at) + (review.updated_at !== review.created_at ? " · edited" : "");
  who.append(name, el("small", null, when));
  head.append(avatar, who, stars(review.rating, "stars small"));
  li.append(head);
  if (review.comment) li.append(el("p", "review-comment", review.comment));
  return li;
}

function render(data) {
  // Summary: big average + stars + count
  const box = $("reviews-summary");
  if (data.count) {
    const big = el("div", "average", data.average.toFixed(1));
    const side = el("div");
    side.append(stars(data.average), el("small", null, plural(data.count, "review")));
    box.replaceChildren(big, side);
  } else {
    box.replaceChildren(el("p", "no-reviews", "No reviews yet. Be the first to rate it."));
  }

  // Form: prefilled with your review if you've written one
  const mine = data.reviews.find((r) => r.mine);
  myReviewId = mine?.id ?? null;
  setRating(mine?.rating ?? 0);
  $("review-comment").value = mine?.comment ?? "";
  updateChars();
  $("review-form-title").textContent = mine ? "Your review" : `Rate this ${target.type === "lot" ? "lot" : "place"}`;
  $("review-submit").textContent = mine ? "Update review" : "Post review";
  $("review-delete").hidden = !mine;

  $("review-list").replaceChildren(...data.reviews.map(reviewItem));

  // Keep list/popup ratings in step with what's on screen.
  if (data.count) summary[key(data.target_type, data.target_id)] = { average: data.average, count: data.count };
  else delete summary[key(data.target_type, data.target_id)];
  onChange();
}

export async function openReviews(next) {
  const run = ++loadRun;
  target = next;
  const current = ["list-view", "directions-view"].find((v) => !$(v).hidden);
  if (current) previousView = current;
  showPanelView("reviews-view");
  $("reviews-title").textContent = target.name;
  $("reviews-subtitle").textContent = target.kind ? `Reviews · ${target.kind}` : "Reviews";
  $("reviews-summary").replaceChildren(el("p", "no-reviews", "Loading reviews…"));
  $("review-list").replaceChildren();
  showMessage(null);
  setRating(0);
  try {
    const data = await api.reviews(target.type, target.id);
    if (run === loadRun) render(data);
  } catch (err) {
    if (run === loadRun) $("reviews-summary").replaceChildren(el("p", "no-reviews", err.message));
  }
}

async function submit(e) {
  e.preventDefault();
  if (!rating) {
    showMessage("Pick a star rating first.", "error");
    return;
  }
  const button = $("review-submit");
  button.disabled = true;
  try {
    const updating = myReviewId !== null;
    const data = await api.saveReview({ ...target, rating, comment: $("review-comment").value });
    render(data);
    showMessage(updating ? "Review updated." : "Thanks! Your review is posted.", "success");
  } catch (err) {
    showMessage(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function remove() {
  if (myReviewId === null) return;
  try {
    await api.deleteReview(myReviewId);
    render(await api.reviews(target.type, target.id));
    showMessage("Your review was deleted.", "success");
  } catch (err) {
    showMessage(err.message, "error");
  }
}

export async function initReviews(options) {
  showPanelView = options.showPanelView;
  onChange = options.onChange;

  document.querySelectorAll("#star-input button").forEach((btn) =>
    btn.addEventListener("click", () => {
      setRating(Number(btn.dataset.value));
      showMessage(null);
    }),
  );
  $("review-comment").addEventListener("input", updateChars);
  $("review-form").addEventListener("submit", submit);
  $("review-delete").addEventListener("click", remove);
  $("reviews-back").addEventListener("click", () => showPanelView(previousView));

  try {
    summary = await api.reviewSummary();
  } catch {
    summary = {}; // ratings just won't show in lists until a review is opened
  }
}
