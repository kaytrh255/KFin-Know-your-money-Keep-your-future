/**
 * Minimal DOM helpers. Every value the user sees comes from an API response or
 * from what the user typed: nothing is defaulted to a plausible-looking number.
 */

type Child = Node | string | null | undefined;

export interface ElementOptions {
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly type?: string;
  readonly name?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly href?: string;
  readonly id?: string;
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
  readonly rows?: number;
  readonly hidden?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly ariaLabel?: string;
  readonly on?: Partial<Record<'click' | 'submit' | 'change' | 'input', (event: Event) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  if (options.id) node.id = options.id;
  if (options.hidden) node.hidden = true;
  if (options.disabled) node.setAttribute('disabled', '');
  if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
  const attributes: Array<[string, string | undefined]> = [
    ['type', options.type],
    ['name', options.name],
    ['value', options.value],
    ['placeholder', options.placeholder],
    ['href', options.href],
    ['min', options.min],
    ['max', options.max],
    ['step', options.step],
  ];
  for (const [name, value] of attributes) {
    if (value !== undefined) node.setAttribute(name, value);
  }
  if (options.required) node.setAttribute('required', '');
  if (options.rows !== undefined && node instanceof HTMLTextAreaElement) node.rows = options.rows;
  if (options.checked && node instanceof HTMLInputElement) node.checked = true;
  if (options.selected && node instanceof HTMLOptionElement) node.selected = true;
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    if (handler) node.addEventListener(event, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export interface FieldOptions extends ElementOptions {
  readonly label: string;
  readonly hint?: string;
}

/** Labelled input with the label wired to the control for screen readers. */
export function field(options: FieldOptions): HTMLElement {
  const id = options.id ?? `field-${Math.random().toString(36).slice(2, 10)}`;
  const control = el('input', { ...options, id });
  control.classList.add('input');
  return labelledControl(options.label, control, options.hint);
}

/** Labelled `<select>`; options are literal allow-lists from the contract schemas. */
export function selectField(
  labelText: string,
  values: readonly string[],
  options: { readonly value?: string; readonly includeEmpty?: boolean; readonly hint?: string; readonly name?: string } = {},
): HTMLElement {
  const id = `select-${Math.random().toString(36).slice(2, 10)}`;
  const select = el('select', { class: 'input', id });
  if (options.includeEmpty) select.append(el('option', { value: '', text: '— none —' }));
  for (const value of values) {
    select.append(el('option', { value, text: value, ...(options.value === value ? { selected: true } : {}) }));
  }
  if (options.name) select.name = options.name;
  return el('div', { class: 'field' },
    (() => { const label = el('label', { class: 'label', text: labelText }); label.setAttribute('for', id); return label; })(),
    select,
    options.hint ? el('p', { class: 'hint', text: options.hint }) : null,
  );
}

export function labelledControl(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `control-${Math.random().toString(36).slice(2, 10)}`;
  control.id = id;
  const label = el('label', { class: 'label', text: labelText });
  label.setAttribute('for', id);
  return el('div', { class: 'field' }, label, control, hint ? el('p', { class: 'hint', text: hint }) : null);
}

export function card(title: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card' }, el('h2', { class: 'card-title', text: title }), ...children);
}

export function notice(kind: 'error' | 'ok' | 'info', text: string, correlationId?: string | null): HTMLElement {
  return el('div', { class: `notice notice-${kind}` },
    el('p', { text }),
    correlationId ? el('p', { class: 'hint', text: `correlation id: ${correlationId}` }) : null,
  );
}

/** Exact wire payloads, so a tester can see what was sent and what came back. */
export function wire(label: string, payload: unknown): HTMLElement {
  return el('details', { class: 'wire' },
    el('summary', { text: label }),
    el('pre', { text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }),
  );
}

let toastTimer: number | undefined;

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast toast-${kind}`;
  node.hidden = false;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.hidden = true; }, 6_000);
}

export function readInput(root: ParentNode, name: string): string {
  const node = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`);
  return node?.value.trim() ?? '';
}

export function readCheckbox(root: ParentNode, name: string): boolean {
  return root.querySelector<HTMLInputElement>(`[name="${name}"]`)?.checked ?? false;
}
