/**
 * Makes a horizontal divider drag-resize the pane directly above it inside a
 * flex-column container. The pane above becomes a fixed height while dragging;
 * the pane below keeps flex-growing to fill the rest.
 */
export function makeVerticalResizer(
  handle: HTMLElement,
  topPane: HTMLElement,
  container: HTMLElement,
): void {
  const MIN_TOP = 80; // px — never collapse the top pane past this
  const MIN_BOTTOM = 120; // px — keep at least this for the pane below

  let startY = 0;
  let startHeight = 0;

  const onMove = (event: PointerEvent): void => {
    const delta = event.clientY - startY;
    const max = container.clientHeight - MIN_BOTTOM;
    const height = Math.max(MIN_TOP, Math.min(max, startHeight + delta));
    topPane.style.flex = `0 0 ${height}px`;
    topPane.style.maxHeight = "none"; // an explicit drag overrides any CSS cap
  };

  const onUp = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startY = event.clientY;
    startHeight = topPane.getBoundingClientRect().height;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/**
 * Lets a panel pop out into a floating window: a toggle button detaches it
 * (position: fixed, native resize grip), its header drags it around, and the
 * button docks it back. `resizerBelow` is hidden while floating.
 */
export function makeDetachable(
  panel: HTMLElement,
  handle: HTMLElement,
  toggleBtn: HTMLElement,
  resizerBelow: HTMLElement,
): void {
  let floating = false;
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const setFloating = (on: boolean): void => {
    floating = on;
    panel.classList.toggle("floating", on);
    toggleBtn.textContent = on ? "⤡" : "⤢";
    toggleBtn.title = on ? "Вернуть на место" : "Вынести в отдельное окно";
    resizerBelow.style.display = on ? "none" : "";
    if (!on) {
      panel.style.left = panel.style.top = "";
      panel.style.width = panel.style.height = "";
    }
  };

  toggleBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setFloating(!floating);
  });

  handle.addEventListener("pointerdown", (event) => {
    if (!floating || event.target === toggleBtn) return;
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    panel.style.left = `${startLeft + dx}px`;
    panel.style.top = `${startTop + dy}px`;
  });
  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(event.pointerId);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  // A drag on the header must not also toggle the <details> collapse.
  handle.addEventListener("click", (event) => {
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    }
  });
}
