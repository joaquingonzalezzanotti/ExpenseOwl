import { config } from '../config.js';
import { normalizePaymentMethod, resolveVisibleTitle } from './intake.js';
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
const resolveHeaderLabel = (r) => `${resolveTypeLabel(r).replace(/\s*\(.+?\)\s*$/, '')} detectado`;
const resolvePartyLine = (r) => [String(r.counterparty || '').trim(), formatPaymentMethodLabel(r.source_app)]
    .filter(Boolean)
    .join(' · ');
export const draftSummary = (r) => {
    const partyLine = resolvePartyLine(r);
    const lines = [
        `*${resolveHeaderLabel(r)}*`,
        '',
        `*${normalizeMoney(r.amount)} ${String(r.currency || 'ARS').trim().toUpperCase()}*`,
        resolveVisibleTitle(r)
    ];
    if (partyLine) {
        lines.push(partyLine);
    }
    lines.push(formatDateTimeLabel(r.datetime_iso));
    return lines.join('\n');
};
