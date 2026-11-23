// Show presses on pointer-down instead of waiting for touch :active/click.
export function wireButtonFeedback(root = document, view = window) {
  const pointers = new Map();
  const refresh = (button) => button.classList.toggle("is-pressed",
    [...pointers.values()].some((press) => press.button === button && press.inside));
  const release = (event) => {
    const press = pointers.get(event.pointerId);
    if (!press) return;
    pointers.delete(event.pointerId);
    refresh(press.button);
  };
  const reset = () => {
    const buttons = new Set([...pointers.values()].map(({ button }) => button));
    pointers.clear();
    for (const button of buttons) refresh(button);
  };
  root.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("button");
    if (event.button !== 0 || !button || button.matches(":disabled")) return;
    pointers.set(event.pointerId, { button, inside: true });
    refresh(button);
  }, true);
  root.addEventListener("pointermove", (event) => {
    const press = pointers.get(event.pointerId);
    if (!press) return;
    const rect = press.button.getBoundingClientRect();
    press.inside = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    refresh(press.button);
  }, true);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    root.addEventListener(name, release, true);
  }
  view.addEventListener("blur", reset);
  root.addEventListener("visibilitychange", reset);
}
