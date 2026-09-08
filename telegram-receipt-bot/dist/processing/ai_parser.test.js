import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAIParserResult } from './ai_parser.js';

test('normalizeAIParserResult preserves explicit USD currency', () => {
    const parsed = normalizeAIParserResult({
        type: 'expense',
        amount: 10,
        currency: 'USD',
        counterparty: 'ChatGPT plus',
        datetime_iso: '2026-09-08T12:00:00-03:00',
        source_app: 'UNKNOWN'
    }, 'Gaste 10 USD en ChatGPT plus para el trabajo', {});

    assert.equal(parsed.type, 'expense');
    assert.equal(parsed.amount, 10);
    assert.equal(parsed.currency, 'USD');
});

test('normalizeAIParserResult normalizes US$ currency marker to USD', () => {
    const parsed = normalizeAIParserResult({
        type: 'expense',
        amount: 10,
        currency: 'US$',
        counterparty: 'ChatGPT plus',
        datetime_iso: '2026-09-08T12:00:00-03:00',
        source_app: 'UNKNOWN'
    }, 'Gaste US$10 en ChatGPT plus para el trabajo', {});

    assert.equal(parsed.currency, 'USD');
});

test('normalizeAIParserResult maps reintegro to refund', () => {
    const parsed = normalizeAIParserResult({
        type: 'reintegro',
        amount: 27000,
        currency: 'ARS',
        counterparty: 'Juan Pablo',
        motive: 'ubers',
        datetime_iso: '2026-09-08T12:00:00-03:00',
        source_app: 'UNKNOWN'
    }, 'Juan Pablo me reintegro 27000 pesos con motivo ubers', {});

    assert.equal(parsed.type, 'refund');
    assert.equal(parsed.amount, 27000);
    assert.equal(parsed.currency, 'ARS');
    assert.equal(parsed.counterparty, 'Juan Pablo');
    assert.equal(parsed.motive, 'ubers');
});
