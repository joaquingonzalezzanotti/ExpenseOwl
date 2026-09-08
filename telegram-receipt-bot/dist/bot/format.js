import { config } from '../config.js';
const normalizeForMethodMatch = (raw) => String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
const normalizePaymentMethod = (sourceApp) => {
    const raw = normalizeForMethodMatch(sourceApp);
    if (!raw)
        return '';
    if (raw === 'UNKNOWN' || raw === 'NO ESPECIFICADO' || raw === 'DESCONOCIDO')
        return '';
    if (raw === 'EFECTIVO' || raw.includes('CASH'))
        return 'EFECTIVO';
    if (raw.includes('DEBITO') || raw.includes('DEBIT') || raw.includes('TRANSFER') || raw.includes('BANK') || raw.includes('WALLET') || raw.includes('MODO'))
        return 'CA';
    if (raw === 'TARJETA' || raw.includes('CREDITO') || raw.includes('CREDIT') || raw.includes('MASTERCARD') || raw.includes('AMEX') || raw.includes('VISA')) {
        return 'TARJETA';
    }
    return '';
};
const formatPaymentMethodLabel = (sourceApp) => {
    const code = normalizePaymentMethod(sourceApp);
    if (code === 'TARJETA')
        return 'Tarjeta de credito';
    if (code === 'EFECTIVO')
        return 'Efectivo (solo registro)';
    if (code === 'CA')
        return 'Transferencia';
    return 'Medio de pago no especificado';
};
const compactLine = (label, value) => {
    const clean = String(value || '').trim();
    if (!clean || clean === '-')
        return '';
    return `${label}: ${clean}`;
};
const normalizeMoney = (amount) => (typeof amount === 'number' && Number.isFinite(amount)
    ? amount.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : '-');
const formatDateTimeLabel = (iso) => {
    const raw = String(iso || '').trim();
    if (!raw)
        return '-';
    const localISO = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
    if (localISO) {
        const [, yyyy, mm, dd, hh, min] = localISO;
        return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
    }
    const parsedMs = Date.parse(raw);
    if (Number.isFinite(parsedMs)) {
        const formatted = new Intl.DateTimeFormat('es-AR', {
            timeZone: config.tzDefault,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(new Date(parsedMs));
        return formatted.replace(',', '');
    }
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (match) {
        const [, yyyy, mm, dd, hh, min] = match;
        return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
    }
    return raw;
};
export const resolveSuggestedCategory = (r) => {
    return r.rule_output?.category;
};
const resolveTypeLabel = (r) => {
    if (r.type === 'income')
        return 'Ingreso';
    if (r.type === 'refund')
        return 'Reintegro';
    if (r.type === 'expense' && normalizePaymentMethod(r.source_app) === 'TARJETA')
        return 'Gasto (tarjeta)';
    if (r.type === 'expense')
        return 'Gasto';
    return 'Pendiente';
};
const looksLikeUUID = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
const shouldShowReference = (reference) => {
    const clean = String(reference || '').trim();
    if (!clean)
        return false;
    if (looksLikeUUID(clean))
        return false;
    return clean.length <= 24;
};
export const draftSummary = (r) => [
    '*Movimiento detectado*',
    `${resolveTypeLabel(r)} • ${normalizeMoney(r.amount)} ${String(r.currency || 'ARS').trim().toUpperCase()}`,
    formatDateTimeLabel(r.datetime_iso),
    String(r.counterparty || '').trim() || '-',
    formatPaymentMethodLabel(r.source_app),
    compactLine('Motivo', r.motive),
    compactLine('Categoria', resolveSuggestedCategory(r)),
    shouldShowReference(r.reference) ? compactLine('Ref', r.reference) : ''
].filter(Boolean).join('\n');
