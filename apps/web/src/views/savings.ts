/**
 * M06 savings goals through the endpoints that exist: list, create, update the
 * current amount under the goal's own version, archive, and the amount-change
 * history. Progress numbers are rendered from the API's own `progress` object
 * rather than recomputed here, so the client cannot disagree with the ledger.
 */

import type { Api, ApiFailure } from '../api.js';
import { newIdempotencyKey } from '../api.js';
import { card, el, field, notice, readInput, selectField, toast, wire } from '../dom.js';
import { formatMinor, localDateToday } from '../money.js';

export interface SavingsViewContext {
  readonly api: Api;
  readonly currency: string;
}

const STATUSES = ['active', 'archived', 'all'];
const FREQUENCIES = ['weekly', 'monthly', 'yearly'];

function failureNotice(error: unknown): HTMLElement {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const failure = error as ApiFailure;
    return notice('error', `${failure.status} ${failure.code}: ${failure.message}`, failure.correlationId, failure.fields);
  }
  return notice('error', error instanceof Error ? error.message : 'The request failed.');
}

export function savingsView(context: SavingsViewContext): HTMLElement {
  const listOutput = el('div', { class: 'result' });
  const statusFilter = selectField('Status', STATUSES, { value: 'active', name: 'status' });

  async function load(): Promise<void> {
    listOutput.replaceChildren(el('p', { class: 'hint', text: 'Loading savings goals…' }));
    try {
      const response = await context.api.savings.list(readInput(statusFilter, 'status') as 'active' | 'archived' | 'all');
      listOutput.replaceChildren(
        response.data.items.length === 0
          ? notice('info', 'No savings goals for this filter. Nothing is seeded on your behalf.')
          : el('ul', { class: 'list' }, ...response.data.items.map((goal) => goalRow(goal))),
        wire('GET /api/v1/savings-goals', response.data),
      );
    } catch (error) {
      listOutput.replaceChildren(failureNotice(error));
    }
  }

  function goalRow(goal: Record<string, unknown>): HTMLElement {
    const id = String(goal.id);
    const version = String(goal.version);
    const progress = goal.progress as { percentBasisPoints?: string; remainingMinor?: string } | undefined;
    const rowOutput = el('div', { class: 'result' });
    const amountForm = el('form', { class: 'stack' },
      field({ label: 'New current amount (minor units)', name: 'currentAmountMinor', required: true }),
      field({ label: 'As of', name: 'asOf', required: true, value: localDateToday() }),
      field({ label: 'Reason (optional)', name: 'reason' }),
      el('div', { class: 'actions' },
        el('button', { class: 'button', type: 'submit', text: `Update amount (expectedVersion ${version})` }),
        el('button', {
          class: 'button secondary', type: 'button', text: `Archive (expectedVersion ${version})`,
          on: {
            click: () => {
              void context.api.savings.archive(id, { expectedVersion: version }, newIdempotencyKey())
                .then(async (r) => { rowOutput.replaceChildren(notice('ok', 'Goal archived.'), wire('archive response', r.data)); toast('Goal archived'); await load(); })
                .catch((e: unknown) => rowOutput.replaceChildren(failureNotice(e)));
            },
          },
        }),
        el('button', {
          class: 'button secondary', type: 'button', text: 'Amount-change history',
          on: {
            click: () => {
              void context.api.savings.amountChanges(id)
                .then((r) => rowOutput.replaceChildren(wire('GET amount-changes', r.data)))
                .catch((e: unknown) => rowOutput.replaceChildren(failureNotice(e)));
            },
          },
        }),
      ),
    );
    const key = { value: newIdempotencyKey() };
    amountForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const reason = readInput(amountForm, 'reason');
      const body = {
        expectedVersion: version,
        currentAmountMinor: readInput(amountForm, 'currentAmountMinor'),
        asOf: readInput(amountForm, 'asOf'),
        ...(reason.length === 0 ? {} : { reason }),
      };
      rowOutput.replaceChildren(wire('request', body));
      void context.api.savings.setCurrentAmount(id, body, key.value)
        .then(async (r) => {
          rowOutput.replaceChildren(notice('ok', 'Current amount updated.'), wire('response', r.data));
          toast('Savings amount updated');
          await load();
        })
        .catch((e: unknown) => rowOutput.replaceChildren(failureNotice(e)));
    });

    return el('li', { class: 'row' },
      el('div', { class: 'row-main' },
        el('span', { class: 'amount', text: formatMinor(String(goal.currentAmountMinor), context.currency) }),
        el('span', { class: 'badge', text: String(goal.status) }),
        el('span', { class: 'hint', text: `${String(goal.name)} · target ${formatMinor(String(goal.targetAmountMinor), context.currency)}${progress?.percentBasisPoints ? ` · ${progress.percentBasisPoints} bp of target` : ''}` }),
        el('span', { class: 'hint', text: `goalId ${id} · version ${version} · as of ${String(goal.currentAmountAsOf)}` }),
      ),
      rowOutput,
      el('details', { class: 'wire' }, el('summary', { text: 'Update amount' }), amountForm),
    );
  }

  const createForm = el('form', { class: 'stack' },
    field({ label: 'Name', name: 'name', required: true }),
    field({ label: 'Target amount (minor units)', name: 'targetAmountMinor', required: true }),
    field({ label: 'Current amount (minor units)', name: 'currentAmountMinor', required: true, value: '0', hint: 'Zero is a valid starting point; the API accepts 0 here.' }),
    field({ label: 'Current amount as of', name: 'currentAmountAsOf', required: true, value: localDateToday() }),
    field({ label: 'Target date (optional)', name: 'targetDate', placeholder: 'YYYY-MM-DD' }),
    field({ label: 'Planned contribution (optional, minor units)', name: 'plannedContributionMinor' }),
    selectField('Contribution frequency (optional)', FREQUENCIES, { includeEmpty: true, name: 'contributionFrequency' }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Create goal' })),
  );
  const createOutput = el('div', { class: 'result' });
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const targetDate = readInput(createForm, 'targetDate');
    const planned = readInput(createForm, 'plannedContributionMinor');
    const frequency = readInput(createForm, 'contributionFrequency');
    const body = {
      name: readInput(createForm, 'name'),
      targetAmountMinor: readInput(createForm, 'targetAmountMinor'),
      currentAmountMinor: readInput(createForm, 'currentAmountMinor'),
      currentAmountAsOf: readInput(createForm, 'currentAmountAsOf'),
      ...(targetDate.length === 0 ? {} : { targetDate }),
      ...(planned.length === 0 ? {} : { plannedContributionMinor: planned }),
      ...(frequency.length === 0 ? {} : { contributionFrequency: frequency }),
    };
    createOutput.replaceChildren(wire('request', body));
    void context.api.savings.create(body, newIdempotencyKey())
      .then(async (response) => {
        createOutput.replaceChildren(notice('ok', 'Goal created.'), wire('response', response.data));
        toast('Savings goal created');
        await load();
      })
      .catch((error: unknown) => { createOutput.replaceChildren(failureNotice(error)); });
  });

  const filterForm = el('form', { class: 'stack' }, statusFilter,
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Apply' })));
  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void load(); });

  void load();

  return el('div', { class: 'stack' },
    card('Savings goals (PLAN — M06)', filterForm, listOutput),
    card('Create a savings goal', createForm, createOutput),
  );
}
