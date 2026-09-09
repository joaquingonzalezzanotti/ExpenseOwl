import { Markup } from 'telegraf';
import { buildDraftAction } from './callback_data.js';
const isSafeTelegramURL = (value) => /^https?:\/\//i.test(String(value || '').trim());
export const mainDecisionKeyboard = (draftId) => Markup.inlineKeyboard([
    [Markup.button.callback('Confirmar', buildDraftAction('confirm', draftId))],
    [Markup.button.callback('Corregir', buildDraftAction('fix_menu', draftId))],
    [Markup.button.callback('Descartar', buildDraftAction('reject', draftId))]
]);
export const postConfirmKeyboard = (transactionUrl) => {
    const rows = [];
    if (isSafeTelegramURL(transactionUrl)) {
        rows.push([Markup.button.url('Modificar', transactionUrl)]);
    }
    rows.push([Markup.button.callback('Cancelar', 'post_cancel')]);
    return Markup.inlineKeyboard(rows);
};
export const fixMenuKeyboard = (draftId) => Markup.inlineKeyboard([
    [Markup.button.callback('Cambiar monto', buildDraftAction('fix_amount', draftId)), Markup.button.callback('Cambiar fecha y hora', buildDraftAction('fix_datetime', draftId))],
    [Markup.button.callback('Cambiar contraparte', buildDraftAction('fix_counterparty', draftId)), Markup.button.callback('Cambiar tipo', buildDraftAction('fix_type', draftId))],
    [Markup.button.callback('Cambiar metodo', buildDraftAction('fix_source', draftId)), Markup.button.callback('Cambiar motivo', buildDraftAction('fix_motive', draftId))],
    [Markup.button.callback('Reintentar con AI', buildDraftAction('fix_retry_ai', draftId))],
    [Markup.button.callback('Volver', buildDraftAction('back_summary', draftId))]
]);
export const dedupeKeyboard = (draftId) => Markup.inlineKeyboard([
    [Markup.button.callback('Crear de todos modos', buildDraftAction('dedupe_create_anyway', draftId))],
    [Markup.button.callback('Cancelar carga', buildDraftAction('dedupe_cancel', draftId))]
]);
