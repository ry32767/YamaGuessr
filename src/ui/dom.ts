/** 小さなDOMヘルパ。フレームワークは足さない（AGENTS.md）。 */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/** 要素を作る。`class` などの属性と子要素をまとめて渡せる。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 数値は等幅で出す（DESIGN.md の書体上の署名）。 */
export function num(text: string | number, extraClass = ''): HTMLSpanElement {
  return el('span', { class: `num ${extraClass}`.trim() }, String(text));
}

/** 距離の読みやすい表記。1km以上はkmに丸める。 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters / 1000)} km`;
}

export function formatPoints(points: number): string {
  return points.toLocaleString('ja-JP');
}

/** 読み込み中・空・エラーを同じ形で出すための箱。 */
export function stateBlock(
  title: string,
  detail?: string,
  action?: HTMLElement,
): HTMLElement {
  return el(
    'div',
    { class: 'state' },
    el('p', { class: 'state__title' }, title),
    detail ? el('p', {}, detail) : null,
    action ?? null,
  );
}

export function loadingBlock(title = '読み込んでいます'): HTMLElement {
  const block = el('div', { class: 'state' }, el('div', { class: 'spinner', role: 'presentation' }));
  append(block, el('p', { class: 'state__title' }, title));
  return block;
}

/** 画面右下に短い通知を出す。結果表示は消さずに横から知らせるためのもの。 */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const node = el(
    'div',
    { class: `toast${kind === 'error' ? ' toast--error' : ''}`, role: 'status' },
    message,
  );
  document.body.appendChild(node);
  window.setTimeout(() => node.remove(), 5000);
}
