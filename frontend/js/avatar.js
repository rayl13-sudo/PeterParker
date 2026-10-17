// Draws a user's profile picture into an .avatar element: their uploaded photo,
// or the default anteater over their chosen background color.
const DEFAULT_AVATAR = new URL("../assets/peterparker-mascot.png", import.meta.url).href;
let defaultPixels;

// Load once at avatar resolution so color-picker previews stay inexpensive.
function loadDefaultPixels() {
  if (!defaultPixels) {
    defaultPixels = new Promise((resolve, reject) => {
      const source = new Image();
      source.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(source, 0, 0, 128, 128);
        resolve(ctx.getImageData(0, 0, 128, 128));
      };
      source.onerror = reject;
      source.src = DEFAULT_AVATAR;
    });
  }
  return defaultPixels;
}

async function colorDefaultAvatar(img, color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || "")) return;
  const original = await loadDefaultPixels();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = original.width;
  const ctx = canvas.getContext("2d");
  const pixels = ctx.createImageData(original.width, original.height);
  pixels.data.set(original.data);
  const tint = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  for (let i = 0; i < pixels.data.length; i += 4) {
    const [r, g, b, a] = pixels.data.subarray(i, i + 4);
    // The blue-gray fur has green between red and blue. Exclude the purple
    // cheeks/ears, black linework, white eyes, and red hat.
    if (!a || r < 65 || b - r < 5 || b - r > 65 || g < r - 2 || g > b || g - r > 30) continue;
    const shade = (r + g + b) / (3 * 170);
    for (let channel = 0; channel < 3; channel++) {
      pixels.data[i + channel] = shade <= 1
        ? tint[channel] * shade
        : tint[channel] + (255 - tint[channel]) * Math.min(1, shade - 1);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  img.src = canvas.toDataURL("image/png");
}

export function renderAvatar(el, avatar) {
  if (!el || !avatar) return;
  if (avatar.image) {
    const img = document.createElement("img");
    img.src = avatar.image;
    img.alt = "";
    el.replaceChildren(img);
    el.style.background = "";
  } else {
    const img = document.createElement("img");
    img.src = DEFAULT_AVATAR;
    img.alt = "";
    img.className = "default-avatar";
    el.replaceChildren(img);
    el.style.background = avatar.bg;
    // Retain the original image if it cannot be loaded for recoloring.
    colorDefaultAvatar(img, avatar.fg).catch(() => {});
  }
  el.classList.add("ready");
}

let previewDialog;
let previewImage;

function getPreviewDialog() {
  if (previewDialog) return previewDialog;
  previewDialog = document.createElement("dialog");
  previewDialog.className = "avatar-preview";
  previewDialog.setAttribute("aria-label", "Enlarged profile photo");

  previewImage = document.createElement("button");
  previewImage.type = "button";
  previewImage.className = "avatar avatar-zoomed";
  previewImage.setAttribute("aria-label", "Close enlarged profile photo");
  previewImage.addEventListener("click", () => previewDialog.close());
  previewDialog.append(previewImage);
  previewDialog.addEventListener("click", (event) => {
    if (event.target === previewDialog) previewDialog.close();
  });
  document.body.append(previewDialog);
  return previewDialog;
}

export function bindAvatarPreview(button, getAvatar) {
  button.addEventListener("click", () => {
    const avatar = getAvatar();
    if (!avatar) return;
    const dialog = getPreviewDialog();
    renderAvatar(previewImage, avatar);
    if (!dialog.open) dialog.showModal();
  });
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
