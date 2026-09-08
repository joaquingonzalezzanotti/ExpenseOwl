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

    assert.match(summary, /Gasto • 10 USD/);
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

    assert.match(summary, /Reintegro • 27\.000 ARS/);
    assert.match(summary, /Motivo: ubers/);
});
