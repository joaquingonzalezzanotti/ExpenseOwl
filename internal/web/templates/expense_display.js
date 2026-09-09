(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ExpenseLogExpenseDisplay = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function() {
    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeForMatch(value) {
        return normalizeText(value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[.\-_]+/g, ' ')
            .toUpperCase();
    }

    function isTechnicalBankMemo(value) {
        const normalized = normalizeForMatch(value);
        return ['VAR', 'N A', 'NA', 'N/A', 'SIN MOTIVO', 'SIN CONCEPTO', 'S E U O', 'SEUO'].includes(normalized);
    }

    function stripReferenceSuffix(value) {
        return normalizeText(value).replace(/\s+\(([A-Z0-9-]{4,}|[0-9a-f-]{24,})\)$/i, '').trim();
    }

    function isLikelyCounterparty(value) {
        const words = normalizeText(value).split(/\s+/).filter(Boolean);
        if (words.length < 2) return false;
        const namedWords = words.filter(word => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/.test(word) || /^[A-ZÁÉÍÓÚÑ]{2,}$/.test(word));
        return namedWords.length / words.length >= 0.6;
    }

    function isTelegramBotExpense(expense) {
        const origin = String(expense && expense.systemOrigin || '').trim().toLowerCase();
        if (origin === 'telegram_bot') return true;
        if (!Array.isArray(expense && expense.tags)) return false;
        return expense.tags.some(tag => String(tag || '').trim().toLowerCase() === 'telegram_bot');
    }

    function resolveExpenseDisplayParts(expense) {
        const rawName = normalizeText(expense && expense.name);
        const fallback = { title: rawName || '-', secondary: '' };
        if (!rawName || !isTelegramBotExpense(expense)) return fallback;

        const parts = rawName.split(/\s+-\s+/).map(stripReferenceSuffix).filter(Boolean);
        if (parts.length < 2) {
            return isTechnicalBankMemo(rawName) ? { title: '-', secondary: '' } : fallback;
        }

        const first = parts[0];
        const second = parts.slice(1).join(' - ');
        if (!isTechnicalBankMemo(second) && isLikelyCounterparty(first)) {
            return { title: second, secondary: first };
        }
        if (!isTechnicalBankMemo(first)) {
            return { title: first, secondary: isTechnicalBankMemo(second) ? '' : second };
        }
        return { title: second || first || '-', secondary: '' };
    }

    return {
        isTechnicalBankMemo,
        resolveExpenseDisplayParts
    };
});
