/**
 * Pure category-choice rules for the money-entry pickers (MVP-SCOPE §2.4).
 *
 * Deliberately free of the DOM: the rule that an income code is never offered on
 * an expense form — and that an empty list is said out loud instead of shown as an
 * empty dropdown — is the part worth unit-testing in this repository's node test
 * environment.
 */

export interface CategoryItem {
  readonly code: string;
  readonly transactionKind: string;
  readonly messageKey: string;
  readonly defaultExpenseClass: string | null;
  readonly displayOrder: number;
}

export interface CategoryChoice {
  readonly value: string;
  readonly label: string;
}

export interface CategoryChoices {
  readonly options: readonly CategoryChoice[];
  readonly hint: string;
  /** False when the API returned nothing usable for this direction. */
  readonly usable: boolean;
}

/**
 * Pure part of the picker: which codes may be offered for a direction, and what
 * the field should say. Kept free of the DOM so the direction filter — the rule
 * that stops an income code being offered for an expense — is unit-testable.
 * Order is the API's `displayOrder, code`, never re-sorted here.
 */
export function categoryChoices(items: readonly CategoryItem[], kind: string): CategoryChoices {
  const options = items
    .filter((item) => item.transactionKind === kind)
    .map((item) => ({
      value: item.code,
      label: item.defaultExpenseClass === null ? item.code : `${item.code} · ${item.defaultExpenseClass}`,
    }));
  if (options.length === 0) {
    return {
      options,
      usable: false,
      hint: `The API returned no ${kind} category, so this form cannot be completed honestly right now.`,
    };
  }
  return {
    options,
    usable: true,
    hint: `${options.length} ${kind} ${options.length === 1 ? 'category' : 'categories'} from GET /api/v1/categories.`,
  };
}
