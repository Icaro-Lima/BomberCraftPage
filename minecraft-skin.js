import { boxFaces, PLAYER_PARTS, SKIN_V1 } from "./player-model.js";

// Box UV origins in the standard 64-pixel layout. BomberCraft names limbs
// from the front viewer's perspective, so its left is the player's right.
const origins = {
  head: { base: [0, 0], outer: [32, 0] },
  torso: { base: [16, 16], outer: [16, 32] },
  leftArm: { base: [40, 16], outer: [40, 32] },
  rightArm: { base: [32, 48], outer: [48, 48], legacyMirror: [40, 16] },
  leftLeg: { base: [0, 16], outer: [0, 32] },
  rightLeg: { base: [16, 48], outer: [0, 48], legacyMirror: [0, 16] },
};

export function minecraftSkinLayout(width, height) {
  if (width === 64 && height === 32) return { scale: 1, legacy: true };
  if (width === height && (width === 64 || width === 128)) return { scale: width / 64, legacy: false };
  return null;
}

function everyTexel({ data, width }, [x, y, w, h], scale, matches) {
  for (let row = y * scale; row < (y + h) * scale; row++) {
    for (let col = x * scale; col < (x + w) * scale; col++) {
      if (!matches(data, (row * width + col) * 4)) return false;
    }
  }
  return true;
}

function hasSlimArmPadding(source, [x, y], scale) {
  // The narrower faces leave two columns unused on the cap and side rows.
  const margins = [[x + 10, y, 2, 4], [x + 14, y + 4, 2, 12]];
  if (margins.every((rect) => everyTexel(source, rect, scale, (data, i) => data[i + 3] === 0))) return true;

  // Some editors flatten transparent padding to black or white. Check that
  // it matches the unused corner and has a visible boundary with the arm.
  const corner = (y * scale * source.width + x * scale) * 4;
  const matte = source.data[corner];
  if (matte !== 0 && matte !== 255) return false;
  const matchesMatte = (data, i) => data[i] === matte && data[i + 1] === matte && data[i + 2] === matte && data[i + 3] === 255;
  return everyTexel(source, [x, y, 4, 4], scale, matchesMatte) &&
    margins.every((rect) => everyTexel(source, rect, scale, matchesMatte)) &&
    margins.some(([u, v, , h]) => !everyTexel(source, [u - 1, v, 1, h], scale, matchesMatte));
}

function hasLegacyHat(data, width) {
  // Pre-alpha sheets often filled the unused upper-right region. A legacy
  // hat is used if that region contains any transparent or cutout pixels.
  for (let y = 0; y < 32; y++) {
    for (let x = 32; x < 64; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) return true;
    }
  }
  return false;
}

function over(output, target, data, source) {
  const alpha = data[source + 3];
  if (alpha === 0) return;
  if (alpha === 255 || output[target + 3] === 0) {
    output.set(data.subarray(source, source + 4), target);
    return;
  }
  const remaining = output[target + 3] * (1 - alpha / 255);
  const combined = alpha + remaining;
  for (let channel = 0; channel < 3; channel++) {
    output[target + channel] = (data[source + channel] * alpha + output[target + channel] * remaining) / combined;
  }
  output[target + 3] = combined;
}

function copyFace(source, output, rect, targetRect, scale, flipX, flipY) {
  const [sx, sy, sw, sh] = rect.map((value) => value * scale);
  const [dx, dy, dw, dh] = targetRect;
  for (let y = 0; y < dh; y++) {
    const row = Math.floor((y + 0.5) * sh / dh);
    const sourceY = sy + (flipY ? sh - 1 - row : row);
    for (let x = 0; x < dw; x++) {
      const col = Math.floor((x + 0.5) * sw / dw);
      const sourceX = sx + (flipX ? sw - 1 - col : col);
      const start = (sourceY * source.width + sourceX) * 4;
      const target = ((dy + y) * SKIN_V1.width + dx + x) * 4;
      over(output, target, source.data, start);
    }
  }
}

export function convertMinecraftSkin(source) {
  const layout = minecraftSkinLayout(source.width, source.height);
  if (!layout) throw new Error("Choose a Minecraft skin PNG sized 64 × 32, 64 × 64, or 128 × 128.");
  const { scale, legacy } = layout;
  const slim = !legacy && [origins.leftArm.base, origins.rightArm.base].every((origin) => hasSlimArmPadding(source, origin, scale));
  const data = new Uint8ClampedArray(SKIN_V1.width * SKIN_V1.height * 4);
  const legacyHat = legacy && hasLegacyHat(source.data, source.width);
  for (const { name, faces } of PLAYER_PARTS) {
    const { base, outer, legacyMirror } = origins[name];
    const mirrored = legacy && !!legacyMirror;
    const size = name === "head" ? [8, 8, 8] :
      [name === "torso" ? 8 : slim && name.endsWith("Arm") ? 3 : 4, 12, 4];
    const baseFaces = boxFaces(mirrored ? legacyMirror : base, size);
    const outerFaces = !legacy || (legacyHat && name === "head") ? boxFaces(outer, size) : null;
    for (const [face, target] of Object.entries(faces)) {
      // Mirroring a legacy limb swaps its side faces as well as flipping its pixels.
      const sourceFace = !mirrored ? face : face === "left" ? "right" : face === "right" ? "left" : face;
      // The source bottom runs back-to-front. BomberCraft's bottom is front-to-back.
      const flipY = face === "bottom";
      copyFace(source, data, baseFaces[sourceFace], target, scale, mirrored, flipY);
      if (outerFaces) copyFace(source, data, outerFaces[face], target, scale, false, flipY);
    }
  }
  data.set(SKIN_V1.signature, (SKIN_V1.signatureY * SKIN_V1.width + SKIN_V1.signatureX) * 4);
  return data;
}
