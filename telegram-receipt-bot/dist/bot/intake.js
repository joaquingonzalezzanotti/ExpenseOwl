import { DRAFT_STATUS } from './draft_state.js';

export const normalizeCurrency = (raw) => {
    const normalized = String(raw || '').trim().toUpperCase();
    if (['USD', 'US$', 'U$S'].includes(normalized))
        return 'USD';
    if (['EUR', '€'].includes(normalized))
        return 'EUR';
    if (['ARS', '$', 'PESO', 'PESOS'].includes(normalized))
        return 'ARS';
    return 'ARS';
};

export const normalizeForMethodMatch = (raw) => String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();

export const normalizePaymentMethod = (raw) => {
    const normalized = normalizeForMethodMatch(raw);
    if (!normalized)
        return '';
    if (normalized === 'CA')
        return 'CA';
    if (normalized === 'UNKNOWN' || normalized === 'NO ESPECIFICADO' || normalized === 'DESCONOCIDO')
        return '';
    if (normalized === 'EFECTIVO' || normalized.includes('CASH'))
        return 'EFECTIVO';
    if (normalized.includes('DEBITO') ||
        normalized.includes('DEBIT') ||
        normalized.includes('TRANSFER') ||
        normalized.includes('BANK') ||
        normalized.includes('BANCO') ||
        normalized.includes('WALLET') ||
        normalized.includes('MODO') ||
        normalized.includes('GALICIA')) {
        return 'CA';
    }
    if (normalized === 'TARJETA' ||
        normalized.includes('CREDITO') ||
        normalized.includes('CREDIT') ||
        normalized.includes('MASTERCARD') ||
        normalized.includes('AMEX') ||
        normalized.includes('VISA')) {
        return 'TARJETA';
    }
    return '';
};

export const parsePaymentMethodInput = (raw) => {
    const normalized = normalizeForMethodMatch(raw).toLowerCase();
    if (!normalized)
        return undefined;
    if (normalized.includes('efectivo') || normalized.includes('cash')) {
        return 'EFECTIVO';
    }
    if (normalized.includes('transfer') || normalized.includes('debito') || normalized.includes('debit') || normalized.includes('banco') || normalized.includes('bank') || normalized.includes('modo')) {
        return 'CA';
    }
    if (normalized.includes('tarjeta') || normalized.includes('credito') || normalized.includes('credit') || normalized.includes('visa') || normalized.includes('master') || normalized.includes('amex')) {
        return 'TARJETA';
    }
    return undefined;
};

export const isTechnicalBankMemo = (raw) => {
    const normalized = normalizeForMethodMatch(raw).replace(/[.\-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return ['VAR', 'N A', 'NA', 'N/A', 'SIN MOTIVO', 'SIN CONCEPTO', 'S E U O', 'SEUO'].includes(normalized);
};

const cleanSemanticText = (raw) => {
    const clean = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!clean || isTechnicalBankMemo(clean))
        return '';
    return clean;
};

const preserveBankMemo = (parsed, value) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean)
        return;
    if (!parsed.bank_memo) {
        parsed.bank_memo = clean;
    }
};

export const normalizeParsedTransaction = (parsed) => {
    const next = { ...(parsed || {}) };
    next.source_app = normalizePaymentMethod(next.source_app);
    next.currency = normalizeCurrency(next.currency);
    if (isTechnicalBankMemo(next.motive)) {
        preserveBankMemo(next, next.motive);
        next.motive = undefined;
    }
    return next;
};

export const mergeExplicitUserTextIntoParsed = (parsed, rawUserText) => {
    const next = normalizeParsedTransaction(parsed);
    const userText = cleanSemanticText(rawUserText);
    if (!userText)
        return next;
    if (isTechnicalBankMemo(next.motive)) {
        preserveBankMemo(next, next.motive);
    }
    next.motive = userText;
    next.description = userText;
    next.user_text = userText;
    return next;
};

export const resolveVisibleTitle = (parsed) => {
    const motive = cleanSemanticText(parsed?.motive) || cleanSemanticText(parsed?.description);
    if (motive)
        return motive;
    return String(parsed?.counterparty || '').replace(/\s+/g, ' ').trim() || '-';
};

export const applyDraftFieldCorrection = (parsed, field, rawValue) => {
    const next = { ...(parsed || {}) };
    const value = String(rawValue || '').trim();
    if (field === 'amount') {
        next.amount = Number(value.replace(',', '.'));
    }
    else if (field === 'datetime_iso') {
        next.datetime_iso = value;
    }
    else if (field === 'counterparty') {
        next.counterparty = value;
    }
    else if (field === 'type') {
        next.type = value;
    }
    else if (field === 'source_app') {
        const parsedMethod = parsePaymentMethodInput(value);
        if (!parsedMethod) {
            return { parsed: next, error: 'invalid_payment_method' };
        }
        next.source_app = parsedMethod;
    }
    else if (field === 'motive') {
        next.motive = value;
    }
    return { parsed: normalizeParsedTransaction(next), error: '' };
};

export const buildDraftCorrectionUpdate = (parsed, field, rawValue, status = DRAFT_STATUS.AWAITING_CONFIRM) => {
    const result = applyDraftFieldCorrection(parsed, field, rawValue);
    if (result.error)
        return result;
    return {
        parsed: result.parsed,
        error: '',
        data: {
            parseResultJson: result.parsed,
            status
        }
    };
};
