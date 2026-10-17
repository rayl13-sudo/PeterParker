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

// Average rating (1-5) of a lot or place, or null when nobody has reviewed it yet.
export function averageRating(type, id) {
  return summary[key(type, id)]?.average ?? null;
}

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

function authorLine(author, mine, when, avatarClass) {
  const head = el("div", "review-head");
  const avatar = el("span", `avatar ${avatarClass}`);
  avatar.setAttribute("aria-hidden", "true");
  renderAvatar(avatar, author.avatar);
  const who = el("div", "review-who");
  const name = el("strong", null, author.username ?? "UCI parker");
  if (mine) name.append(el("span", "you-tag", "You"));
  who.append(name, el("small", null, when));
  head.append(avatar, who);
  return head;
}

// A small text button that needs a second click to confirm (no browser pop-up).
function confirmButton(label, confirmLabel, action) {
  const btn = el("button", "text-button danger", label);
  btn.type = "button";
  let timer = null;
  btn.addEventListener("click", async () => {
    if (!btn.classList.contains("confirming")) {
      btn.classList.add("confirming");
      btn.textContent = confirmLabel;
      timer = setTimeout(() => {
        btn.classList.remove("confirming");
        btn.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    await action();
  });
  return btn;
}

function replyItem(reply) {
  const li = el("li", reply.mine ? "reply mine" : "reply");
  li.append(authorLine(reply.author, reply.mine, formatDate(reply.created_at), "reply-avatar"));
  li.append(el("p", "review-comment", reply.comment));
  if (reply.mine) {
    const actions = el("div", "review-actions");
    actions.append(
      confirmButton("Delete", "Delete reply?", async () => {
        try {
          await api.deleteReply(reply.id);
          render(await api.reviews(target.type, target.id));
        } catch (err) {
          showMessage(err.message, "error");
        }
      }),
    );
    li.append(actions);
  }
  return li;
}

function replyForm(review, li, opener) {
  const form = el("form", "reply-form");
  form.noValidate = true;
  const box = el("textarea");
  box.rows = 2;
  box.maxLength = 500;
  box.placeholder = `Reply to ${review.author.username ?? "this review"}…`;
  box.setAttribute("aria-label", "Your reply");
  const post = el("button", "pill-button primary", "Reply");
  post.type = "submit";
  const cancel = el("button", "text-button", "Cancel");
  cancel.type = "button";
  const error = el("small", "reply-error");
  const row = el("div", "reply-form-actions");
  row.append(post, cancel, error);
  form.append(box, row);

  cancel.addEventListener("click", () => {
    form.remove();
    opener.hidden = false;
    opener.focus();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!box.value.trim()) {
      error.textContent = "Write something first.";
      return;
    }
    post.disabled = true;
    try {
      render(await api.replyToReview(review.id, box.value));
    } catch (err) {
      error.textContent = err.message;
      post.disabled = false;
    }
  });
  li.append(form);
  box.focus();
}

function reviewItem(review) {
  const li = el("li", review.mine ? "review mine" : "review");
  const when = formatDate(review.updated_at) + (review.updated_at !== review.created_at ? " · edited" : "");
  const head = authorLine(review.author, review.mine, when, "review-avatar");
  head.append(stars(review.rating, "stars small"));
  li.append(head);
  if (review.comment) li.append(el("p", "review-comment", review.comment));

  const actions = el("div", "review-actions");
  const replyBtn = el("button", "text-button", "Reply");
  const likeBtn = el("button", "text-button review-like");
  likeBtn.type = "button";
  let liked = Boolean(review.liked);
  function updateLike(state) {
    liked = state.liked;
    likeBtn.textContent = `${liked ? "Liked" : "Like"} (${state.like_count ?? 0})`;
    likeBtn.setAttribute("aria-pressed", String(liked));
  }
  updateLike(review);
  likeBtn.addEventListener("click", async () => {
    likeBtn.disabled = true;
    try {
      updateLike(await api.likeReview(review.id, !liked));
    } catch (err) {
      showMessage(err.message, "error");
    } finally {
      likeBtn.disabled = false;
    }
  });
  actions.append(likeBtn);
  replyBtn.type = "button";
  replyBtn.addEventListener("click", () => {
    replyBtn.hidden = true;
    replyForm(review, li, replyBtn);
  });
  actions.append(replyBtn);
  if (review.mine) actions.append(confirmButton("Delete", "Delete review?", remove));
  li.append(actions);

  if (review.replies.length) {
    const thread = el("ul", "reply-list");
    thread.setAttribute("aria-label", `Replies to ${review.author.username ?? "this review"}`);
    thread.append(...review.replies.map(replyItem));
    li.append(thread);
  }
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
  const del = $("review-delete");
  del.hidden = !mine;
  del.disabled = false;
  del.classList.remove("confirming");
  del.textContent = "Delete my review";

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
  const formDelete = confirmButton("Delete my review", "Delete review?", remove);
  formDelete.id = "review-delete";
  formDelete.className = "pill-button";
  formDelete.hidden = true;
  $("review-delete").replaceWith(formDelete);
  $("reviews-back").addEventListener("click", () => showPanelView(previousView));

  try {
    summary = await api.reviewSummary();
  } catch {
    summary = {}; // ratings just won't show in lists until a review is opened
  }
}
