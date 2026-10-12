// Resizable sidebar. Dragging the right-edge handle sets `--sidebar-w` (which the shell grid
// reads), clamped between a sensible minimum and 30% of the viewport width. Arrow keys nudge it
// for keyboard users.
const MIN = 240;
const maxWidth = () => Math.round(window.innerWidth * 0.30);

export function initSidebar() {
  const handle = document.getElementById("sidebar-resizer");
  if (!handle) return;

  const setWidth = (px) => {
    const w = Math.max(MIN, Math.min(maxWidth(), Math.round(px)));
    document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
  };
  const currentWidth = () =>
    document.querySelector(".sidebar")?.getBoundingClientRect().width ?? MIN;

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");

    const move = (e) => setWidth(e.clientX);
    const up = () => {
      document.body.classList.remove("is-resizing");
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });

  handle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(currentWidth() - 16); }
    else if (event.key === "ArrowRight") { event.preventDefault(); setWidth(currentWidth() + 16); }
  });

  // Keep within 30% if the window shrinks.
  window.addEventListener("resize", () => setWidth(currentWidth()));
}
