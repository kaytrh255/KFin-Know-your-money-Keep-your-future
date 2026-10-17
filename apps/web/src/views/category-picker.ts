/**
 * Category picker for money-entry forms (MVP-SCOPE §2.4 "default categories").
 *
 * Before this existed the client asked a person to type a `categoryCode` from
 * memory — the field's own hint pointed at a developer runbook, which is not a
 * usable product surface. `GET /api/v1/categories` is the list the API will
 * accept, so the forms can offer it.
 *
 * Three properties matter and are deliberate:
 *  1. the choice is filtered by direction, because income and expense codes are
 *     not interchangeable and an invalid pair is rejected per field by the API;
 *  2. while the list is in flight the form stays usable, and if the list cannot
 *     be fetched at all the field falls back to the typed code the API has always
 *     accepted and says why — it never invents a list it did not receive;
 *  3. the HTTP request is issued once per view, not once per keystroke.
 */

import { el, field } from '../dom.js';
import { categoryChoices, type CategoryItem } from './category-choices.js';

export interface CategoryPickerOptions {
  /** Issues `GET /api/v1/categories`; injected so the picker stays testable. */
  readonly listCategories: () => Promise<{ items: CategoryItem[] }>;
  /** Current direction (`expense` / `income`) read at render time. */
  readonly kind: () => string;
  readonly label?: string;
  readonly fallbackPlaceholder: string;
}

export interface CategoryPicker {
  readonly node: HTMLElement;
  /** Re-renders from the last fetched list; call when the direction changes. */
  refresh: () => void;
  /** Fetches once and renders, or degrades to the typed-code field and says so. */
  load: () => Promise<void>;
}

export function categoryPicker(options: CategoryPickerOptions): CategoryPicker {
  const select = el('select', { class: 'input', name: 'categoryCode' });
  const hint = el('p', {
    class: 'hint',
    text: 'Loading the category list… you can type the code by hand meanwhile.',
  });
  const fallback = field({
    label: options.label ?? 'Category code',
    name: 'categoryCode',
    required: true,
    placeholder: options.fallbackPlaceholder,
    hint: 'Lower-case, 2–63 characters, starts with a letter. The list could not be fetched, so this field accepts a typed code.',
  });
  const node = el('div', { class: 'field' },
    el('label', { class: 'label', text: options.label ?? 'Category' }),
    select,
    hint,
  );
  let items: CategoryItem[] = [];

  function refresh(): void {
    const previous = select.value;
    const choices = categoryChoices(items, options.kind());
    select.replaceChildren(...choices.options.map((choice) => el('option', {
      value: choice.value,
      text: choice.label,
      selected: choice.value === previous,
    })));
    hint.textContent = choices.hint;
  }

  async function load(): Promise<void> {
    try {
      const response = await options.listCategories();
      items = response.items;
      refresh();
    } catch {
      // Honest degradation: the form falls back to the typed code it always took,
      // and the field hint says why. No list is invented.
      node.replaceChildren(fallback);
    }
  }

  return { node, refresh, load };
}

