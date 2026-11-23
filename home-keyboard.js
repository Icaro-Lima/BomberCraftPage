// Size the editing layout to the visible viewport, including browsers whose
// layout viewport does not shrink when the software keyboard opens.
export function wireHomeKeyboard() {
  const home = document.getElementById("home");
  const viewport = window.visualViewport;
  let editing = false;

  function update() {
    const height = Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
    const focused = document.activeElement?.matches("#nickname, #code");
    editing = !home.hidden && (focused || (editing && height < 300));
    const compact = editing && height < 300;
    document.body.classList.toggle("home-editing", compact);
    if (compact) {
      document.body.style.setProperty("--home-viewport-height", `${height}px`);
      document.body.style.setProperty("--home-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    } else {
      document.body.style.removeProperty("--home-viewport-height");
      document.body.style.removeProperty("--home-viewport-top");
    }
  }

  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => queueMicrotask(update));
  window.addEventListener("resize", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  new MutationObserver(update).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  update();
}
