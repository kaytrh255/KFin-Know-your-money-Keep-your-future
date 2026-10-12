/**
 * ACT-01/ACT-02/ADD-01/ADD-02 and the append-only correction path, limited to the
 * endpoints that exist: list, read, create (with the pre-snapshot historical
 * switch), void-preview → void, and correction history. The correction *commit*
 * requires a reviewed correction chain that this client deliberately does not
 * fabricate, so the UI states that plainly and shows the history instead.
 */

import type { Api, ApiFailure } from '../api.js';
import { newIdempotencyKey } from '../api.js';
import { card, el, field, notice, readCheckbox, readInput, selectField, toast, wire } from '../dom.js';
import { formatMinor, localDateToday, localYearMonth } from '../money.js';

export interface ActivityViewContext {
  readonly api: Api;
  readonly currency: string;
  /** The snapshot's own local date: the API classifies a write relative to it. */
  readonly snapshotLocalDate: string;
}

const KINDS = ['expense', 'income'];
const EXPENSE_CLASSES = ['essential_fixed', 'essential_variable', 'daily'];
const BALANCE_EFFECTS = ['current', 'historical'];

function failureNotice(error: unknown): HTMLElement {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const failure = error as ApiFailure;
    return notice('error', `${failure.status} ${failure.code}: ${failure.message}`, failure.correlationId, failure.fields);
  }
  return notice('error', error instanceof Error ? error.message : 'The request failed.');
}

interface FinancialContext {
  readonly financialStateVersion: string;
  readonly snapshotId: string;
  readonly currency: string;
}

/**
 * `classifyTransaction` in `packages/domain/src/financial.ts` decides the balance
 * effect from the occurrence date versus the snapshot date, and a same-day record
 * must state its own snapshot inclusion explicitly. The mapping is deliberately
 * three-valued so the client never silently picks a balance effect for the user.
 */
const SNAPSHOT_INCLUSION = ['unspecified', 'no', 'yes'];

function snapshotInclusionField(): HTMLElement {
  return selectField(
    'Snapshot inclusion',
    SNAPSHOT_INCLUSION,
    {
      value: 'unspecified',
      name: 'alreadyIncludedInSnapshot',
      hint: 'unspecified omits the field, "no" means the record is not in the opening snapshot (current impact), "yes" means it already is (historical only). A same-day record must not be left unspecified.',
    },
  );
}

function readSnapshotInclusion(root: ParentNode): Record<string, boolean> {
  const choice = readInput(root, 'alreadyIncludedInSnapshot');
  if (choice === 'yes') return { alreadyIncludedInSnapshot: true };
  if (choice === 'no') return { alreadyIncludedInSnapshot: false };
  return {};
}

export function activityView(context: ActivityViewContext, account: FinancialContext): HTMLElement {
  const host = el('div', { class: 'stack' });
  const monthInput = field({ label: 'Month', name: 'month', value: localYearMonth(), placeholder: 'YYYY-MM' });
  const kindFilter = selectField('Kind filter', KINDS, { includeEmpty: true, name: 'kindFilter' });
  const effectFilter = selectField('Balance effect filter', BALANCE_EFFECTS, { includeEmpty: true, name: 'effectFilter' });
  const listOutput = el('div', { class: 'result' });

  function query(): string {
    const month = readInput(monthInput, 'month');
    const kind = readInput(kindFilter, 'kindFilter');
    const effect = readInput(effectFilter, 'effectFilter');
    const params = new URLSearchParams({ limit: '50' });
    if (month.length > 0) params.set('month', month);
    if (kind.length > 0) params.set('kind', kind);
    if (effect.length > 0) params.set('balanceEffect', effect);
    return `?${params.toString()}`;
  }

  async function load(): Promise<void> {
    listOutput.replaceChildren(el('p', { class: 'hint', text: 'Loading transactions…' }));
    try {
      const response = await context.api.financial.transactions(query());
      listOutput.replaceChildren(
        response.data.items.length === 0
          ? notice('info', 'No transactions match this query. An empty list is a real answer from the API, not a placeholder.')
          : el('ul', { class: 'list' }, ...response.data.items.map((item) => transactionRow(item))),
        wire('GET /api/v1/transactions', response.data),
      );
    } catch (error) {
      listOutput.replaceChildren(failureNotice(error));
    }
  }

  function transactionRow(item: Record<string, unknown>): HTMLElement {
    const id = String(item.id);
    const amount = typeof item.amountMinor === 'string' ? item.amountMinor : '0';
    const rowOutput = el('div', { class: 'result' });
    return el('li', { class: 'row' },
      el('div', { class: 'row-main' },
        el('span', { class: 'amount', text: formatMinor(amount, context.currency) }),
        el('span', { class: 'badge', text: `${String(item.kind)} · ${String(item.balanceEffect)}` }),
        el('span', { class: 'hint', text: `${String(item.occurredOn)} · ${String(item.categoryCode)}${item.voidedAt ? ' · voided' : ''}` }),
      ),
      el('div', { class: 'actions' },
        el('button', {
          class: 'button secondary', type: 'button', text: 'Detail',
          on: {
            click: () => {
              void context.api.financial.transaction(id)
                .then((r) => rowOutput.replaceChildren(wire('GET /api/v1/transactions/:id', r.data)))
                .catch((e: unknown) => rowOutput.replaceChildren(failureNotice(e)));
            },
          },
        }),
        el('button', {
          class: 'button secondary', type: 'button', text: 'History',
          on: {
            click: () => {
              void context.api.financial.correctionHistory(id)
                .then((r) => rowOutput.replaceChildren(wire('correction history', r.data)))
                .catch((e: unknown) => rowOutput.replaceChildren(failureNotice(e)));
            },
          },
        }),
        el('button', {
          class: 'button secondary', type: 'button', text: 'Void…',
          on: { click: () => { void startVoid(id, rowOutput); } },
        }),
      ),
      rowOutput,
    );
  }

  /**
   * Void is a two-step flow because the commit is governed by the *reviewed*
   * context the preview returns: `voidCommitBodySchema` requires
   * `{ reason, context }`, and the context carries `reviewedPreviewDigest`, the
   * reviewed source version/snapshot, and the reviewed user version. The client
   * therefore cannot commit anything it has not first previewed, and it echoes the
   * API's own context back verbatim instead of reconstructing it.
   */
  async function startVoid(transactionId: string, target: HTMLElement): Promise<void> {
    const reasonInput = field({ label: 'Reason for voiding', name: 'reason', required: true });
    const key = { value: newIdempotencyKey() };
    const previewOutput = el('div', { class: 'result' });
    const commitButton = el('button', { class: 'button', type: 'button', text: 'Commit void with this preview', disabled: true });
    let reviewedContext: Record<string, unknown> | null = null;
    const form = el('form', { class: 'stack' }, reasonInput,
      el('div', { class: 'actions' },
        el('button', { class: 'button secondary', type: 'submit', text: 'Preview impact' }),
        el('button', { class: 'button secondary', type: 'button', text: 'Cancel', on: { click: () => target.replaceChildren() } }),
      ));

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const body = { reason: readInput(reasonInput, 'reason') };
      previewOutput.replaceChildren(wire('POST void-preview request', body));
      void context.api.financial.voidPreview(transactionId, body)
        .then((response) => {
          reviewedContext = (response.data.context as Record<string, unknown> | undefined) ?? null;
          const digest = typeof reviewedContext?.reviewedPreviewDigest === 'string' ? reviewedContext.reviewedPreviewDigest : null;
          previewOutput.replaceChildren(
            notice('info', 'Preview only. Nothing has been withdrawn yet. The commit must echo the context below, including the preview digest.'),
            ...(digest ? [el('p', { class: 'hint', text: `reviewedPreviewDigest: ${digest}` })] : []),
            wire('POST /api/v1/transactions/:id/void-preview', response.data),
          );
          if (reviewedContext) commitButton.removeAttribute('disabled');
        })
        .catch((error: unknown) => {
          reviewedContext = null;
          commitButton.setAttribute('disabled', '');
          previewOutput.replaceChildren(failureNotice(error));
        });
    });

    commitButton.addEventListener('click', () => {
      if (!reviewedContext) return;
      const body = { reason: readInput(reasonInput, 'reason'), context: reviewedContext };
      void context.api.financial.voidCommit(transactionId, body, key.value)
        .then(async (response) => {
          previewOutput.replaceChildren(notice('ok', 'Void committed.'), wire('POST /api/v1/transactions/:id/void', response.data));
          toast('Void committed');
          await load();
        })
        .catch((error: unknown) => { previewOutput.replaceChildren(failureNotice(error)); });
    });

    target.replaceChildren(card(`Void transaction ${transactionId}`, form, el('div', { class: 'actions' }, commitButton), previewOutput));
  }

  const addForm = el('form', { class: 'stack' },
    field({ label: 'Amount (minor units)', name: 'amountMinor', required: true, hint: `${context.currency}. Signed-minor rules: positive minor string here; direction comes from the kind.` }),
    selectField('Kind', KINDS, { value: 'expense', name: 'kind' }),
    field({ label: 'Occurred on', name: 'occurredOn', required: true, value: localDateToday() }),
    field({
      label: 'Category code',
      name: 'categoryCode',
      required: true,
      placeholder: 'food',
      hint: 'Lower-case, 2–63 characters, starts with a letter. Codes are rows in the seeded `categories` table and no endpoint lists them yet, so see docs/development/LOCAL-DEVELOPMENT.md §7 for the seeded values.',
    }),
    selectField('Expense class', EXPENSE_CLASSES, { includeEmpty: true, name: 'expenseClass', hint: 'Required for expenses by the domain rules; leave empty for income.' }),
    labelledCheckbox('isUnexpected', 'Unexpected (needed for the "needs attention" signal)'),
    snapshotInclusionField(),
    field({ label: 'Note (optional)', name: 'note' }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Record transaction' })),
  );
  const addOutput = el('div', { class: 'result' });
  const addKey = { value: newIdempotencyKey() };
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const expenseClass = readInput(addForm, 'expenseClass');
    const note = readInput(addForm, 'note');
    const body = {
      kind: readInput(addForm, 'kind'),
      amountMinor: readInput(addForm, 'amountMinor'),
      occurredOn: readInput(addForm, 'occurredOn'),
      categoryCode: readInput(addForm, 'categoryCode'),
      ...(expenseClass.length === 0 ? {} : { expenseClass }),
      isUnexpected: readCheckbox(addForm, 'isUnexpected'),
      ...readSnapshotInclusion(addForm),
      ...(note.length === 0 ? {} : { note }),
      expectedFinancialStateVersion: account.financialStateVersion,
      reviewedLatestSnapshotId: account.snapshotId,
    };
    addOutput.replaceChildren(wire('request (version/snapshot read from the API just now)', { ...body, idempotencyKey: addKey.value }));
    void context.api.financial.createTransaction(body, addKey.value)
      .then(async (response) => {
        addOutput.replaceChildren(notice('ok', 'Transaction recorded.'), wire('response', response.data));
        toast('Transaction recorded');
        addKey.value = newIdempotencyKey();
        await load();
      })
      .catch((error: unknown) => { addOutput.replaceChildren(failureNotice(error)); });
  });

  const monthlyForm = el('form', { class: 'stack' },
    field({ label: 'Month for the report', name: 'month', required: true, value: localYearMonth() }),
    el('div', { class: 'actions' }, el('button', { class: 'button secondary', type: 'submit', text: 'Load monthly actuals' })),
  );
  const monthlyOutput = el('div', { class: 'result' });
  monthlyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const month = readInput(monthlyForm, 'month');
    void context.api.financial.monthlyActuals(month)
      .then((response) => { monthlyOutput.replaceChildren(wire('GET /api/v1/reports/monthly-actuals', response.data)); })
      .catch((error: unknown) => { monthlyOutput.replaceChildren(failureNotice(error)); });
  });

  const filters = el('form', { class: 'stack' }, monthInput, kindFilter, effectFilter,
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Apply filters' })));
  filters.addEventListener('submit', (event) => { event.preventDefault(); void load(); });

  void load();

  return el('div', { class: 'stack' },
    card('Activity (ACT-01)', filters, el('div', { class: 'actions' }, el('button', { class: 'button secondary', type: 'button', text: 'Reload', on: { click: () => { void load(); } } })), listOutput),
    card('Record a transaction (ADD-01 / ADD-02)',
      el('p', { class: 'hint', text: `The opening snapshot's local date is ${context.snapshotLocalDate}. An occurrence before it must be recorded as already included (historical only), one after it must not be, and a same-day occurrence has to state which it is — the API refuses to guess.` }),
      addForm, addOutput),
    card('Monthly actuals', monthlyForm, monthlyOutput),
  );
}

function labelledCheckbox(name: string, label: string): HTMLElement {
  const input = el('input', { type: 'checkbox', name });
  const wrapper = el('label', { class: 'checkbox' }, input, el('span', { text: label }));
  return wrapper;
}
