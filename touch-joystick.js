// Direction numbers match the shared grid movement rules.
const sectors = [[0], [0, 2], [2], [2, 1], [1], [1, 3], [3], [3, 0]];
const deadZone = 0.22;

export function joystickDirections(x, y) {
  if (Math.hypot(x, y) < deadZone) return [];
  const sector = (Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8;
  return sectors[sector];
}

export function wireJoystick(element, active, onChange, touchArea = element) {
  let pointerId;
  let origin;
  let held = "";

  function change(directions) {
    const signature = directions.join(",");
    if (signature === held) return;
    held = signature;
    onChange(directions);
  }

  function reset() {
    const previous = pointerId;
    pointerId = undefined;
    origin = undefined;
    element.style.setProperty("--stick-origin-x", "0px");
    element.style.setProperty("--stick-origin-y", "0px");
    element.style.setProperty("--stick-x", "0px");
    element.style.setProperty("--stick-y", "0px");
    element.classList.remove("held");
    change([]);
    if (previous !== undefined && element.hasPointerCapture(previous)) element.releasePointerCapture(previous);
  }

  function move(event) {
    if (event.pointerId !== pointerId) return;
    if (!active()) {
      reset();
      return;
    }
    const { x: centerX, y: centerY, radius } = origin;
    const x = (event.clientX - centerX) / radius;
    const y = (event.clientY - centerY) / radius;
    const length = Math.max(1, Math.hypot(x, y));
    const travel = radius * 0.55;
    element.style.setProperty("--stick-x", `${x / length * travel}px`);
    element.style.setProperty("--stick-y", `${y / length * travel}px`);
    change(joystickDirections(x, y));
  }

  function start(event) {
    if (!active() || pointerId !== undefined || event.button !== 0) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    origin = { x: event.clientX, y: event.clientY, radius: Math.min(rect.width, rect.height) / 2 };
    element.style.setProperty("--stick-origin-x", `${origin.x - rect.left - rect.width / 2}px`);
    element.style.setProperty("--stick-origin-y", `${origin.y - rect.top - rect.height / 2}px`);
    pointerId = event.pointerId;
    element.setPointerCapture(pointerId);
    element.classList.add("held");
    move(event);
  }
  element.addEventListener("pointerdown", start);
  if (touchArea !== element) touchArea.addEventListener("pointerdown", start);
  element.addEventListener("pointermove", move);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    element.addEventListener(name, (event) => { if (event.pointerId === pointerId) reset(); });
  }
  return reset;
}
