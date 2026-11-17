import { partVertices, PLAYER_FACES, PLAYER_PARTS } from "./player-model.js";

// Look from the same side as the home board.
export const PREVIEW_YAW = -Math.PI / 6;
export const PREVIEW_PITCH = Math.PI / 10;
const parts = PLAYER_PARTS.map(({ name, pivot, corner, size }) => ({
  name,
  vertices: partVertices(corner, size).map(([x, y, z]) => [x + pivot[0], y + pivot[1], z + pivot[2]]),
}));
const modelHeight = Math.max(...parts.flatMap(({ vertices }) => vertices.map(([, y]) => y)));
const shade = { left: .24, front: .07, right: .16, back: .20, top: 0, bottom: .34 };

export function drawPlayerPreview(ctx, skin, {
  originX, originY, scale, yaw = PREVIEW_YAW, pitch = PREVIEW_PITCH, centered = false,
}) {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const centerY = centered ? modelHeight / 2 : 0;
  const faces = [];

  for (const { name, vertices } of parts) {
    const points = vertices.map(([x, y, z]) => {
      const forward = x * sinYaw + z * cosYaw;
      const height = y - centerY;
      return [
        (x * cosYaw - z * sinYaw) * scale + originX,
        (forward * sinPitch - height * cosPitch) * scale + originY,
        forward * cosPitch + height * sinPitch,
      ];
    });
    for (const [face, indices] of Object.entries(PLAYER_FACES)) {
      const [a, b, c, d] = indices.map((index) => points[index]);
      const horizontal = [b[0] - a[0], b[1] - a[1]];
      const vertical = [d[0] - a[0], d[1] - a[1]];
      const area = horizontal[0] * vertical[1] - horizontal[1] * vertical[0];
      if (area <= .001) continue;
      faces.push({ a, horizontal, vertical, depth: (a[2] + b[2] + c[2] + d[2]) / 4,
        bitmap: skin[name][face], shade: shade[face] });
    }
  }

  faces.sort((a, b) => a.depth - b.depth);
  for (const { a, horizontal, vertical, bitmap, shade } of faces) {
    ctx.save();
    ctx.transform(...horizontal, ...vertical, a[0], a[1]);
    ctx.fillStyle = "#344362";
    ctx.fillRect(0, 0, 1, 1);
    ctx.drawImage(bitmap, 0, 0, 1, 1);
    if (shade) {
      ctx.fillStyle = `rgba(24, 16, 49, ${shade})`;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.restore();
  }
}
