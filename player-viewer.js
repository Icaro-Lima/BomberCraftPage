import { partVertices, PLAYER_FACES, PLAYER_PARTS } from "./player-model.js";

const defaultYaw = Math.PI / 6;
const defaultPitch = Math.PI / 10;
const pitchLimit = Math.PI / 2;
const modelHeight = Math.max(...PLAYER_PARTS.map(({ pivot, corner, size }) => pivot[1] + corner[1] + size[1]));
const parts = PLAYER_PARTS.map(({ name, pivot, corner, size }) => ({
  name,
  vertices: partVertices(corner, size).map(([x, y, z]) => [
    x + pivot[0], y + pivot[1] - modelHeight / 2, z + pivot[2],
  ]),
}));
const shade = { left: .24, front: .07, right: .16, back: .20, top: 0, bottom: .34 };
const keyRotation = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
};

export function wirePlayerViewer(dialog) {
  const canvas = dialog.querySelector(".player-viewer");
  const zoom = dialog.querySelector("[data-viewer-zoom]");
  const reset = dialog.querySelector("[data-viewer-reset]");
  const ctx = canvas.getContext("2d");
  let skin;
  let yaw = defaultYaw;
  let pitch = defaultPitch;
  let drag;

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height || !skin) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const bitmapWidth = Math.round(width * ratio);
    const bitmapHeight = Math.round(height * ratio);
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);

    const scale = Math.min(width / 27, height / 42) * Number(zoom.value) / 100;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const faces = [];

    for (const { name, vertices } of parts) {
      const points = vertices.map(([x, y, z]) => {
        const forward = x * sinYaw + z * cosYaw;
        return [
          (x * cosYaw - z * sinYaw) * scale + width / 2,
          (forward * sinPitch - y * cosPitch) * scale + height / 2,
          forward * cosPitch + y * sinPitch,
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

  function rotate(horizontal, vertical) {
    yaw = (yaw - horizontal) % (2 * Math.PI);
    pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch + vertical));
    draw();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== drag?.id) return;
    rotate((event.clientX - drag.x) * .012, (event.clientY - drag.y) * .012);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  canvas.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId === drag?.id) drag = undefined;
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (event.deltaY < 0) zoom.stepUp();
    if (event.deltaY > 0) zoom.stepDown();
    draw();
  }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    const direction = keyRotation[event.key];
    if (!direction) return;
    event.preventDefault();
    rotate(direction[0] * Math.PI / 12, direction[1] * Math.PI / 12);
  });
  zoom.addEventListener("input", draw);
  reset.addEventListener("click", () => {
    yaw = defaultYaw;
    pitch = defaultPitch;
    zoom.value = zoom.defaultValue;
    draw();
  });
  new ResizeObserver(draw).observe(canvas);

  return (faces) => {
    skin = faces;
    draw();
  };
}
