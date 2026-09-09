import test from 'node:test';
import assert from 'node:assert/strict';
import { ExpenseLogAdapter, normalizeTransactionURL } from './client.js';

test('normalizeTransactionURL expands relative paths using web base url', () => {
    assert.equal(normalizeTransactionURL('/app/table', 'https://www.expenselog.com.ar'), 'https://www.expenselog.com.ar/app/table');
});

test('normalizeTransactionURL preserves absolute URLs', () => {
    assert.equal(normalizeTransactionURL('https://www.expenselog.com.ar/app/table?id=123'), 'https://www.expenselog.com.ar/app/table?id=123');
});

test('buildExpenseAPIPayload preserves explicit currency', () => {
    const adapter = new ExpenseLogAdapter();
    const payload = adapter.buildExpenseAPIPayload({
        type: 'expense',
        amount: 10,
        currency: 'USD',
        counterparty: 'ChatGPT plus',
        motive: 'para el trabajo',
        provider: ''
    });

    assert.equal(payload.flow, 'expense');
    assert.equal(payload.amount, 10);
    assert.equal(payload.currency, 'usd');
    assert.equal(payload.source, '');
    assert.equal(payload.name, 'para el trabajo - ChatGPT plus');
});

test('buildExpenseAPIPayload falls back to counterparty for technical motive', () => {
    const adapter = new ExpenseLogAdapter();
    const payload = adapter.buildExpenseAPIPayload({
        type: 'expense',
        amount: 8400,
        currency: 'ARS',
        counterparty: 'Juan Jose Palacio',
        motive: 'VAR',
        provider: 'CA'
    });

    assert.equal(payload.name, 'Juan Jose Palacio');
});
