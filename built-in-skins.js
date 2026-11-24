import { PLAYER_PARTS, SKIN_V1, SKIN_V1_RGBA_BYTES } from "./player-model.js";

export const builtInSkins = [
  { id: "explorer", name: "Explorer", skin: "#a96f49", hair: "#302c28", cloth: "#6c8245", trim: "#e6ca89", pants: "#765337", boots: "#372d2c" },
  { id: "engineer", name: "Engineer", skin: "#d6a278", hair: "#713a29", cloth: "#eac443", trim: "#366c9a", pants: "#315777", boots: "#343841" },
  { id: "astronaut", name: "Astronaut", skin: "#dbad87", hair: "#313e56", cloth: "#e7edf3", trim: "#ed784d", pants: "#c3d2df", boots: "#4d637d" },
  { id: "robot", name: "Robot", skin: "#899fab", hair: "#344653", cloth: "#647d8d", trim: "#5de5e5", pants: "#49626f", boots: "#2c3d4c" },
  { id: "ninja", name: "Ninja", skin: "#b87d60", hair: "#202642", cloth: "#303757", trim: "#a17bea", pants: "#252c46", boots: "#171c30" },
  { id: "pirate", name: "Pirate", skin: "#e0b48c", hair: "#513228", cloth: "#eee2c7", trim: "#b63f45", pants: "#65524d", boots: "#352d30" },
  { id: "wizard", name: "Wizard", skin: "#885744", hair: "#e8e4d7", cloth: "#71529c", trim: "#f0cc6a", pants: "#523e7a", boots: "#332d50" },
  { id: "knight", name: "Knight", skin: "#d6a883", hair: "#364751", cloth: "#aabac4", trim: "#d9b664", pants: "#708694", boots: "#405361" },
];

// Paint directly into the established UV layout, so presets use exactly the
// same PNG format, rendering and multiplayer protocol as imported skins.
export function createBuiltInSkin(id) {
  const palette = builtInSkins.find((entry) => entry.id === id);
  if (!palette) throw new RangeError(`Unknown built-in skin: ${id}`);
  const data = new Uint8ClampedArray(SKIN_V1_RGBA_BYTES);
  for (const part of PLAYER_PARTS) {
    for (const [face, [u, v, width, height]] of Object.entries(part.faces)) {
      const fill = (color, x = 0, y = 0, w = width, h = height) => {
        const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
        for (let row = y; row < Math.min(y + h, height); row++) {
          for (let col = x; col < Math.min(x + w, width); col++) {
            data.set([...rgb, 255], ((v + row) * SKIN_V1.width + u + col) * 4);
          }
        }
      };
      const { skin, hair, cloth, trim, pants, boots } = palette;
      if (part.name === "head") {
        const covering = { astronaut: cloth, robot: skin, ninja: cloth, knight: cloth }[id];
        const hat = id === "pirate" ? trim : ["explorer", "engineer", "wizard"].includes(id) ? cloth : hair;
        fill(covering ?? skin);
        if (face === "top" || face === "back") fill(covering ?? hat);
        if (!["top", "bottom", "back"].includes(face)) fill(covering ?? hat, 0, 0, width, 2);
        if (face === "front") {
          fill("#292c3d", 2, 3, 2, 1);
          fill("#292c3d", 6, 3, 2, 1);
          fill("#9b554b", 4, 5, 2, 1);
          if (id === "explorer" || id === "engineer") {
            fill(id === "engineer" ? "#f7da60" : trim, 0, 1, width, 1);
          } else if (id === "astronaut") {
            fill("#263f5b", 1, 1, 8, 5);
            fill("#70d5e7", 2, 2, 6, 2);
            fill("#d5fcff", 2, 2, 2, 1);
          } else if (id === "robot") {
            fill(hair, 1, 2, 8, 3);
            fill(trim, 2, 3, 2, 1); fill(trim, 6, 3, 2, 1);
            fill("#eea75b", 4, 0, 2, 1); fill(hair, 3, 6, 4, 1);
          } else if (id === "ninja") {
            fill(skin, 1, 2, 8, 2);
            fill("#171c30", 2, 3, 2, 1); fill("#171c30", 6, 3, 2, 1);
            fill(cloth, 0, 4, width, 3);
          } else if (id === "pirate") {
            fill(hair, 1, 5, 8, 2); fill("#20252c", 6, 2, 3, 3);
          } else if (id === "wizard") {
            fill(hair, 1, 5, 8, 2); fill(trim, 4, 0, 2, 1);
          } else if (id === "knight") {
            fill("#263f4c", 1, 2, 8, 2); fill("#d6e1e4", 4, 2, 2, 4);
            fill(trim, 3, 0, 4, 1);
          }
        }
      } else if (part.name === "torso") {
        fill(cloth);
        if (height === 9) fill(boots, 0, 7, width, 2);
        if (face === "front") {
          if (id === "astronaut" || id === "robot") {
            fill("#2c465a", 2, 2, 4, 4); fill(trim, 3, 3, 2, 2);
            fill(id === "robot" ? trim : "#7bd4de", 1, 7, 6, 1);
          } else if (id === "engineer") {
            fill(trim, 1, 0, 1, 7); fill(trim, 6, 0, 1, 7);
            fill(trim, 1, 4, 6, 3); fill("#f6db6e", 2, 4, 1, 1);
          } else if (id === "pirate") {
            fill("#3e526d", 0, 2, width, 1); fill("#3e526d", 0, 4, width, 1);
            fill(trim, 0, 6, width, 2);
          } else if (id === "wizard") {
            fill(trim, 3, 0, 2, 8); fill(trim, 0, 4, 1, 1); fill(trim, 6, 2, 1, 1);
          } else if (id === "ninja") {
            for (let y = 0; y < 7; y++) fill(trim, y, y, 2, 1);
          } else if (id === "knight") {
            fill("#718b9b", 0, 1, width, 1); fill(trim, 2, 4, 4, 2);
          } else {
            fill(trim, 3, 0, 2, 6); fill(pants, 1, 3, 2, 2); fill(pants, 5, 3, 2, 2);
          }
        } else if (face === "back" && id === "explorer") {
          fill(pants, 1, 1, 6, 6); fill(trim, 2, 2, 4, 1);
        }
      } else if (part.name.endsWith("Arm")) {
        fill(cloth);
        const glove = ["astronaut", "robot", "ninja", "knight"].includes(id);
        if (height === 9) {
          fill(trim, 0, 5, width, 1);
          fill(glove ? boots : skin, 0, 6, width, 3);
        }
        if (face === "bottom") fill(glove ? boots : skin);
      } else {
        fill(pants);
        if (height === 8) {
          fill(boots, 0, 6, width, 2);
          if (id === "robot" || id === "knight") fill(cloth, 0, 3, width, 1);
          if (id === "ninja") fill(trim, 0, 5, width, 1);
        }
        if (face === "bottom") fill(boots);
      }
    }
  }
  data.set(SKIN_V1.signature, (SKIN_V1.signatureY * SKIN_V1.width + SKIN_V1.signatureX) * 4);
  return { width: SKIN_V1.width, height: SKIN_V1.height, data };
}
