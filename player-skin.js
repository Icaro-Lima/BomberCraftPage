import { localizedText } from "./i18n.js";
import { hasSkinSignature, PLAYER_PARTS, playerColors, SKIN_V1, SKIN_V1_RGBA_BYTES } from "./player-model.js";
import { wirePlayerViewer } from "./player-viewer.js";
import { convertMinecraftSkin, minecraftSkinLayout } from "./minecraft-skin.js";
import { builtInSkins, createBuiltInSkin } from "./built-in-skins.js";

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

export function roomSkinFaces(encoded) {
  if (typeof encoded !== "string" || encoded.length !== Math.ceil(SKIN_V1_RGBA_BYTES / 3) * 4) return;
  let bytes;
  try {
    bytes = atob(encoded);
  } catch {
    return;
  }
  if (bytes.length !== SKIN_V1_RGBA_BYTES) return;
  const pixels = Uint8ClampedArray.from(bytes, (byte) => byte.charCodeAt(0));
  if (!hasSkinSignature(pixels)) return;
  const sheet = makeCanvas(SKIN_V1.width, SKIN_V1.height);
  sheet.getContext("2d").putImageData(new ImageData(pixels, sheet.width, sheet.height), 0, 0);
  return splitFaces(sheet);
}

const defaultSkins = playerColors.map((shirt) => {
  const sheet = makeDefaultSheet(shirt);
  return { sheet, faces: splitFaces(sheet) };
});

const presets = builtInSkins.map((definition) => {
  const pixels = createBuiltInSkin(definition.id);
  const sheet = makeCanvas(pixels.width, pixels.height);
  const ctx = sheet.getContext("2d");
  const image = ctx.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  ctx.putImageData(image, 0, 0);
  return { ...definition, sheet, pixels: pixels.data };
});

function identifyPreset(sheet) {
  const pixels = sheet.getContext("2d").getImageData(0, 0, sheet.width, sheet.height).data;
  return presets.find((preset) => preset.pixels.every((value, index) => value === pixels[index]));
}

function drawSkinThumbnail(canvas, sheet) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  // A front-facing paper doll uses the same pixels as the 3D player.
  const placements = [[5, 1], [6, 8], [3, 8], [14, 8], [6, 17], [11, 17]];
  PLAYER_PARTS.forEach((part, index) => {
    const [x, y] = placements[index];
    const [u, v, w, h] = part.faces.front;
    ctx.drawImage(sheet, u, v, w, h, x * 2, y * 2, w * 2, h * 2);
  });
}

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
  const image = ctx.getImageData(0, 0, width, height);
  if (nativeSize && hasSkinSignature(image.data)) {
    return { file, sheet: source, faces: splitFaces(source) };
  }
  if (format === "bombercraft") {
    throw new Error("The BomberCraft v1 marker is missing. For a legacy Minecraft PNG, use Import Minecraft Skin.");
  }

  const pixels = convertMinecraftSkin(image);
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
  const gallery = dialog.querySelector(".skin-gallery");
  const currentName = dialog.querySelector("[data-current-skin]");
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
    const preset = skin ? identifyPreset(skin.sheet) : null;
    localizedText(currentName, preset?.name ?? (skin ? "Imported skin" : "Default"));
    for (const button of gallery.querySelectorAll("[data-builtin-skin]")) {
      button.setAttribute("aria-pressed", String(button.dataset.builtinSkin === preset?.id));
    }
    onChange(skin);
  }

  for (const preset of presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "skin-option";
    button.dataset.builtinSkin = preset.id;
    button.setAttribute("aria-pressed", "false");
    const canvas = makeCanvas(40, 52);
    canvas.setAttribute("aria-hidden", "true");
    drawSkinThumbnail(canvas, preset.sheet);
    const label = document.createElement("span");
    localizedText(label, preset.name);
    button.append(canvas, label);
    button.addEventListener("click", () => {
      generation++;
      const skin = { sheet: preset.sheet, faces: splitFaces(preset.sheet) };
      showSkin(skin);
      try {
        localStorage.setItem(storageKey, preset.sheet.toDataURL("image/png"));
        localizedText(status, "Skin applied and saved in this browser.");
      } catch {
        localizedText(status, "Skin applied for this session. Browser storage is unavailable.");
      }
    });
    gallery.append(button);
  }

  showSkin();
  void (async () => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return;
      const skin = await decodeSkin(storedPng(saved));
      if (generation === 0) showSkin(skin);
    } catch {
      if (generation === 0) localizedText(status, "The saved skin could not be loaded.");
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
    localizedText(status, "Reading skin…");
    try {
      const skin = await decodeSkin(file, input.dataset.skinFile);
      const saved = await dataUrl(skin.file);
      if (current !== generation) return;
      showSkin(skin);
      try {
        localStorage.setItem(storageKey, saved);
        localizedText(status, "Skin applied and saved in this browser.");
      } catch {
        localizedText(status, "Skin applied for this session. Browser storage is unavailable.");
      }
    } catch (error) {
      if (current === generation) localizedText(status, error.message);
    }
  }

  exportButton.addEventListener("click", async () => {
    const skin = selected;
    const png = skin?.file ?? await canvasPng(skin?.sheet ?? defaultSkin(0).sheet);
    if (!png) {
      localizedText(status, "The skin could not be exported.");
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
      localizedText(status, "Default skin restored.");
    } catch {
      localizedText(status, "Default skin restored for this session.");
    }
  });
}
