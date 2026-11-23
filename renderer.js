import arena from "./rules/arena.js";
import { partVertices, PLAYER_FACES, PLAYER_PARTS, playerColors, TILE_PIXELS } from "./player-model.js";
import { defaultSkin } from "./player-skin.js";

const assets = Object.fromEntries([
  "hard_block", "soft_block", "soft_block_cracks", "tnt", "tnt_top",
  "powerup_fire", "powerup_bomb", "powerup_skate",
].map((name) => {
  const image = new Image();
  image.src = new URL(`./assets/${name}.svg`, import.meta.url);
  return [name, image];
}));

// Rasterize SVGs at their native resolution before projecting them onto faces.
// This also avoids browser-dependent SVG rasterization at a 1 × 1 destination.
const textures = new Map();
let textureRevision = 0;
// Red values in the shared crack mask mark when each branch appears.
const crackThresholds = [3, 51, 102, 153, 204];
let crackFrames = [];

function makeCrackFrames(mask) {
  const { width, height } = mask;
  const source = mask.getContext("2d").getImageData(0, 0, width, height).data;
  return crackThresholds.map((threshold) => {
    const frame = document.createElement("canvas");
    frame.width = width;
    frame.height = height;
    const context = frame.getContext("2d");
    const pixels = context.createImageData(width, height);
    for (let i = 0; i < source.length; i += 4) {
      if (source[i] > threshold || !source[i + 3]) continue;
      pixels.data.set([53, 27, 16, source[i + 3]], i);
    }
    context.putImageData(pixels, 0, 0);
    return frame;
  });
}

for (const [name, image] of Object.entries(assets)) {
  image.addEventListener("load", () => {
    const bitmap = document.createElement("canvas");
    bitmap.width = image.naturalWidth;
    bitmap.height = image.naturalHeight;
    bitmap.getContext("2d").drawImage(image, 0, 0);
    if (name === "soft_block_cracks") crackFrames = makeCrackFrames(bitmap);
    else textures.set(name, bitmap);
    textureRevision++;
  }, { once: true });
}

const fixedWalls = arena.rows.flatMap((row, z) => [...row].flatMap((tile, x) => tile === "#" ? [{ x, z }] : []));
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const floorBase = 2;
const floorGrass = 7;
const floorBottom = -floorBase - floorGrass;
const wallSize = TILE_PIXELS;
const crateSize = 15;
const crateColors = ["#eda75a", "#c77b40", "#925039"];
const crateChipColors = ["#ffd38a", "#dd9550", "#ad683d"];
export const CRATE_DEBRIS_MS = 420;
const bombSize = 14;
const bombMaxSize = 15;
const thrownBombRise = 37;
const fallingBlockHeight = 48;
const arenaCameraAngle = 60 * Math.PI / 180;
const faceShades = {
  left: "#21133a3b", front: "#21133a16", right: "#21133a2d",
  back: "#21133a35", top: "", bottom: "#21133a55",
};
const cartTrim = ["#edac6b", "#bc794c", "#88533d"];
const cartParts = [
  { corner: [-9, 0, -6], size: [18, 4, 12], colors: ["#eeb974", "#a06146", "#805043"] },
  { corner: [-9, 4, -6], size: [2, 3, 12], colors: cartTrim },
  { corner: [7, 4, -6], size: [2, 3, 12], colors: cartTrim },
  { corner: [-7, 4, -6], size: [14, 3, 2], colors: cartTrim },
  { corner: [-7, 4, 4], size: [14, 2, 2], colors: ["#ffd38a", "#d49355", "#9a5b35"] },
];

function splitPolygon(vertices, distance) {
  const distances = vertices.map(distance);
  if (distances.every((d) => d >= 0)) return [vertices, []];
  if (distances.every((d) => d <= 0)) return [[], vertices];

  const front = [];
  const back = [];
  for (let i = 0; i < vertices.length; i++) {
    const next = (i + 1) % vertices.length;
    const a = distances[i];
    const b = distances[next];
    if (a >= 0) front.push(vertices[i]);
    if (a <= 0) back.push(vertices[i]);
    if ((a > 0 && b < 0) || (a < 0 && b > 0)) {
      const t = a / (a - b);
      const boundary = vertices[i].map((v, axis) => v + (vertices[next][axis] - v) * t);
      front.push(boundary);
      back.push(boundary);
    }
  }
  return [front, back];
}

export function makeRenderer(canvas, { width = 15, depth = 13, hero = false, cacheStatic = true } = {}) {
  let ctx = canvas.getContext("2d");
  const skew = hero ? .58 : 0;
  const pitch = hero ? .57 : Math.sin(arenaCameraAngle);
  // The home preview angles depth only; front faces keep their pixel proportions.
  const lift = hero ? 1 : Math.cos(arenaCameraAngle);
  const cameraDistance = 88 * TILE_PIXELS;
  const halfTile = TILE_PIXELS / 2;
  const boardWidth = width * TILE_PIXELS;
  const boardDepth = depth * TILE_PIXELS;
  const centerX = (boardWidth - TILE_PIXELS) / 2;
  const centerZ = (boardDepth - TILE_PIXELS) / 2;
  let scale;
  let originX;
  let originY;
  let arenaPadding;
  let pixelRatio;
  let lastViewWidth;
  let lastViewHeight;
  let cachedTextureRevision = -1;
  const staticBitmaps = new Map();
  const walks = new Map();

  function perspective(z, y) {
    return cameraDistance / (cameraDistance - ((z - centerZ) * lift + y * pitch));
  }

  function arenaPoint(x, z, y) {
    const zoom = perspective(z, y);
    return [(x - centerX) * zoom, ((z - centerZ) * pitch - y * lift) * zoom];
  }

  // Include the platform base and overhead room for falling blocks and TNT.
  const outside = halfTile + 5;
  const corners = [-outside, boardWidth - TILE_PIXELS + outside].flatMap((x) =>
    [-outside, boardDepth - TILE_PIXELS + outside].flatMap((z) =>
      [floorBottom, 67].map((y) => arenaPoint(x, z, y))
    )
  );
  const minX = Math.min(...corners.map(([x]) => x));
  const maxX = Math.max(...corners.map(([x]) => x));
  // Center on the visible field, independent of the room reserved for effects.
  const [, fieldTop] = arenaPoint(centerX, -halfTile, wallSize);
  const [, fieldBottom] = arenaPoint(centerX, boardDepth - halfTile, floorBottom);
  const fieldCenterY = (fieldTop + fieldBottom) / 2;

  function point(x, z, y = 0) {
    const [projectedX, projectedY] = hero ? [x + z * skew, z * pitch - y * lift] : arenaPoint(x, z, y);
    return [originX + projectedX * scale, originY + projectedY * scale];
  }

  function boxBounds(x, z, y, w, d, h) {
    const points = [x - w / 2, x + w / 2].flatMap((px) =>
      [z - d / 2, z + d / 2].flatMap((pz) => [y, y + h].map((py) => point(px, pz, py)))
    );
    return {
      left: Math.floor(Math.min(...points.map(([px]) => px)) * pixelRatio) / pixelRatio - 1,
      top: Math.floor(Math.min(...points.map(([, py]) => py)) * pixelRatio) / pixelRatio - 1,
      right: Math.ceil(Math.max(...points.map(([px]) => px)) * pixelRatio) / pixelRatio + 1,
      bottom: Math.ceil(Math.max(...points.map(([, py]) => py)) * pixelRatio) / pixelRatio + 1,
    };
  }

  function cachedBox(key, x, z, y, w, d, h, draw) {
    if (!cacheStatic) {
      draw();
      return;
    }
    let entry = staticBitmaps.get(key);
    if (!entry) {
      const bounds = boxBounds(x, z, y, w, d, h);
      const bitmap = document.createElement("canvas");
      bitmap.width = Math.ceil((bounds.right - bounds.left) * pixelRatio);
      bitmap.height = Math.ceil((bounds.bottom - bounds.top) * pixelRatio);
      const output = ctx;
      try {
        ctx = bitmap.getContext("2d");
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, -bounds.left * pixelRatio, -bounds.top * pixelRatio);
        ctx.imageSmoothingEnabled = false;
        draw();
      } finally {
        ctx = output;
      }
      entry = { bitmap, left: bounds.left, top: bounds.top };
      staticBitmaps.set(key, entry);
    }
    ctx.drawImage(entry.bitmap, entry.left, entry.top, entry.bitmap.width / pixelRatio, entry.bitmap.height / pixelRatio);
  }

  function trace(points) {
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const p of points.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
  }

  function polygon(points, fill) {
    trace(points);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function face(points, color, image, shade = "", cracks) {
    // Every face has an opaque material, including while its texture loads.
    polygon(points, color);
    if (!image) return;
    const [a, b, , d] = points;
    ctx.save();
    if (!hero) {
      // A projected face can be slightly trapezoidal. Clip the texture to its
      // silhouette and let the sample extend a little past the edges.
      trace(points);
      ctx.clip();
    }
    ctx.transform(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1], a[0], a[1]);
    const bleed = hero ? 0 : .02;
    ctx.drawImage(image, -bleed, -bleed, 1 + 2 * bleed, 1 + 2 * bleed);
    if (cracks) ctx.drawImage(cracks, -bleed, -bleed, 1 + 2 * bleed, 1 + 2 * bleed);
    if (shade) {
      ctx.fillStyle = shade;
      ctx.fillRect(-bleed, -bleed, 1 + 2 * bleed, 1 + 2 * bleed);
    }
    ctx.restore();
  }

  function box(x, z, y, w, d, h, colors, textures = [], cracks) {
    const l = x - w / 2;
    const r = x + w / 2;
    const b = z - d / 2;
    const f = z + d / 2;
    const top = y + h;
    if (hero || l > centerX) {
      face([point(l,b,top), point(l,f,top), point(l,f,y), point(l,b,y)], colors[2], textures[1], "#1814424c", cracks);
    }
    if (!hero && r < centerX) {
      face([point(r,f,top), point(r,b,top), point(r,b,y), point(r,f,y)], colors[2], textures[1], "#1814424c", cracks);
    }
    face([point(l,f,top), point(r,f,top), point(r,f,y), point(l,f,y)], colors[1], textures[1], "#21133a25", cracks);
    face([point(l,b,top), point(r,b,top), point(r,f,top), point(l,f,top)], colors[0], textures[0], "", cracks);
  }

  function cube(x, z, y, size, colors, textures, cracks) {
    box(x, z, y, size, size, size, colors, textures, cracks);
  }

  function flat(x, z, w, d, y, color) {
    const left = x - w / 2;
    const right = x + w / 2;
    const back = z - d / 2;
    const front = z + d / 2;
    polygon([point(left,back,y), point(right,back,y), point(right,front,y), point(left,front,y)], color);
  }

  function shadow(x, z, w, d, color = "#19283e45") {
    const size = hero ? scale : scale * perspective(z, 0);
    const [px, py] = point(x, z);
    ctx.beginPath();
    ctx.ellipse(px, py, size * w / 2, size * pitch * d / 2, .05, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function sprite(texture, x, z, y, size) {
    const image = assets[texture];
    if (!image?.complete || !image.naturalWidth) return;
    const [px, py] = point(x, z, y);
    const pixels = size * scale * (hero ? 1 : perspective(z, y));
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
    const spriteWidth = pixels * image.naturalWidth / longestSide;
    const spriteHeight = pixels * image.naturalHeight / longestSide;
    ctx.drawImage(image, Math.round(px - spriteWidth / 2), Math.round(py - spriteHeight / 2),
      Math.round(spriteWidth), Math.round(spriteHeight));
  }

  function drawFloor() {
    box(centerX, centerZ, floorBottom, boardWidth, boardDepth, floorBase, ["#5b4865", "#4a3d60", "#372943"]);
    box(centerX, centerZ, -floorGrass, boardWidth, boardDepth, floorGrass, ["#9de681", "#688847", "#435c46"]);
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const tileX = x * TILE_PIXELS;
        const tileZ = z * TILE_PIXELS;
        flat(tileX, tileZ, TILE_PIXELS, TILE_PIXELS, 0, (x + z) % 2 === 0 ? "#8ddd70" : "#a4eb80");
        if ((x * 13 + z * 17) % 7 === 0) {
          flat(tileX - 5, tileZ + 4, 2, 1, 0, "#67a34d6b");
          flat(tileX - 3, tileZ + 5, 1, 1, 0, "#d5ffc299");
        }
      }
    }
  }

  function drawWall({ x, z, y = 0 }) {
    const texture = textures.get("hard_block");
    const draw = () => cube(x * TILE_PIXELS, z * TILE_PIXELS, y, wallSize, ["#b7d6ff", "#869fd8", "#627bcb"], [texture, texture]);
    // Falling walls remain dynamic; grounded walls keep their exact projection.
    if (y !== 0) draw();
    else cachedBox(`wall:${x},${z}`, x * TILE_PIXELS, z * TILE_PIXELS, 0, wallSize, wallSize, wallSize, draw);
  }

  function drawCrate({ x, z, hitAt, destroyAt }, now) {
    if (destroyAt !== undefined && now >= destroyAt) return;
    const progress = hitAt === undefined ? 0 : clamp((now - hitAt) / (destroyAt - hitAt), 0, 1);
    const stage = crackThresholds.findLastIndex((threshold) => threshold <= progress * 255);
    const cracks = crackFrames[stage];
    const texture = textures.get("soft_block");
    const draw = () => cube(x * TILE_PIXELS, z * TILE_PIXELS, 0, crateSize, crateColors, [texture, texture], cracks);
    // Cracks animate briefly and should not leave a bitmap for every damage stage.
    if (hitAt !== undefined) draw();
    else cachedBox(`crate:${x},${z}`, x * TILE_PIXELS, z * TILE_PIXELS, 0, crateSize, crateSize, crateSize, draw);
  }

  function addCrateDebris({ x, z, destroyAt }, now, add) {
    const progress = (now - destroyAt) / CRATE_DEBRIS_MS;
    const spread = 1 - (1 - progress) ** 2;
    const shrink = 1 - clamp((progress - .45) / .55, 0, 1);
    for (let i = 0; i < 8; i++) {
      const chip = i % 2 === 1;
      const angle = (x * 3 + z * 5 + i * 2) * Math.PI / 8;
      const distance = 3 + (7 + i % 3 * 3) * spread;
      const px = x * TILE_PIXELS + Math.cos(angle) * distance;
      const pz = z * TILE_PIXELS + Math.sin(angle) * distance;
      const height = Math.max(0, (chip ? 9 : 5) + progress * (38 + i % 3 * 7 - 60 * progress));
      const colors = chip ? crateChipColors : crateColors;
      add({ x: px / TILE_PIXELS, z: pz / TILE_PIXELS }, () => {
        box(px, pz, height, (chip ? 2 : 5) * shrink, (chip ? 2 : 4) * shrink,
          (chip ? 2 : 3) * shrink, colors);
      });
    }
  }

  function drawTnt(x, z, y, size, flash) {
    const colors = flash ? ["#fff9ef", "#ffe6e0", "#ffc6bc"] : ["#ef6071", "#df435e", "#a72f4e"];
    cube(x, z, y, size, colors, flash ? [] : [textures.get("tnt_top"), textures.get("tnt")]);
  }

  function drawBomb(bomb, now, players, selfId) {
    const remaining = bomb.detonateAt - now;
    const swell = Math.pow(clamp(1 - remaining / 500, 0, 1), 3) * (bombMaxSize - bombSize);
    const airborne = bomb.landAt !== undefined && now < bomb.landAt;
    if (airborne) {
      const t = clamp((now - bomb.thrownAt) / (bomb.landAt - bomb.thrownAt), 0, 1);
      flat(bomb.x * TILE_PIXELS, bomb.z * TILE_PIXELS, bombSize, bombSize, 0, "#fff5c97a");
      const x = bomb.fromX + (bomb.x - bomb.fromX) * t;
      const z = bomb.fromZ + (bomb.z - bomb.fromZ) * t;
      drawTnt(x * TILE_PIXELS, z * TILE_PIXELS, (1 - t) * 19 + Math.sin(t * Math.PI) * thrownBombRise, bombSize, false);
      return;
    }
    const x = bomb.x * TILE_PIXELS;
    const z = bomb.z * TILE_PIXELS;
    const size = bombSize + swell;
    const flash = Math.floor(remaining / 250) % 2 === 1;
    if (!players) {
      drawTnt(x, z, 0, size, flash);
      return;
    }

    const half = size / 2;
    const planes = [([, , py]) => py - size, ([, pz]) => pz - (z + half)];
    if (x + half < centerX) planes.push(([px]) => px - (x + half));
    if (x - half > centerX) planes.push(([px]) => (x - half) - px);
    const foreground = [];
    for (const player of players) avatar(player, now, selfId !== undefined && selfId === player.id, { planes, foreground });
    drawTnt(x, z, 0, size, flash);
    for (const draw of foreground) draw();
  }

  function drawBlast({ x, z, expiresAt }, now) {
    const power = clamp((expiresAt - now) / 500, 0, 1);
    const phase = Math.round(now / 35) % 3;
    const tileX = x * TILE_PIXELS;
    const tileZ = z * TILE_PIXELS;
    flat(tileX, tileZ, TILE_PIXELS, TILE_PIXELS, 0, `rgba(255,114,54,${.48 + power * .45})`);
    flat(tileX, tileZ, 13, 13, 0, `rgba(255,205,71,${.57 + power * .35})`);
    for (let i = 0; i < 4; i++) {
      const size = 3 + power * 2;
      const dx = (i * 3 + phase) % 11 - 5;
      const dz = (i * 5 + phase) % 11 - 5;
      box(tileX + dx, tileZ + dz, 0, size, size, power * (4 + i),
        ["#fff9d6", "#ffc557", "#ff984f"]);
    }
  }

  function marker(x, z, y, color, now) {
    const [px, py] = point(x, z, y + Math.sin(now / 160));
    const radius = scale * 3 * (hero ? 1 : perspective(z, y));
    polygon([[px - radius, py - radius], [px + radius, py - radius], [px, py + radius]], "#241848");
    polygon([[px - radius * .65, py - radius * .72], [px + radius * .65, py - radius * .72], [px, py + radius * .54]], color);
  }

  function cartYaw({ x, z }) {
    // Blend the inward directions within half a tile of a corner.
    const nearEdge = (distance) => clamp(1 - 2 * distance, 0, 1);
    const inwardX = nearEdge(x) - nearEdge(width - 1 - x);
    const inwardZ = nearEdge(z) - nearEdge(depth - 1 - z);
    return Math.atan2(inwardX, inwardZ);
  }

  function avatar(player, now, self, bombOverlap) {
    const { slot, alive, direction, invulnerable, bombReady } = player;
    const x = player.x * TILE_PIXELS;
    const z = player.z * TILE_PIXELS;
    const shirt = playerColors[slot];
    const skin = player.skin ?? defaultSkin(slot).faces;
    const cartY = alive ? 0 : wallSize + 1 + Math.sin(now / 190);
    const foot = alive ? 0 : cartY + 2;
    if (alive) {
      shadow(x, z, 12, 9);
      if (invulnerable) shadow(x, z, 15 + Math.sin(now / 90), 13, "#ffef947f");
    }

    const walkKey = player.id ?? slot;
    const previous = walks.get(walkKey);
    const elapsed = previous ? clamp((now - previous.time) / 1000, 0, .1) : 0;
    const distance = previous ? Math.hypot(x - previous.x, z - previous.z) / TILE_PIXELS : 0;
    const continuous = previous?.alive === alive && distance < .5 && elapsed > 0;
    const walking = alive && continuous && distance > .0001;
    const phase = (previous?.phase ?? 0) + (continuous ? distance * Math.PI * 2 / 1.85 : 0);
    const blend = (previous?.blend ?? 0) +
      ((walking ? 1 : 0) - (previous?.blend ?? 0)) * Math.min(1, elapsed * 18);
    walks.set(walkKey, { x, z, time: now, alive, phase, blend });
    const swing = Math.sin(phase) * .65 * blend;
    const yaw = alive ? [Math.PI / 2, -Math.PI / 2, 0, Math.PI, 0][direction ?? 4] : cartYaw(player);
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const faces = [];
    const transform = ([px, pz, py]) => [
      x + px * cosine + pz * sine,
      z - px * sine + pz * cosine,
      py,
    ];

    function addPart(vertices, material) {
      for (const [name, indices] of Object.entries(PLAYER_FACES)) {
        const world = indices.map((index) => vertices[index]);
        const projected = world.map(([px, pz, py]) => point(px, pz, py));
        const [a, b, c] = projected;
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (area <= .00001) continue;
        // Sort the avatar's visible faces, including the cart when present.
        const depth = world.reduce((sum, [px, pz, py]) => sum - skew * px + pz + pitch / lift * py, 0) / 4;
        faces.push({ world, projected, depth, ...material(name) });
      }
    }

    if (!alive) {
      for (const { corner, size, colors } of cartParts) {
        const vertices = partVertices(corner, size).map(([px, py, pz]) => transform([px, pz, cartY + py]));
        addPart(vertices, (side) => ({ color: colors[side === "top" ? 0 : side === "front" || side === "back" ? 1 : 2] }));
      }
    }

    const poseY = foot - (alive ? 0 : 4);
    const poseZ = alive ? 0 : -2;
    for (const { name, pivot, corner, size } of PLAYER_PARTS) {
      const [pivotX, pivotY, pivotZ] = pivot;
      const side = name.startsWith("left") ? -1 : 1;
      const leg = name.endsWith("Leg");
      const arm = name.endsWith("Arm");
      let angle = 0;
      if (leg) angle = alive ? side * swing : Math.PI / 2;
      if (arm) angle = bombReady ? Math.PI : -side * swing * .8;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const vertices = partVertices(corner, size).map(([partX, partY, partZ]) => transform([
        pivotX + partX,
        pivotZ + poseZ + partZ * cos - partY * sin,
        pivotY + poseY + partZ * sin + partY * cos,
      ]));

      addPart(vertices, (side) => ({ color: "#344362", image: skin[name][side], shade: faceShades[side] }));
    }
    faces.sort((a, b) => a.depth - b.depth);
    function drawPartFace(entry, vertices = entry.world) {
      const clipped = vertices !== entry.world;
      if (clipped) {
        ctx.save();
        trace(vertices.map(([px, pz, py]) => point(px, pz, py)));
        ctx.clip();
      }
      face(entry.projected, entry.color, entry.image, entry.shade);
      if (clipped) ctx.restore();
    }

    for (const entry of faces) {
      if (!bombOverlap) {
        drawPartFace(entry);
        continue;
      }
      let behind = entry.world;
      // A fragment in front of any visible TNT plane can be drawn over the cube.
      // Only the part behind all of those planes belongs underneath it.
      for (const plane of bombOverlap.planes) {
        const [front, back] = splitPolygon(behind, plane);
        if (front.length >= 3) bombOverlap.foreground.push(() => drawPartFace(entry, front));
        behind = back;
        if (behind.length < 3) break;
      }
      if (behind.length >= 3) drawPartFace(entry, behind);
    }

    if (bombReady) drawTnt(x, z, foot + 21, 8, false);
    if (self) {
      const drawMarker = () => marker(x, z, foot + (bombReady ? 33 : 28), shirt, now);
      if (bombOverlap) bombOverlap.foreground.push(drawMarker);
      else drawMarker();
    }
  }

  function particles(death, now) {
    const t = (now - death.at) / 1000;
    if (t < 0 || t > 1) return;
    ctx.globalAlpha = 1 - t;
    for (let i = 0; i < 11; i++) {
      const angle = i * 2.39;
      const distance = (20 + (i % 4) * 7) * t;
      cube(death.x * TILE_PIXELS + Math.cos(angle) * distance, death.z * TILE_PIXELS + Math.sin(angle) * distance,
        Math.max(0, 10 + t * (21 + (i % 3) * 7) - 45 * t * t),
        2, i % 2 === 0 ? [playerColors[death.slot], playerColors[death.slot], "#402855"] :
          ["#ffe8b5", "#dfaa80", "#a57665"]);
    }
    ctx.globalAlpha = 1;
  }

  return function render(scene, now = 0) {
    const viewWidth = canvas.clientWidth || canvas.width;
    const viewHeight = canvas.clientHeight || canvas.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(viewWidth * ratio);
    const pixelHeight = Math.round(viewHeight * ratio);
    if (viewWidth !== lastViewWidth || viewHeight !== lastViewHeight || pixelRatio !== ratio || cachedTextureRevision !== textureRevision) {
      staticBitmaps.clear();
      lastViewWidth = viewWidth;
      lastViewHeight = viewHeight;
      pixelRatio = ratio;
      cachedTextureRevision = textureRevision;
    }
    if (arenaPadding === undefined || canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      // CSS owns the viewport dimensions and the space reserved for the HUD.
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const style = getComputedStyle(canvas);
      arenaPadding = {
        top: Number.parseFloat(style.getPropertyValue("--arena-padding-top")) || 0,
        bottom: Number.parseFloat(style.getPropertyValue("--arena-padding-bottom")) || 0,
        inline: Number.parseFloat(style.getPropertyValue("--arena-padding-inline")) || 0,
      };
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, viewWidth, viewHeight);
    if (hero) {
      scale = Math.min(viewWidth / (boardWidth + boardDepth * skew + 13), viewHeight / (boardDepth * pitch + 28));
      originX = (viewWidth - (centerX + centerZ * skew) * 2 * scale) / 2;
      originY = (viewHeight - centerZ * 2 * pitch * scale) / 2 + scale * 9;
    } else {
      const fieldHeight = Math.max(1, viewHeight - arenaPadding.top - arenaPadding.bottom);
      const fieldWidth = Math.max(1, viewWidth - 2 * arenaPadding.inline);
      scale = Math.min(fieldWidth / (maxX - minX + halfTile), fieldHeight / (fieldBottom - fieldTop));
      originX = viewWidth / 2;
      originY = arenaPadding.top + fieldHeight / 2 - fieldCenterY * scale;
    }
    // Cache the floor separately so players and moving objects retain their
    // existing depth order with the individually cached walls and crates.
    cachedBox("floor", centerX, centerZ, floorBottom, boardWidth, boardDepth, -floorBottom, drawFloor);
    const activePlayers = new Set(scene.players.map((player) => player.id ?? player.slot));
    for (const key of walks.keys()) if (!activePlayers.has(key)) walks.delete(key);

    const objects = [];
    const borderCarts = [];
    // The angled preview looks from the left, so objects in the same row
    // must also sort by their distance from that side of the board.
    const add = (entity, draw, offset = 0) => objects.push({
      depth: entity.z - entity.x * skew + offset, draw,
    });
    for (const wall of scene.walls ?? fixedWalls) add(wall, () => drawWall(wall));
    for (const crate of scene.crates) add(crate, () => drawCrate(crate, now));
    for (const crate of scene.crateDebris ?? []) addCrateDebris(crate, now, add);
    for (const item of scene.pickups) add(item, () => {
      const x = item.x * TILE_PIXELS;
      const z = item.z * TILE_PIXELS;
      shadow(x, z, 8, 8);
      sprite(`powerup_${item.kind}`, x, z, 10 + Math.sin(now / 170 + item.x) * 2, 10);
    }, -.1);
    for (const blast of scene.blasts) {
      if (blast.expiresAt > now) add(blast, () => drawBlast(blast, now), -.2);
    }
    const bombs = [...scene.bombs];
    const groundedBombs = hero ? [] : bombs.filter((bomb) => !(bomb.landAt > now));
    const playersByBomb = new Map();
    for (const bomb of bombs) {
      if (bomb.landAt > now) {
        const flight = (now - bomb.thrownAt) / (bomb.landAt - bomb.thrownAt);
        add({ x: bomb.x, z: Math.max(bomb.z, bomb.fromZ) + Math.sin(flight * Math.PI) }, () => drawBomb(bomb, now));
      } else {
        add(bomb, () => drawBomb(bomb, now, playersByBomb.get(bomb), scene.self));
      }
    }
    for (const tile of scene.falling) {
      if (now >= tile.landAt) {
        add(tile, () => drawWall(tile));
      } else if (now >= tile.fallAt) {
        const t = (now - tile.fallAt) / (tile.landAt - tile.fallAt);
        flat(tile.x * TILE_PIXELS, tile.z * TILE_PIXELS, TILE_PIXELS, TILE_PIXELS, 0, "#e0566096");
        add(tile, () => drawWall({ ...tile, y: fallingBlockHeight * (1 - t * t) }), (1 - t) * .85);
      }
    }
    for (const player of scene.players) {
      const self = scene.self !== undefined && scene.self === player.id;
      if (!player.alive) {
        borderCarts.push(player);
        continue;
      }
      let nearestBomb;
      let nearestDistance = 1;
      for (const bomb of groundedBombs) {
        const distance = (player.x - bomb.x) ** 2 + (player.z - bomb.z) ** 2;
        if (distance >= nearestDistance) continue;
        nearestBomb = bomb;
        nearestDistance = distance;
      }
      if (nearestBomb) {
        if (!playersByBomb.has(nearestBomb)) playersByBomb.set(nearestBomb, []);
        playersByBomb.get(nearestBomb).push(player);
      } else {
        add(player, () => avatar(player, now, self), hero ? 0 : .22);
      }
    }
    objects.sort((a, b) => a.depth - b.depth);
    for (const object of objects) object.draw();
    // Carts ride above the boundary walls, including where their screen shapes overlap.
    borderCarts.sort((a, b) => a.z - b.z);
    for (const player of borderCarts) avatar(player, now, scene.self !== undefined && scene.self === player.id);
    for (const death of scene.deaths) particles(death, now);
  };
}

export function makePreview(canvas) {
  let localSkin;
  // Each character occupies one tile and gives the object its tile center.
  const rows = [
    "########",
    "#.CC.CC#",
    "#C#.#.C#",
    "#C..TC2#",
    "#.CF..C#",
    "##..1C##",
  ];
  const render = makeRenderer(canvas, { width: rows[0].length, depth: rows.length, hero: true });
  const tiles = rows.flatMap((row, z) => [...row].map((kind, x) => ({ kind, x, z })));
  const findTiles = (kind) => tiles.filter((tile) => tile.kind === kind);
  const walls = findTiles("#");
  const crates = findTiles("C");
  const pickups = findTiles("F").map(({ x, z }) => ({ x, z, kind: "fire" }));
  const [bomb] = findTiles("T");
  const [firstPlayer] = findTiles("1");
  const [secondPlayer] = findTiles("2");
  const update = (now) => render({
    walls, crates, pickups,
    blasts: [], falling: [], deaths: [],
    bombs: [{ ...bomb, detonateAt: now + 2200 }],
    players: [
      { ...firstPlayer, slot: 0, alive: true, direction: 2, skin: localSkin },
      { ...secondPlayer, slot: 1, alive: true, direction: 2 },
    ],
  }, now);
  for (const image of Object.values(assets)) image.addEventListener("load", () => update(180), { once: true });
  new ResizeObserver(() => { if (canvas.clientWidth) update(180); }).observe(canvas);
  update(180);
  return (skin) => {
    localSkin = skin;
    if (canvas.clientWidth) update(180);
  };
}
