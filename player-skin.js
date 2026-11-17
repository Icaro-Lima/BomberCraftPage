import { PLAYER_PARTS, playerColors, SKIN_V1 } from "./player-model.js";
import { wirePlayerViewer } from "./player-viewer.js";
import { convertMinecraftSkin, minecraftSkinLayout } from "./minecraft-skin.js";

const storageKey = "bombercraft.player-skin.v1";
const maxPngBytes = 1024 * 1024;

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function makeDefaultSheet(shirt) {
  const sheet = makeCanvas(SKIN_V1.width, SKIN_V1.height);
  const ctx = sheet.getContext("2d");
  const fill = (color, x, y, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };

  for (const { name, faces } of PLAYER_PARTS) {
    for (const [face, [u, v, w, h]] of Object.entries(faces)) {
      if (name === "head") {
        const hair = "#49343c";
        fill("#e5a976", u, v, w, h);
        if (face === "top" || face === "back") {
          fill(hair, u, v, w, h);
          if (face === "top") fill("#684651", u + 1, v + 1, w - 2, 2);
        } else if (face !== "bottom") {
          fill(hair, u, v, w, 2);
          if (face === "front") {
            fill(hair, u, v + 2, 2, 1);
            fill("#3c2d3d", u + 2, v + 3, 2, 1);
            fill("#3c2d3d", u + 6, v + 3, 2, 1);
            fill("#a66b55", u + 4, v + 5, 2, 1);
          } else {
            const hairEdge = face === "left" ? u : u + w - 2;
            fill(hair, hairEdge, v + 2, 2, 3);
          }
        }
      } else if (name === "torso") {
        fill(shirt, u, v, w, h);
        if (h === 9) fill("#344362", u, v + 7, w, 2);
        if (face === "front") fill("#fff3c8", u + 3, v + 7, 2, 1);
      } else if (name.endsWith("Arm")) {
        fill(shirt, u, v, w, h);
        if (h === 9) {
          fill("#344362", u, v + 5, w, 1);
          fill("#e5a976", u, v + 6, w, 3);
        }
        if (face === "bottom") fill("#e5a976", u, v, w, h);
      } else {
        fill("#344362", u, v, w, h);
        if (h === 8) fill("#242b53", u, v + 6, w, 2);
        if (face === "bottom") fill("#242b53", u, v, w, h);
      }
    }
  }
  const signature = ctx.createImageData(4, 1);
  signature.data.set(SKIN_V1.signature);
  ctx.putImageData(signature, SKIN_V1.signatureX, SKIN_V1.signatureY);
  return sheet;
}

function splitFaces(sheet) {
  return Object.fromEntries(PLAYER_PARTS.map(({ name, faces }) => [
    name,
    Object.fromEntries(Object.entries(faces).map(([face, [u, v, width, height]]) => {
      const bitmap = makeCanvas(width, height);
      bitmap.getContext("2d").drawImage(sheet, u, v, width, height, 0, 0, width, height);
      return [face, bitmap];
    })),
  ]));
}

const defaultSkins = playerColors.map((shirt) => {
  const sheet = makeDefaultSheet(shirt);
  return { sheet, faces: splitFaces(sheet) };
});

export function defaultSkin(slot) {
  return defaultSkins[slot];
}

function canvasPng(sheet) {
  return new Promise((resolve) => sheet.toBlob(resolve, "image/png"));
}

async function decodeSkin(file, format = "bombercraft") {
  if (file.size > maxPngBytes) throw new Error("Choose a PNG smaller than 1 MB.");

  const header = new DataView(await file.slice(0, 24).arrayBuffer());
  if (header.byteLength < 24 || header.getUint32(0) !== 0x89504e47 ||
      header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(12) !== 0x49484452) {
    throw new Error("Choose a PNG image.");
  }
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  const nativeSize = width === SKIN_V1.width && height === SKIN_V1.height;
  if (format === "bombercraft" && !nativeSize) {
    throw new Error("A BomberCraft skin must be 64 × 32. For a Minecraft PNG, use Import Minecraft Skin.");
  }
  if (!nativeSize && !minecraftSkinLayout(width, height)) {
    throw new Error("Choose a Minecraft skin PNG sized 64 × 32, 64 × 64, or 128 × 128.");
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
  } catch {
    throw new Error("This PNG could not be opened.");
  }
  const source = makeCanvas(width, height);
  const ctx = source.getContext("2d", { willReadFrequently: true });
  try {
    ctx.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
  if (nativeSize) {
    const signature = ctx.getImageData(SKIN_V1.signatureX, SKIN_V1.signatureY, 4, 1).data;
    if (SKIN_V1.signature.every((value, index) => value === signature[index])) {
      return { file, sheet: source, faces: splitFaces(source) };
    }
  }
  if (format === "bombercraft") {
    throw new Error("The BomberCraft v1 marker is missing. For a legacy Minecraft PNG, use Import Minecraft Skin.");
  }

  const pixels = convertMinecraftSkin(ctx.getImageData(0, 0, width, height));
  const sheet = makeCanvas(SKIN_V1.width, SKIN_V1.height);
  sheet.getContext("2d").putImageData(new ImageData(pixels, sheet.width, sheet.height), 0, 0);
  const converted = await canvasPng(sheet);
  if (!converted) throw new Error("The skin could not be converted to a BomberCraft PNG.");
  return { file: converted, sheet, faces: splitFaces(sheet) };
}

function dataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function storedPng(value) {
  const base64 = value.slice(value.indexOf(",") + 1);
  return new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], { type: "image/png" });
}

export function wirePlayerSkin(dialog, onChange) {
  const preview = dialog.querySelector(".skin-preview");
  const updateViewer = wirePlayerViewer(dialog);
  const status = dialog.querySelector("[role=status]");
  const exportButton = dialog.querySelector("[data-export-skin]");
  const resetButton = dialog.querySelector("[data-reset-skin]");
  let selected;
  let generation = 0;

  function showSkin(skin) {
    selected = skin;
    const displayedSkin = skin ?? defaultSkin(0);
    const ctx = preview.getContext("2d");
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(displayedSkin.sheet, 0, 0);
    updateViewer(displayedSkin.faces);
    resetButton.disabled = !skin;
    onChange(skin?.faces);
  }

  showSkin();
  void (async () => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return;
      const skin = await decodeSkin(storedPng(saved));
      if (generation === 0) showSkin(skin);
    } catch {
      if (generation === 0) status.textContent = "The saved skin could not be loaded.";
    }
  })();

  for (const input of dialog.querySelectorAll("[data-skin-file]")) {
    const button = dialog.querySelector(`[data-import-skin="${input.dataset.skinFile}"]`);
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => void importSkin(input));
  }

  async function importSkin(input) {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    const current = ++generation;
    status.textContent = "Reading skin…";
    try {
      const skin = await decodeSkin(file, input.dataset.skinFile);
      const saved = await dataUrl(skin.file);
      if (current !== generation) return;
      showSkin(skin);
      try {
        localStorage.setItem(storageKey, saved);
        status.textContent = "Skin applied and saved in this browser.";
      } catch {
        status.textContent = "Skin applied for this session. Browser storage is unavailable.";
      }
    } catch (error) {
      if (current === generation) status.textContent = error.message;
    }
  }

  exportButton.addEventListener("click", async () => {
    const skin = selected;
    const png = skin?.file ?? await canvasPng(defaultSkin(0).sheet);
    if (!png) {
      status.textContent = "The skin could not be exported.";
      return;
    }
    const download = document.createElement("a");
    download.download = "bombercraft-player-v1.png";
    const url = URL.createObjectURL(png);
    download.href = url;
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  resetButton.addEventListener("click", () => {
    generation++;
    showSkin();
    try {
      localStorage.removeItem(storageKey);
      status.textContent = "Default skin restored.";
    } catch {
      status.textContent = "Default skin restored for this session.";
    }
  });
}
