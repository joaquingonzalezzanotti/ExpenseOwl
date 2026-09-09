import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSummary } from './format.js';

test('draftSummary renders UTC timestamps in Argentina local time', () => {
    const summary = draftSummary({
        type: 'expense',
        amount: 10,
        currency: 'ARS',
        datetime_iso: '2026-05-26T13:57:00.000Z',
        counterparty: 'Santiago Javier Mercau',
        source_app: 'MODO',
        motive: 'VAR'
    });

    assert.match(summary, /26\/05\/2026 10:57/);
    assert.doesNotMatch(summary, /VAR/);
});

test('draftSummary omits opaque UUID references', () => {
    const summary = draftSummary({
        type: 'expense',
        amount: 5000,
        currency: 'ARS',
        datetime_iso: '2026-05-26T10:57:00',
        counterparty: 'Joaquin Gonzalez Zanotti',
        source_app: 'Transferencia',
        reference: '8b23451b-371c-4699-8b28-eff0722e6b3b'
    });

    assert.doesNotMatch(summary, /Ref:/);
});

test('draftSummary does not invent payment method for unknown source', () => {
    const summary = draftSummary({
        type: 'expense',
        amount: 10,
        currency: 'USD',
        datetime_iso: '2026-09-08T12:00:00-03:00',
        counterparty: 'ChatGPT plus',
        source_app: 'UNKNOWN',
        motive: 'para el trabajo'
    });

    assert.match(summary, /\*10 USD\*/);
    assert.match(summary, /Medio de pago no especificado/);
    assert.doesNotMatch(summary, /Transferencia \/ Debito/);
});

test('draftSummary renders refunds as reimbursement business type', () => {
    const summary = draftSummary({
        type: 'refund',
        amount: 27000,
        currency: 'ARS',
        datetime_iso: '2026-09-08T12:00:00-03:00',
        counterparty: 'Juan Pablo',
        source_app: 'UNKNOWN',
        motive: 'ubers'
    });

    assert.match(summary, /Reintegro detectado/);
    assert.match(summary, /27\.000 ARS/);
    assert.match(summary, /ubers/);
});

test('draftSummary uses semantic motive as compact title before counterparty', () => {
    const summary = draftSummary({
        type: 'expense',
        amount: 8400,
        currency: 'ARS',
        datetime_iso: '2026-09-08T13:53:00-03:00',
        counterparty: 'Juan Jose Palacio',
        source_app: 'CA',
        motive: 'Empanadas en el almuerzo'
    });

    assert.equal(summary, [
        '*Gasto detectado*',
        '',
        '*8.400 ARS*',
        'Empanadas en el almuerzo',
        'Juan Jose Palacio · Transferencia',
        '08/09/2026 13:53'
    ].join('\n'));
});

test('draftSummary falls back to counterparty when motive is not semantic', () => {
    const summary = draftSummary({
        type: 'expense',
        amount: 8400,
        currency: 'ARS',
        datetime_iso: '2026-09-08T13:53:00-03:00',
        counterparty: 'Juan Jose Palacio',
        source_app: 'CA',
        motive: 'VAR'
    });

    assert.match(summary, /\nJuan Jose Palacio\n/);
    assert.doesNotMatch(summary, /VAR/);
});
