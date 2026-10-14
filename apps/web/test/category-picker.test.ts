import { describe, expect, it } from 'vitest';

import { categoryChoices, type CategoryItem } from '../src/views/category-choices.js';

/**
 * The direction filter is the correctness rule worth pinning: offering an income
 * code on an expense form produces a request the API rejects per field, and the
 * whole point of the picker is that a person never has to know the codes.
 */
const items: CategoryItem[] = [
  { code: 'electricity', transactionKind: 'expense', messageKey: 'category.electricity', defaultExpenseClass: 'essential_variable', displayOrder: 20 },
  { code: 'rent', transactionKind: 'expense', messageKey: 'category.rent', defaultExpenseClass: 'essential_fixed', displayOrder: 10 },
  { code: 'income_other', transactionKind: 'income', messageKey: 'category.incomeOther', defaultExpenseClass: null, displayOrder: 90 },
];

describe('categoryChoices', () => {
  it('offers only the codes the API accepts for the chosen direction', () => {
    expect(categoryChoices(items, 'expense').options.map((option) => option.value)).toEqual(['electricity', 'rent']);
    expect(categoryChoices(items, 'income').options.map((option) => option.value)).toEqual(['income_other']);
  });

  it('keeps the API ordering instead of re-sorting it', () => {
    const reversed = [...items].reverse();
    expect(categoryChoices(reversed, 'expense').options.map((option) => option.value)).toEqual(['rent', 'electricity']);
  });

  it('shows the default expense class as an aid and omits it when there is none', () => {
    expect(categoryChoices(items, 'expense').options.map((option) => option.label))
      .toEqual(['electricity · essential_variable', 'rent · essential_fixed']);
    expect(categoryChoices(items, 'income').options.map((option) => option.label)).toEqual(['income_other']);
  });

  it('states the count for the direction rather than the whole list', () => {
    expect(categoryChoices(items, 'expense').hint).toBe('2 expense categories from GET /api/v1/categories.');
    expect(categoryChoices(items, 'income').hint).toBe('1 income category from GET /api/v1/categories.');
  });

  it('reports an unusable direction instead of silently offering nothing', () => {
    const empty = categoryChoices(items, 'transfer');
    expect(empty.usable).toBe(false);
    expect(empty.options).toEqual([]);
    expect(empty.hint).toContain('no transfer category');
  });

  it('is honest when the API returned no categories at all', () => {
    const none = categoryChoices([], 'expense');
    expect(none.usable).toBe(false);
    expect(none.hint).toContain('no expense category');
  });
});
