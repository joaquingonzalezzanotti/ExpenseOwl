import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDraftCorrectionUpdate,
    mergeExplicitUserTextIntoParsed,
    parsePaymentMethodInput,
    resolveVisibleTitle
} from './intake.js';

test('explicit caption wins over technical VAR motive while preserving bank memo', () => {
    const parsed = mergeExplicitUserTextIntoParsed({
        motive: 'VAR',
        counterparty: 'Juan Jose Palacio',
        source_app: 'MODO',
        currency: 'ARS'
    }, 'Empanadas en el almuerzo');

    assert.equal(parsed.motive, 'Empanadas en el almuerzo');
    assert.equal(parsed.description, 'Empanadas en el almuerzo');
    assert.equal(parsed.bank_memo, 'VAR');
    assert.equal(resolveVisibleTitle(parsed), 'Empanadas en el almuerzo');
});

test('payment method correction to transferencia persists as draft update data', () => {
    const update = buildDraftCorrectionUpdate({
        type: 'expense',
        amount: 8400,
        currency: 'ARS',
        datetime_iso: '2026-09-08T13:53:00-03:00',
        counterparty: 'Juan Jose Palacio',
        source_app: 'UNKNOWN'
    }, 'source_app', 'transferencia');

    assert.equal(update.error, '');
    assert.equal(parsePaymentMethodInput('transferencia'), 'CA');
    assert.equal(update.data.status, 'awaiting_confirm');
    assert.equal(update.data.parseResultJson.source_app, 'CA');
});

test('payment method correction can preserve duplicate decision status', () => {
    const update = buildDraftCorrectionUpdate({
        type: 'expense',
        amount: 8400,
        currency: 'ARS',
        datetime_iso: '2026-09-08T13:53:00-03:00',
        counterparty: 'Juan Jose Palacio',
        source_app: 'UNKNOWN'
    }, 'source_app', 'transferencia', 'awaiting_duplicate_decision');

    assert.equal(update.error, '');
    assert.equal(update.data.status, 'awaiting_duplicate_decision');
    assert.equal(update.data.parseResultJson.source_app, 'CA');
});

test('visible title falls back to counterparty when there is no semantic motive', () => {
    assert.equal(resolveVisibleTitle({
        motive: 'VAR',
        counterparty: 'Juan Jose Palacio'
    }), 'Juan Jose Palacio');
});
