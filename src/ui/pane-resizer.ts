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
