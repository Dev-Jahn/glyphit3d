// Minimal element builder — the whole UI is plain DOM (no framework, M2-SPEC §3).
type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') node.addEventListener(k, v as (e: Event) => void);
    else if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k in node && k !== 'list') (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

// A labelled panel: an eyebrow + a body region. Panels are the instrument-rack unit.
export function panel(eyebrow: string, body: (Node | string)[]): HTMLElement {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'eyebrow', text: eyebrow }),
    el('div', { class: 'panel-body' }, body),
  ]);
}

// Download a Blob under a filename via a transient anchor.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
