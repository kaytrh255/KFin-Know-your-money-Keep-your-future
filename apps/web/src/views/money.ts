/**
 * ONB-02 (initial balance snapshot) and HOME-01 (authoritative balance) as far
 * as the implemented API goes. The optimistic-concurrency values the API demands
 * (`expectedFinancialStateVersion`, `reviewedLatestSnapshotId`) are read from the
 * server and shown next to the form rather than remembered on the client, so a
 * stale value fails loudly instead of being papered over.
 */

import type { Api, ApiFailure } from '../api.js';
import { newIdempotencyKey } from '../api.js';
import { card, el, field, notice, readInput, toast, wire } from '../dom.js';
import { formatMinor, instantNow, localDateToday } from '../money.js';

export interface MoneyViewContext {
  readonly api: Api;
}

interface AccountSummary {
  accountId: string;
  currency: string;
  financialStateVersion: string;
  snapshot: { id: string; amountMinor: string; effectiveAt: string; effectiveLocalDate: string };
  postedCurrentIncomeMinor: string;
  postedCurrentExpenseMinor: string;
  currentBalanceMinor: string;
}

function failureNotice(error: unknown): HTMLElement {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const failure = error as ApiFailure;
    return notice('error', `${failure.status} ${failure.code}: ${failure.message}`, failure.correlationId, failure.fields);
  }
  return notice('error', error instanceof Error ? error.message : 'The request failed.');
}

export function moneyView(context: MoneyViewContext): HTMLElement {
  const output = el('div', { class: 'result' });
  const host = el('div', { class: 'stack' }, el('p', { class: 'hint', text: 'Loading the financial account…' }), output);

  async function load(): Promise<void> {
    try {
      const response = await context.api.financial.account();
      host.replaceChildren(accountSummary(context, response.data, load), output);
      output.replaceChildren(wire('GET /api/v1/financial-account', response.data));
    } catch (error) {
      const failure = error as ApiFailure;
      if (failure.status === 404 || /UNAVAILABLE|NOT_FOUND/.test(failure.code ?? '')) {
        host.replaceChildren(openAccountForm(context, load), output);
        output.replaceChildren(failureNotice(error));
      } else {
        host.replaceChildren(failureNotice(error));
      }
    }
  }

  void load();
  return host;
}

function accountSummary(context: MoneyViewContext, account: AccountSummary, reload: () => Promise<void>): HTMLElement {
  const snapshotForm = el('form', { class: 'stack' },
    field({
      label: 'New authoritative amount',
      name: 'amountMinor',
      required: true,
      hint: `Signed minor units, exactly as the API stores them. Current balance: ${account.currentBalanceMinor}.`,
    }),
    field({ label: 'Effective at (ISO instant)', name: 'effectiveAt', required: true, value: instantNow() }),
    field({ label: 'Note (optional)', name: 'note' }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Post snapshot' })),
  );
  const snapshotResult = el('div', { class: 'result' });
  const key = { value: newIdempotencyKey() };
  snapshotForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const note = readInput(snapshotForm, 'note');
    const body = {
      amountMinor: readInput(snapshotForm, 'amountMinor'),
      effectiveAt: readInput(snapshotForm, 'effectiveAt'),
      ...(note.length === 0 ? {} : { note }),
      expectedFinancialStateVersion: account.financialStateVersion,
      reviewedLatestSnapshotId: account.snapshot.id,
    };
    snapshotResult.replaceChildren(wire('request (idempotency-key reused for retries of this intent)', { ...body, idempotencyKey: key.value }));
    void context.api.financial.postSnapshot(body, key.value)
      .then(async (response) => {
        snapshotResult.replaceChildren(notice('ok', 'Snapshot posted.'), wire('response', response.data));
        await reload();
      })
      .catch((error: unknown) => { snapshotResult.replaceChildren(failureNotice(error)); });
  });

  return el('div', { class: 'stack' },
    card('Authoritative balance (HOME-01)',
      el('dl', { class: 'facts' },
        el('dt', { text: 'Current balance' }), el('dd', { class: 'amount', text: formatMinor(account.currentBalanceMinor, account.currency) }),
        // `currentBalanceSchema` carries no account name, so the screen shows the
        // currency it does carry instead of rendering a field that is not sent
        // (it printed "undefined" until 2026-10-13).
        el('dt', { text: 'Account currency' }), el('dd', { text: account.currency }),
        el('dt', { text: 'Snapshot' }), el('dd', { text: `${account.snapshot.id} · ${formatMinor(account.snapshot.amountMinor, account.currency)} · ${account.snapshot.effectiveAt}` }),
        el('dt', { text: 'Posted this anchor' }), el('dd', { text: `income ${account.postedCurrentIncomeMinor} · expense ${account.postedCurrentExpenseMinor}` }),
        el('dt', { text: 'financialStateVersion' }), el('dd', { text: account.financialStateVersion }),
        el('dt', { text: 'accountId' }), el('dd', { text: account.accountId }),
      ),
      el('div', { class: 'actions' },
        el('button', { class: 'button secondary', type: 'button', text: 'Reload', on: { click: () => { void reload(); } } }),
      ),
    ),
    card('Post a new snapshot (ONB-02 concurrency)',
      el('p', { class: 'hint', text: 'The API requires the version and snapshot you reviewed. Submitting twice with the same values must fail with a stale-version error — that is the intended behaviour, not a bug.' }),
      snapshotForm, snapshotResult,
    ),
  );
}

function openAccountForm(context: MoneyViewContext, reload: () => Promise<void>): HTMLElement {
  // The route declares `idempotencyHeadersSchema`, so a key is mandatory here too.
  const accountKey = { value: newIdempotencyKey() };
  const form = el('form', { class: 'stack' },
    field({
      label: 'Opening balance (minor units)',
      name: 'openingBalanceMinor',
      required: true,
      hint: 'Signed minor-unit string, for example 250000000 for 2 500 000 VND.',
    }),
    field({ label: 'Effective at (ISO instant)', name: 'effectiveAt', required: true, value: instantNow() }),
    el('div', { class: 'actions' }, el('button', { class: 'button', type: 'submit', text: 'Open financial account' })),
  );
  const result = el('div', { class: 'result' });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = {
      openingBalanceMinor: readInput(form, 'openingBalanceMinor'),
      effectiveAt: readInput(form, 'effectiveAt'),
    };
    result.replaceChildren(wire('request (idempotency-key reused for retries of this intent)', { ...body, idempotencyKey: accountKey.value }));
    void context.api.financial.open(body, accountKey.value)
      .then(async (response) => {
        result.replaceChildren(notice('ok', 'Financial account opened.'), wire('response', response.data));
        toast('Financial account opened');
        await reload();
      })
      .catch((error: unknown) => { result.replaceChildren(failureNotice(error)); });
  });

  return el('div', { class: 'stack' },
    card('Set up money (ONB-02)',
      el('p', { class: 'hint', text: 'No financial account exists for this user yet, so this is the real first write. Nothing is pre-filled except the current instant.' }),
      form, result),
    el('p', { class: 'hint', text: `Client clock: ${localDateToday()} (local date), ${instantNow()} (instant).` }),
  );
}
