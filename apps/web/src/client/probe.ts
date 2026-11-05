export function f(): HTMLElement {
  const d = document.createElement("div");
  d.textContent = String(Bun.version);
  return d;
}
