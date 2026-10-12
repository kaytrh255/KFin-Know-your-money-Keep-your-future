/**
 * SCH-01/SCH-02 and the M03 one-off schedule, using only existing endpoints:
 * list occurrences, create a one-off, confirm into a real transaction (with the
 * optimistic-concurrency values the API demands), and skip. The UI wording keeps
 * the persisted state honest — the API stores `confirmed`, not `paid`/`received`.
 */

import type { Api, ApiFailure } from '../api.js';
import { newIdempotencyKey } from '../api.js';
import { card, el, field, notice, readInput, selectField, toast, wire } from '../dom.js';
import { formatMinor, localDateToday } from '../money.js';

export interface ScheduleViewContext {
  readonly api: Api;
  readonly currency: string;
  readonly financialStateVersion: string;
  readonly snapshotId: string;
}

// `occurrenceListQuerySchema.state` is the persisted state enum, not the presentation label.
const STATES = ['scheduled', 'confirmed', 'skipped', 'cancelled'];
const KINDS = ['expense', 'income'];
/** `confirmOccurrenceBodySchema.expenseClass` accepts all three transaction classes. */
const CONFIRM_EXPENSE_CLASSES = ['essential_fixed', 'essential_variable', 'daily'];
/** See the same-day rule in `packages/domain/src/financial.ts`. */
const SNAPSHOT_INCLUSION = ['unspecified', 'no', 'yes'];
/** `scheduleExpenseClassSchema` (creation) is narrower on purpose. */
const SCHEDULE_EXPENSE_CLASSES = ['essential_fixed', 'essential_variable'];

function failureNotice(error: unknown): HTMLElement {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const failure = error as ApiFailure;
    return notice('error', `${failure.status} ${failure.code}: ${failure.message}`, failure.correlationId, failure.fields);
  }
  return notice('error', error instanceof Error ? error.message : 'The request failed.');
}

export function scheduleView(context: ScheduleViewContext): HTMLElement {
  const output = el('div', { class: 'result' });
  const stateFilter = selectField('State', STATES, { includeEmpty: true, name: 'state' });

  async function load(): Promise<void> {
    output.replaceChildren(el('p', { class: 'hint', text: 'Loading occurrences…' }));
    const state = readInput(stateFilter, 'state');
    const query = state.length === 0 ? '' : `?state=${encodeURIComponent(state)}`;
    try {
      const response = await context.api.schedule.occurrences(query);
      output.replaceChildren(
        response.data.items.length === 0
          ? notice('info', 'No occurrences for this filter. Creating a one-off below is the real way to produce one.')
          : el('ul', { class: 'list' }, ...response.data.items.map((occurrence) => occurrenceRow(occurrence))),
        wire('GET /api/v1/schedule/occurrences', response.data),
      );
    } catch (error) {
      output.replaceChildren(failureNotice(error));
    }
  }

  function occurrenceRow(occurrence: Record<string, unknown>): HTMLElement {
    const id = String(occurrence.id);
    const version = String(occurrence.version);
    const rowOutput = el('div', { class: 'result' });
    const confirmForm = el('form', { class: 'stack' },
      field({ label: 'Actual amount (minor units)', name: 'amountMinor', required: true, value: String(occurrence.expectedAmountMinor) }),
      field({ label: 'Occurred on', name: 'occurredOn', required: true, value: String(occurrence.dueOn) }),
      field({ label: 'Category code', name: 'categoryCode', required: true, value: String(occurrence.categoryCode) }),
      selectField('Expense class', CONFIRM_EXPENSE_CLASSES, { includeEmpty: true, name: 'expenseClass', hint: 'Leave empty for an incoming occurrence.' }),
      selectField('Snapshot inclusion', SNAPSHOT_INCLUSION, {
        value: 'unspecified',
        name: 'alreadyIncludedInSnapshot',
        hint: 'Confirming posts a real transaction, so the same date rule applies: before the snapshot it must be included, after it must not be, and the same day must be stated.',
      }),
      el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: `Confirm as a real transaction (occurrenceVersion ${version})` })),
    );
    const key = { value: newIdempotencyKey() };
    confirmForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const expenseClass = readInput(confirmForm, 'expenseClass');
      const snapshotInclusion = readInput(confirmForm, 'alreadyIncludedInSnapshot');
      const body = {
        amountMinor: readInput(confirmForm, 'amountMinor'),
        occurredOn: readInput(confirmForm, 'occurredOn'),
        categoryCode: readInput(confirmForm, 'categoryCode'),
        ...(expenseClass.length === 0 ? {} : { expenseClass }),
        ...(snapshotInclusion === 'yes'
          ? { alreadyIncludedInSnapshot: true }
          : snapshotInclusion === 'no' ? { alreadyIncludedInSnapshot: false } : {}),
        isUnexpected: false,
        expectedFinancialStateVersion: context.financialStateVersion,
        reviewedLatestSnapshotId: context.snapshotId,
        reviewedOccurrenceVersion: version,
      };
      rowOutput.replaceChildren(wire('request (version/snapshot read from the API when this page loaded)', { ...body, idempotencyKey: key.value }));
      void context.api.schedule.confirm(id, body, key.value)
        .then(async (response) => {
          rowOutput.replaceChildren(notice('ok', 'Occurrence confirmed; a transaction was posted.'), wire('response', response.data));
          toast('Occurrence confirmed');
          await load();
        })
        .catch((error: unknown) => { rowOutput.replaceChildren(failureNotice(error)); });
    });

    return el('li', { class: 'row' },
      el('div', { class: 'row-main' },
        el('span', { class: 'amount', text: formatMinor(String(occurrence.expectedAmountMinor), context.currency) }),
        el('span', { class: 'badge', text: `${String(occurrence.state)} · ${String(occurrence.direction)}` }),
        el('span', { class: 'hint', text: `${String(occurrence.title)} · due ${String(occurrence.dueOn)} · occurrenceVersion ${version}` }),
      ),
      el('div', { class: 'actions' },
        el('button', {
          class: 'button secondary', type: 'button', text: 'Skip',
          on: {
            click: () => {
              void context.api.schedule.skip(id, {
                reason: 'Skipped from the local testing client.',
                expectedFinancialStateVersion: context.financialStateVersion,
                reviewedLatestSnapshotId: context.snapshotId,
                reviewedOccurrenceVersion: version,
              }, newIdempotencyKey())
                .then(async (r) => { rowOutput.replaceChildren(notice('ok', 'Occurrence skipped.'), wire('skip response', r.data)); await load(); })
                .catch((e: unknown) => rowOutput.replaceChildren(failureNotice(e)));
            },
          },
        }),
      ),
      el('details', { class: 'wire' }, el('summary', { text: 'Confirm into a transaction' }), confirmForm, rowOutput),
    );
  }

  const createForm = el('form', { class: 'stack' },
    field({ label: 'Title', name: 'title', required: true }),
    selectField('Kind', KINDS, { value: 'expense', name: 'kind' }),
    field({ label: 'Expected amount (minor units)', name: 'expectedAmountMinor', required: true }),
    field({ label: 'Due on', name: 'dueOn', required: true, value: localDateToday() }),
    field({ label: 'Category code', name: 'categoryCode', required: true, placeholder: 'rent', hint: 'Must be an active seeded code for the chosen direction; docs/development/LOCAL-DEVELOPMENT.md §7 lists them.' }),
    selectField('Expense class', SCHEDULE_EXPENSE_CLASSES, { includeEmpty: true, name: 'expenseClass', hint: 'A one-off outflow is planned, so only the fixed/variable classes are accepted.' }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Create one-off schedule' })),
  );
  const createOutput = el('div', { class: 'result' });
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const expenseClass = readInput(createForm, 'expenseClass');
    const body = {
      title: readInput(createForm, 'title'),
      kind: readInput(createForm, 'kind'),
      expectedAmountMinor: readInput(createForm, 'expectedAmountMinor'),
      dueOn: readInput(createForm, 'dueOn'),
      categoryCode: readInput(createForm, 'categoryCode'),
      ...(expenseClass.length === 0 ? {} : { expenseClass }),
      expectedFinancialStateVersion: context.financialStateVersion,
      reviewedLatestSnapshotId: context.snapshotId,
    };
    createOutput.replaceChildren(wire('request', body));
    void context.api.schedule.oneOff(body, newIdempotencyKey())
      .then(async (response) => {
        createOutput.replaceChildren(notice('ok', 'One-off scheduled; one occurrence was created.'), wire('response', response.data));
        toast('One-off schedule created');
        await load();
      })
      .catch((error: unknown) => { createOutput.replaceChildren(failureNotice(error)); });
  });

  const filterForm = el('form', { class: 'stack' }, stateFilter,
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Apply' })));
  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void load(); });

  void load();

  return el('div', { class: 'stack' },
    card('Schedule agenda (SCH-01)',
      el('p', { class: 'hint', text: 'Confirming stores the persisted `confirmed` state and posts a transaction; it never claims the money was paid or received.' }),
      filterForm, output),
    card('New one-off schedule (SCH-03, one-off)', createForm, createOutput),
  );
}
