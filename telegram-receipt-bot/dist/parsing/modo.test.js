import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModoReceipt } from './modo.js';

test('parseModoReceipt keeps the exact amount from OCR text', () => {
    const parsed = parseModoReceipt('MODO Ref. ABC123456 Transferencia de Joaquin Gonzalez Zanotti Desde la cuenta Santander CA 8536 Para Joaquin Gonzalez Zanotti A su cuenta Brubank CA 0001 Monto $1 Motivo VAR Fecha y hora 26/05/2026 a las 10:56hs', ['Joaquin Gonzalez Zanotti'], {});
    assert.equal(parsed.amount, 1);
    assert.equal(parsed.datetime_iso, '2026-05-26T10:56:00-03:00');
});

test('parseModoReceipt does not infer expense for same-party transfers', () => {
    const parsed = parseModoReceipt('MODO Ref. ABC123456 Transferencia de Joaquin Gonzalez Zanotti Desde la cuenta Santander CA 8536 Para Joaquin Gonzalez Zanotti A su cuenta Brubank CA 0001 Monto $5000 Motivo VAR Fecha y hora 26/05/2026 a las 10:56hs', ['Joaquin Gonzalez Zanotti'], {});
    assert.equal(parsed.type, undefined);
    assert.match(parsed.warnings.join(' '), /Transferencia ambigua/i);
});
