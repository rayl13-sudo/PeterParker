// Draws a user's profile picture into an .avatar element: their uploaded photo,
// or the default silhouette in their random background/silhouette colors.
const SILHOUETTE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9.5" r="3.6"/>' +
  '<path d="M5.6 19.2c1.4-2.9 3.7-4.4 6.4-4.4s5 1.5 6.4 4.4"/></svg>';

export function renderAvatar(el, avatar) {
  if (!el || !avatar) return;
  if (avatar.image) {
    const img = document.createElement("img");
    img.src = avatar.image;
    img.alt = "";
    el.replaceChildren(img);
    el.style.background = "";
  } else {
    el.innerHTML = SILHOUETTE;
    el.style.background = avatar.bg;
    el.querySelector("svg").style.fill = avatar.fg;
  }
  el.classList.add("ready");
}

// Crops an image file to a centered square and shrinks it, returning a JPEG data URL
// small enough to store with the account.
export function imageFileToAvatar(file, size = 256) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Choose an image file (PNG, JPEG, WebP…)."));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image couldn't be opened."));
    };
    img.src = url;
  });
}
