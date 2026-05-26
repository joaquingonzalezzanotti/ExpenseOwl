import { parseArDateTime } from './date.js';
const pick = (text, regex) => text.match(regex)?.[1]?.trim();
const onlyLast4 = (v) => (v ? v.replace(/\D/g, '').slice(-4) : undefined);
const normalizeName = (v) => v?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const sanitizeExcerpt = (raw) => raw.replace(/\b\d{10,22}\b/g, '[REDACTED_LONG_NUMBER]').slice(0, 300);
export const parseModoReceipt = (text, aliases, telegramMeta) => {
    const clean = text.replace(/S\.E\.U\.O\./gi, ' ').replace(/\s+/g, ' ').trim();
    const source = pick(clean, /Transferencia de\s+(.+?)\s+Desde la cuenta/i);
    const dest = pick(clean, /Para\s+(.+?)\s+A su cuenta/i);
    const paidTo = pick(clean, /Pagaste a\s+(.+?)\s+Monto/i);
    const amountRaw = pick(clean, /Monto\s*\$\s*([\d\.,]+)/i)?.replace(/\./g, '').replace(',', '.');
    const ref = pick(clean, /Ref\.?\s*([A-Z0-9-]{6,})/i);
    const motive = pick(clean, /Motivo\s+(.+?)(?:\s+Fecha y hora|\s+Fecha y Hora|$)/i);
    const paymentMethodRaw = pick(clean, /Medio de pago\s+(.+?)(?:\s+Comprobante|\s+ID de QR|$)/i);
    const dateIso = parseArDateTime(pick(clean, /Fecha y hora\s+(.+?)(?:\s+Medio de pago|\s+Comprobante|\s+ID de QR|$)/i)
        ?? pick(clean, /Fecha y Hora\s+(.+?)(?:\s+Medio de pago|\s+Comprobante|\s+ID de QR|$)/i)
        ?? '');
    const fromAcc = pick(clean, /Desde la cuenta\s+(.+?)\s+Para/i);
    const toAcc = pick(clean, /A su cuenta\s+(.+?)\s+CBU\/CVU/i)
        ?? paymentMethodRaw;
    const cbu = pick(clean, /CBU\/CVU\s+(\d{10,22})/i);
    const aliasNorm = aliases.map((a) => normalizeName(a));
    const sourceNorm = normalizeName(source);
    const destNorm = normalizeName(dest);
    const srcIsMine = source && aliasNorm.includes(sourceNorm);
    const dstIsMine = dest && aliasNorm.includes(destNorm);
    const paidToNorm = normalizeName(paidTo);
    const paidToIsMine = paidToNorm ? aliasNorm.includes(paidToNorm) : false;
    const hasDirectionalTransferLayout = Boolean(source && dest && fromAcc && toAcc);
    const samePartyTransfer = Boolean(sourceNorm && destNorm && sourceNorm === destNorm);
    let type;
    let typeConfidence = 0.2;
    const warnings = [];
    if (samePartyTransfer) {
        warnings.push('Transferencia ambigua: origen y destino parecen ser la misma persona.');
    }
    if (paidTo && !paidToIsMine) {
        type = 'expense';
        typeConfidence = 0.92;
    }
    if (paidTo && paidToIsMine) {
        type = 'income';
        typeConfidence = 0.7;
    }
    if (srcIsMine && !dstIsMine) {
        type = 'expense';
        typeConfidence = 0.88;
    }
    if (!srcIsMine && dstIsMine) {
        type = 'income';
        typeConfidence = 0.88;
    }
    // For receipts like "Transferencia de X ... Para Y ...", if aliases are missing,
    // infer expense from the directional layout instead of leaving type undefined.
    if (!type && hasDirectionalTransferLayout && !samePartyTransfer) {
        type = 'expense';
        typeConfidence = 0.72;
        warnings.push('Tipo inferido por estructura de transferencia (sin alias).');
    }
    let counterparty = paidTo || (srcIsMine ? dest : source);
    if (!paidTo && type === 'expense' && dest) {
        counterparty = dest;
    }
    if (!paidTo && type === 'income' && source) {
        counterparty = source;
    }
    const amount = amountRaw ? Number(amountRaw) : undefined;
    const amountConfidence = amountRaw ? 0.95 : 0.2;
    const datetimeConfidence = dateIso ? 0.8 : 0.2;
    const counterpartyConfidence = counterparty ? 0.82 : 0.1;
    const overallRaw = (typeConfidence + amountConfidence + datetimeConfidence + counterpartyConfidence) / 4;
    const overall = Math.max(0, Math.min(1, Number(overallRaw.toFixed(2))));
    const missingRequired = [];
    if (!type)
        missingRequired.push('type');
    if (!(typeof amount === 'number' && Number.isFinite(amount) && amount !== 0))
        missingRequired.push('amount');
    if (!dateIso)
        missingRequired.push('datetime_iso');
    if (!counterparty)
        missingRequired.push('counterparty');
    return {
        source_app: paymentMethodRaw || 'MODO',
        type,
        amount,
        currency: 'ARS',
        datetime_iso: dateIso,
        counterparty,
        reference: ref,
        motive,
        account_from: fromAcc ? { bank: fromAcc } : undefined,
        account_to: toAcc ? { bank: toAcc } : undefined,
        cbu_cvu_last4: onlyLast4(cbu),
        confidence: {
            type: typeConfidence,
            amount: amountConfidence,
            datetime_iso: datetimeConfidence,
            counterparty: counterpartyConfidence,
            overall
        },
        missing_required: missingRequired,
        warnings,
        raw_text_excerpt: sanitizeExcerpt(clean),
        telegram_meta: telegramMeta
    };
};
