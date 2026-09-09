import { Telegraf } from 'telegraf';
import { prisma } from '../db/client.js';
import { config, isAllowedTelegramUser } from '../config.js';
import { tempPathFor, safeDelete } from '../processing/file.js';
import { processReceipt } from '../processing/pipeline.js';
import { canUseAIParser, parseWithAIParser } from '../processing/ai_parser.js';
import { logger } from '../observability/logger.js';
import { draftSummary } from './format.js';
import { parseDraftAction } from './callback_data.js';
import { CONFIRMABLE_DRAFT_STATUSES, DRAFT_STATUS, DUPLICATE_CONFIRMABLE_DRAFT_STATUSES, EDITABLE_DRAFT_STATUSES, REJECTABLE_DRAFT_STATUSES, canResolveDraft, isTerminalDraftStatus } from './draft_state.js';
import { dedupeKeyboard, fixMenuKeyboard, mainDecisionKeyboard, postConfirmKeyboard } from './keyboards.js';
import { ExpenseLogAdapter, ExpenseLogAPIError } from '../expenselog/client.js';
import { applyRules } from '../rules/engine.js';
import { draftResults, parseResults, receiptsReceived, stageLatency } from '../observability/metrics.js';
import { AUTO_TEXT_RECEIPT_GRACE_MS, AUTO_TEXT_RECEIPT_SUPPRESSION_MS, getRecentReceiptActivity, markRecentReceiptActivity, shouldSuppressAutoTextFromRecentReceipt } from './text_routing.js';
import { buildDraftCorrectionUpdate, mergeExplicitUserTextIntoParsed, normalizeCurrency, normalizeParsedTransaction, normalizePaymentMethod } from './intake.js';
import { writeFile } from 'node:fs/promises';
const expenselogClient = new ExpenseLogAdapter();
const pendingFix = new Map();
const inFlightReceiptMessages = new Set();
const recentReceiptActivity = new Map();
const linkStatusCache = new Map();
const LINK_STATUS_CACHE_TTL_MS = 30_000;
const multiUserLinkingEnabled = Boolean(String(config.expenselogBotInternalSecret || '').trim());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toReceiptParseResult = (value) => value;
const getPendingFixState = (userId) => {
    const pending = pendingFix.get(userId);
    if (!pending) {
        return null;
    }
    if (typeof pending === 'string') {
        return { field: pending, draftId: '' };
    }
    return pending;
};
const fieldPromptByKey = {
    source_app: { label: 'metodo de pago', hint: 'Escribi: "transferencia", "efectivo" o "tarjeta credito".' },
    type: { label: 'tipo', hint: 'Escribi "gasto", "ingreso" o "reintegro".' },
    amount: { label: 'monto', hint: 'Ejemplo: 1600 o 1600,50' },
    currency: { label: 'moneda', hint: 'Ejemplo: ARS' },
    datetime_iso: { label: 'fecha y hora', hint: 'Ejemplo: 24/02/2026 20:55' },
    counterparty: { label: 'contraparte', hint: 'Ejemplo: SUPER SALTO 273' },
    reference: { label: 'referencia', hint: 'Ejemplo: HX7UOTFO' },
    motive: { label: 'motivo', hint: 'Ejemplo: supermercado' },
    account_from: { label: 'cuenta origen', hint: '' },
    account_to: { label: 'cuenta destino', hint: '' },
    cbu_cvu_last4: { label: 'ultimos 4 CBU/CVU', hint: '' },
    confidence: { label: 'confianza', hint: '' },
    raw_text_excerpt: { label: 'texto', hint: '' },
    telegram_meta: { label: 'metadatos', hint: '' },
    rule_output: { label: 'regla', hint: '' }
};
const parseTypeInput = (raw) => {
    const normalized = raw.trim().toLowerCase();
    if (['gasto', 'egreso', 'expense'].includes(normalized))
        return 'expense';
    if (['ingreso', 'income'].includes(normalized))
        return 'income';
    if (['reintegro', 'refund', 'devolucion', 'devolución', 'cashback'].includes(normalized))
        return 'refund';
    return undefined;
};
const getMissingRequiredLabels = (r) => {
    const missing = [];
    if (!r.type)
        missing.push('tipo');
    if (!(typeof r.amount === 'number' && Number.isFinite(r.amount) && r.amount !== 0))
        missing.push('monto');
    if (!r.datetime_iso)
        missing.push('fecha y hora');
    if (!r.counterparty)
        missing.push('contraparte');
    return missing;
};
const ensurePrivateAllowed = async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowedTelegramUser(userId)) {
        await ctx.reply('No tengo permiso para usar esta cuenta de Telegram.');
        return false;
    }
    if (ctx.chat?.type !== 'private') {
        await ctx.reply('Este bot funciona solo en chat privado (1 a 1).');
        return false;
    }
    return true;
};
const resolveLinkGateResult = async (telegramUserId, forceRefresh = false) => {
    if (!multiUserLinkingEnabled) {
        return { ok: true, reason: 'ok' };
    }
    const cached = linkStatusCache.get(telegramUserId);
    const now = Date.now();
    if (!forceRefresh && cached && cached.expiresAt > now) {
        return cached.value;
    }
    try {
        const status = await expenselogClient.getTelegramLinkStatus(telegramUserId);
        const result = status.linked && status.premium
            ? { ok: true, reason: 'ok' }
            : { ok: false, reason: status.premium ? 'not_linked' : 'premium_required' };
        linkStatusCache.set(telegramUserId, { expiresAt: now + LINK_STATUS_CACHE_TTL_MS, value: result });
        return result;
    }
    catch (error) {
        if (error instanceof ExpenseLogAPIError) {
            if (error.code === 'not_linked' || error.status === 404) {
                const result = { ok: false, reason: 'not_linked' };
                linkStatusCache.set(telegramUserId, { expiresAt: now + LINK_STATUS_CACHE_TTL_MS, value: result });
                return result;
            }
            if (error.code === 'premium_required' || error.status === 403) {
                const result = { ok: false, reason: 'premium_required' };
                linkStatusCache.set(telegramUserId, { expiresAt: now + LINK_STATUS_CACHE_TTL_MS, value: result });
                return result;
            }
            if (error.status === 401) {
                const result = { ok: false, reason: 'unauthorized' };
                linkStatusCache.set(telegramUserId, { expiresAt: now + LINK_STATUS_CACHE_TTL_MS, value: result });
                return result;
            }
        }
        logger.warn('telegram_link_status_failed', { telegramUserId, error });
        const result = { ok: false, reason: 'unknown' };
        linkStatusCache.set(telegramUserId, { expiresAt: now + 10_000, value: result });
        return result;
    }
};
const requireLinkedPremium = async (ctx, forceRefresh = false) => {
    const userId = ctx.from?.id;
    if (!userId)
        return false;
    const gate = await resolveLinkGateResult(userId, forceRefresh);
    if (gate.ok)
        return true;
    if (gate.reason === 'not_linked') {
        await ctx.reply('Primero vincula tu cuenta.\n1) En ExpenseLog: Settings > Telegram Bot > Generar codigo.\n2) Aca: /vincular TU-CODIGO');
        return false;
    }
    if (gate.reason === 'premium_required') {
        await ctx.reply('Tu cuenta de ExpenseLog no tiene Premium activo. Activalo y volve a intentar.');
        return false;
    }
    if (gate.reason === 'unauthorized') {
        await ctx.reply('No pude validar tu sesion con ExpenseLog en este momento. Proba de nuevo en unos minutos.');
        return false;
    }
    await ctx.reply('No pude validar la vinculacion con ExpenseLog. Proba de nuevo.');
    return false;
};
const hasRequiredAmount = (amount) => (typeof amount === 'number' && Number.isFinite(amount) && amount !== 0);
const mustHaveRequired = (r) => Boolean(r.type &&
    hasRequiredAmount(r.amount) &&
    r.datetime_iso &&
    r.counterparty);
const getOverallConfidence = (r) => {
    const value = Number(r?.confidence?.overall);
    return Number.isFinite(value) ? value : undefined;
};

const shouldPreferAICandidate = (nativeParsed, aiParsed) => {
    const nativeRequired = mustHaveRequired(nativeParsed);
    const aiRequired = mustHaveRequired(aiParsed);
    if (aiRequired && !nativeRequired)
        return true;
    if (!aiRequired)
        return false;
    const nativeConfidence = getOverallConfidence(nativeParsed);
    const aiConfidence = getOverallConfidence(aiParsed);
    if (typeof aiConfidence === 'number' && typeof nativeConfidence !== 'number')
        return true;
    if (typeof aiConfidence === 'number' && typeof nativeConfidence === 'number') {
        return aiConfidence >= nativeConfidence;
    }
    return !nativeRequired;
};
const buildAITextFromDraft = (parsed) => {
    const excerpt = String(parsed?.raw_text_excerpt || '').trim();
    if (excerpt)
        return excerpt;
    const bits = [
        parsed?.counterparty ? `Contraparte: ${parsed.counterparty}` : '',
        hasRequiredAmount(parsed?.amount) ? `Monto: ${parsed.amount}` : '',
        parsed?.datetime_iso ? `Fecha y hora: ${parsed.datetime_iso}` : '',
        parsed?.reference ? `Referencia: ${parsed.reference}` : '',
        parsed?.motive ? `Motivo: ${parsed.motive}` : ''
    ].filter(Boolean);
    return bits.join('\n');
};
const normalizeCounterparty = (value) => (String(value || '').trim().toLowerCase().replace(/\s+/g, ' '));
const dedupeKey = (r) => (`${r.type || 'unknown'}|${hasRequiredAmount(r.amount) ? Math.abs(r.amount).toFixed(2) : '0'}|${normalizeCounterparty(r.counterparty)}`);
const isWithin24Hours = (aIso, bIso) => {
    const aMs = Date.parse(String(aIso || ''));
    const bMs = Date.parse(String(bIso || ''));
    if (!Number.isFinite(aMs) || !Number.isFinite(bMs))
        return false;
    const diffMs = Math.abs(aMs - bMs);
    return diffMs <= (24 * 60 * 60 * 1000);
};
const latestDraftByUser = async (telegramUserId) => (prisma.receiptDraft.findFirst({ where: { telegramUserId }, orderBy: { updatedAt: 'desc' } }));
const findDraftByIDForUser = async (telegramUserId, draftId) => {
    const safeDraftId = String(draftId || '').trim();
    if (!safeDraftId) {
        return null;
    }
    return prisma.receiptDraft.findFirst({
        where: {
            id: safeDraftId,
            telegramUserId
        }
    });
};
const buildReceiptMessageKey = (telegramUserId, chatId, messageId) => (`${telegramUserId}:${chatId}:${messageId}`);
const answerCallback = async (ctx) => {
    if (typeof ctx.answerCbQuery !== 'function')
        return;
    await ctx.answerCbQuery().catch(() => undefined);
};
const findFallbackDuplicateByTimeWindow = async (telegramUserId, parsed) => {
    const candidates = await prisma.receiptDraft.findMany({
        where: {
            telegramUserId,
            dedupeKey: dedupeKey(parsed),
            status: 'confirmed'
        },
        orderBy: { updatedAt: 'desc' },
        take: 25
    });
    for (const candidate of candidates) {
        const candidateResult = toReceiptParseResult(candidate.parseResultJson);
        if (isWithin24Hours(candidateResult.datetime_iso, parsed.datetime_iso)) {
            return candidate;
        }
    }
    return null;
};
const findRecentMediaDraftForConversation = async (telegramUserId, chatId) => {
    const since = new Date(Date.now() - AUTO_TEXT_RECEIPT_SUPPRESSION_MS);
    return prisma.receiptDraft.findFirst({
        where: {
            telegramUserId,
            chatId,
            fileType: { in: ['image', 'pdf'] },
            createdAt: { gte: since }
        },
        orderBy: { createdAt: 'desc' }
    });
};
const mapLinkErrorToMessage = (error) => {
    if (error.code === 'invalid_link_code')
        return 'El codigo no es valido. Revisalo e intenta de nuevo.';
    if (error.code === 'link_code_expired')
        return 'Ese codigo ya vencio. Genera uno nuevo desde ExpenseLog.';
    if (error.code === 'link_code_used')
        return 'Ese codigo ya fue usado. Genera uno nuevo.';
    if (error.code === 'premium_required')
        return 'Necesitas Premium activo para vincular Telegram.';
    if (error.code === 'already_linked')
        return 'Tu cuenta de ExpenseLog ya esta vinculada a otro Telegram.';
    if (error.code === 'telegram_already_linked')
        return 'Este Telegram ya esta vinculado a otra cuenta.';
    if (error.status === 401)
        return 'No pude autenticar el bot contra ExpenseLog.';
    return error.message || 'No pude completar la vinculacion en este momento.';
};
const normalizeLinkCode = (raw) => {
    const compact = String(raw || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
    if (compact.length !== 8)
        return '';
    return `${compact.slice(0, 4)}-${compact.slice(4)}`;
};
const buildAIParserURLForDiag = () => {
    const base = String(config.aiParserBaseUrl || '').trim().replace(/\/+$/, '');
    const pathRaw = String(config.aiParserParsePath || '/api/parse').trim();
    const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
    if (!base) {
        return '';
    }
    return `${base}${path}`;
};
const formatDiagError = (error) => {
    const parts = [];
    const name = String(error?.name || '').trim();
    const message = String(error?.message || '').trim();
    if (name || message) {
        parts.push(`${name || 'Error'}: ${message || 'sin mensaje'}`);
    }
    const cause = error?.cause;
    if (cause) {
        const causeName = String(cause?.name || '').trim();
        const causeMessage = String(cause?.message || '').trim();
        const causeCode = String(cause?.code || '').trim();
        const causeHost = String(cause?.hostname || '').trim();
        const causePort = String(cause?.port || '').trim();
        const details = [
            causeName ? `cause=${causeName}` : '',
            causeMessage ? `msg=${causeMessage}` : '',
            causeCode ? `code=${causeCode}` : '',
            causeHost ? `host=${causeHost}` : '',
            causePort ? `port=${causePort}` : ''
        ].filter(Boolean);
        if (details.length > 0) {
            parts.push(details.join(' '));
        }
    }
    return parts.join(' | ') || 'Error desconocido';
};
const fetchWithTimeout = async (url, init, timeoutMs) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timeoutHandle);
    }
};
const runAIDiagnostics = async () => {
    const parseURL = buildAIParserURLForDiag();
    const baseURL = String(config.aiParserBaseUrl || '').trim().replace(/\/+$/, '');
    const healthURL = baseURL ? `${baseURL}/healthz` : '';
    const timeoutMs = Number(config.aiParserTimeoutMs) || 8000;
    const enabled = Boolean(config.aiParserFallbackEnabled);
    const results = {
        enabled,
        parseURL,
        healthURL,
        timeoutMs,
        minConfidence: config.aiParserMinConfidence,
        textEnabled: config.aiParserTextEnabled,
        apiKeyHeader: config.aiParserApiKeyHeader || 'X-API-Key',
        health: { ok: false, status: null, detail: '' },
        parse: { ok: false, status: null, detail: '' }
    };

    if (!enabled) {
        results.health.detail = 'fallback deshabilitado por config';
        results.parse.detail = 'fallback deshabilitado por config';
        return results;
    }
    if (!parseURL || !healthURL) {
        results.health.detail = 'URL del parser no configurada';
        results.parse.detail = 'URL del parser no configurada';
        return results;
    }

    try {
        const healthRes = await fetchWithTimeout(healthURL, { method: 'GET' }, timeoutMs);
        results.health.status = healthRes.status;
        const raw = await healthRes.text();
        const detail = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        results.health.ok = healthRes.ok;
        results.health.detail = detail || '(sin body)';
    }
    catch (error) {
        results.health.detail = formatDiagError(error);
    }

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (config.aiParserApiKey) {
            headers[config.aiParserApiKeyHeader || 'X-API-Key'] = config.aiParserApiKey;
        }
        const body = JSON.stringify({
            text: 'pague 1234 en supermercado hoy',
            context_date: new Date().toISOString()
        });
        const parseRes = await fetchWithTimeout(parseURL, { method: 'POST', headers, body }, timeoutMs);
        results.parse.status = parseRes.status;
        const raw = await parseRes.text();
        const detail = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        results.parse.ok = parseRes.ok;
        results.parse.detail = detail || '(sin body)';
    }
    catch (error) {
        results.parse.detail = formatDiagError(error);
    }

    return results;
};
const extractLinkCodeFromStartPayload = (payload) => {
    const raw = String(payload || '').trim();
    if (!raw)
        return '';
    const normalized = raw.toLowerCase();
    if (!normalized.startsWith('vincular_'))
        return '';
    return normalizeLinkCode(raw.slice('vincular_'.length));
};
const extractStartPayloadFromCommandText = (text) => {
    const raw = String(text || '').trim();
    if (!raw)
        return '';
    const parts = raw.split(/\s+/, 2);
    if (parts.length < 2)
        return '';
    if (!parts[0].toLowerCase().startsWith('/start'))
        return '';
    return String(parts[1] || '').trim();
};
const buildBotTags = (ruleTags) => {
    const safeRuleTags = Array.isArray(ruleTags)
        ? ruleTags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
        : [];
    return Array.from(new Set([...safeRuleTags, 'telegram_bot']));
};
const decisionKeyboardForDraftStatus = (status, draftId) => (status === DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
    ? dedupeKeyboard(draftId)
    : mainDecisionKeyboard(draftId));
export const buildBot = () => {
    const bot = new Telegraf(config.telegramBotToken);
    const consumeLinkCodeForCtx = async (ctx, codeInput) => {
        if (!multiUserLinkingEnabled) {
            await ctx.reply('La vinculacion por codigo no esta habilitada en este entorno.');
            return;
        }
        const code = normalizeLinkCode(codeInput);
        if (!code) {
            await ctx.reply('Uso correcto: /vincular TU-CODIGO');
            return;
        }
        try {
            await expenselogClient.consumeLinkCode({
                code,
                telegram_user_id: ctx.from.id,
                telegram_username: ctx.from.username
            });
            linkStatusCache.set(ctx.from.id, {
                expiresAt: Date.now() + LINK_STATUS_CACHE_TTL_MS,
                value: { ok: true, reason: 'ok' }
            });
            await ctx.reply('Listo. Tu cuenta quedo vinculada. Ya puedes enviar comprobantes para cargarlos en ExpenseLog.');
        }
        catch (error) {
            if (error instanceof ExpenseLogAPIError) {
                await ctx.reply(mapLinkErrorToMessage(error));
                return;
            }
            logger.error('telegram_link_failed', { error, telegramUserId: ctx.from.id });
            await ctx.reply('No pude completar la vinculacion ahora. Intenta de nuevo en unos minutos.');
        }
    };
    const processTextTransactionForCtx = async (ctx, rawText, origin) => {
        if (!canUseAIParser()) {
            await ctx.reply('El parser AI para texto no esta habilitado en este entorno.');
            return;
        }
        await ctx.reply('Recibido. Estoy analizando tu transaccion...');
        const telegramUserId = BigInt(ctx.from.id);
        const telegramMeta = {
            chat_id: ctx.chat.id,
            message_id: ctx.message.message_id,
            file_id: `text:${ctx.message.message_id}`,
            file_unique_id: `text:${ctx.from.id}:${ctx.message.message_id}`
        };
        try {
            let parsed = await parseWithAIParser({
                text: rawText,
                fileType: 'text',
                telegramMeta,
                nativeResult: null
            });
            parsed = normalizeParsedTransaction(parsed);
            let rulesDb = [];
            try {
                rulesDb = await prisma.userRule.findMany({
                    where: { telegramUserId, enabled: true },
                    orderBy: { priority: 'asc' }
                });
            }
            catch (error) {
                logger.warn('user_rules_load_failed', { telegramUserId: String(telegramUserId), error });
            }
            parsed.rule_output = applyRules(parsed, rulesDb.map((r) => ({
                enabled: r.enabled,
                priority: r.priority,
                when: r.whenJson,
                then: r.thenJson
            })));
            parseResults.inc({ status: 'ok_text_ai' });
            const probableDuplicate = parsed.reference
                ? await prisma.receiptDraft.findFirst({
                    where: {
                        telegramUserId,
                        reference: parsed.reference,
                        status: 'confirmed'
                    }
                })
                : await findFallbackDuplicateByTimeWindow(telegramUserId, parsed);
            const draft = await prisma.receiptDraft.create({
                data: {
                    telegramUserId,
                    chatId: BigInt(ctx.chat.id),
                    messageId: ctx.message.message_id,
                    fileId: `text:${ctx.message.message_id}`,
                    fileUniqueId: `text:${ctx.from.id}:${ctx.message.message_id}`,
                    fileType: 'text',
                    status: probableDuplicate ? DRAFT_STATUS.AWAITING_DUPLICATE_DECISION : (mustHaveRequired(parsed) ? DRAFT_STATUS.AWAITING_CONFIRM : DRAFT_STATUS.AWAITING_FIX),
                    parseResultJson: parsed,
                    dedupeKey: dedupeKey(parsed),
                    reference: parsed.reference
                }
            });
            if (probableDuplicate) {
                await ctx.reply(`Detecte una posible carga duplicada. Quieres crearla igual?\n\n${draftSummary(parsed)}`, { parse_mode: 'Markdown', ...dedupeKeyboard(draft.id) });
            }
            else {
                await ctx.reply(draftSummary(parsed), { parse_mode: 'Markdown', ...mainDecisionKeyboard(draft.id) });
            }
            logger.info('draft_created_from_text', { id: draft.id, origin });
        }
        catch (error) {
            parseResults.inc({ status: 'fail_text_ai' });
            logger.warn('text_ai_parse_failed', { error, origin });
            const errorCode = String(error?.code || error?.cause?.code || '').trim().toUpperCase();
            if (errorCode === 'AI_PARSER_TEMP_UNAVAILABLE' || errorCode === 'ECONNREFUSED') {
                await ctx.reply('El parser AI esta temporalmente dormido o no disponible. Prueba de nuevo en 1 o 2 minutos, o envia una imagen/PDF.');
                return;
            }
            await ctx.reply('No pude procesar ese texto con parser AI. Prueba reformularlo o envia una imagen/PDF.');
        }
    };
    const mergePlainTextIntoRecentMediaDraftForCtx = async (ctx, rawText) => {
        const telegramUserId = BigInt(ctx.from.id);
        const chatId = BigInt(ctx.chat.id);
        await sleep(AUTO_TEXT_RECEIPT_GRACE_MS);
        const recentMediaDraft = await findRecentMediaDraftForConversation(telegramUserId, chatId);
        if (!recentMediaDraft || !canResolveDraft(recentMediaDraft.status, EDITABLE_DRAFT_STATUSES)) {
            return false;
        }
        const parsed = mergeExplicitUserTextIntoParsed(toReceiptParseResult(recentMediaDraft.parseResultJson), rawText);
        const nextStatus = recentMediaDraft.status === DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
            ? DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
            : (mustHaveRequired(parsed) ? DRAFT_STATUS.AWAITING_CONFIRM : DRAFT_STATUS.AWAITING_FIX);
        await prisma.receiptDraft.update({
            where: { id: recentMediaDraft.id },
            data: {
                parseResultJson: parsed,
                status: nextStatus,
                dedupeKey: dedupeKey(parsed),
                reference: parsed.reference
            }
        });
        draftResults.inc({ status: 'caption_merged' });
        await ctx.reply(draftSummary(parsed), { parse_mode: 'Markdown', ...decisionKeyboardForDraftStatus(nextStatus, recentMediaDraft.id) });
        return true;
    };
    const shouldSuppressAutoTextForCtx = async (ctx) => {
        const telegramUserId = BigInt(ctx.from.id);
        const chatId = BigInt(ctx.chat.id);
        await sleep(AUTO_TEXT_RECEIPT_GRACE_MS);
        const nowMs = Date.now();
        const recentActivity = getRecentReceiptActivity(recentReceiptActivity, {
            telegramUserId,
            chatId,
            nowMs,
            windowMs: AUTO_TEXT_RECEIPT_SUPPRESSION_MS
        });
        let recentMediaDraftCreatedAtMs;
        try {
            const recentMediaDraft = await findRecentMediaDraftForConversation(telegramUserId, chatId);
            if (recentMediaDraft?.createdAt instanceof Date) {
                recentMediaDraftCreatedAtMs = recentMediaDraft.createdAt.getTime();
            }
        }
        catch (error) {
            logger.warn('recent_media_draft_lookup_failed', { telegramUserId: String(telegramUserId), chatId: String(chatId), error });
        }
        const shouldSuppress = shouldSuppressAutoTextFromRecentReceipt({
            recentActivity,
            recentMediaDraftCreatedAtMs,
            nowMs
        });
        if (shouldSuppress) {
            logger.info('plain_text_ignored_due_to_recent_receipt', {
                telegramUserId: String(telegramUserId),
                chatId: String(chatId),
                messageId: ctx.message?.message_id,
                recentActivityPhase: recentActivity?.phase || '',
                recentActivityMessageId: recentActivity?.messageId || null
            });
        }
        return shouldSuppress;
    };
    bot.start(async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        const rawStartPayload = String(ctx.startPayload || extractStartPayloadFromCommandText(String(ctx.message?.text || ''))).trim();
        const startPayloadCode = extractLinkCodeFromStartPayload(rawStartPayload);
        if (startPayloadCode) {
            await consumeLinkCodeForCtx(ctx, startPayloadCode);
            return;
        }
        await ctx.reply('Hola. Puedo cargar gastos e ingresos desde comprobantes.\n' +
            'Si es tu primera vez, primero vincula tu cuenta con: /vincular TU-CODIGO\n' +
            'Luego envia una imagen o un PDF del comprobante.');
    });
    bot.help(async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        await ctx.reply('Comandos disponibles:\n' +
            '/vincular TU-CODIGO -> Vincula Telegram con tu cuenta Premium.\n\n' +
            '/cargar TEXTO -> Carga un movimiento desde texto libre.\n\n' +
            '/diag_ai -> Diagnostica conexion con parser AI.\n\n' +
            'Flujo recomendado:\n' +
            '1) Enviar comprobante.\n' +
            '2) Revisar el resumen.\n' +
            '3) Confirmar o corregir datos.');
    });
    bot.command('diag_ai', async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        await ctx.reply('Ejecutando diagnostico AI (health + parse)...');
        const diag = await runAIDiagnostics();
        const parseURL = diag.parseURL || '(no configurada)';
        const healthURL = diag.healthURL || '(no configurada)';
        const message = [
            'Diagnostico AI parser',
            `enabled: ${diag.enabled}`,
            `base health URL: ${healthURL}`,
            `parse URL: ${parseURL}`,
            `timeoutMs: ${diag.timeoutMs}`,
            `minConfidence: ${diag.minConfidence}`,
            `textEnabled: ${diag.textEnabled}`,
            `apiKeyHeader: ${diag.apiKeyHeader}`,
            `healthz: ${diag.health.ok ? 'OK' : 'FAIL'}${diag.health.status != null ? ` (status ${diag.health.status})` : ''}`,
            `health detail: ${diag.health.detail || '-'}`,
            `parse: ${diag.parse.ok ? 'OK' : 'FAIL'}${diag.parse.status != null ? ` (status ${diag.parse.status})` : ''}`,
            `parse detail: ${diag.parse.detail || '-'}`
        ].join('\n');
        await ctx.reply(message);
    });
    bot.command('vincular', async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        const text = String(ctx.message?.text || '').trim();
        const parts = text.split(/\s+/);
        const code = String(parts[1] || '').trim();
        await consumeLinkCodeForCtx(ctx, code);
    });
    bot.command('cargar', async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        const text = String(ctx.message?.text || '').trim();
        const match = text.match(/^\/cargar(?:@\w+)?\s+([\s\S]+)/i);
        const payload = String(match?.[1] || '').trim();
        if (!payload) {
            await ctx.reply('Uso: /cargar <descripcion de la transaccion>\nEjemplo: /cargar pague 1600 en super hoy 20:55');
            return;
        }
        if (!(await requireLinkedPremium(ctx)))
            return;
        await processTextTransactionForCtx(ctx, payload, 'command_cargar');
    });
    bot.on('text', async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        const hasMediaAttachment = Boolean(ctx.message?.photo?.length || ctx.message?.document || ctx.message?.video || ctx.message?.animation || ctx.message?.sticker || ctx.message?.voice);
        if (hasMediaAttachment) {
            logger.info('text_message_ignored_due_to_media_attachment', {
                chatId: ctx.chat?.id,
                messageId: ctx.message?.message_id
            });
            return;
        }
        const rawText = String(ctx.message?.text || '').trim();
        if (rawText.startsWith('/vincular'))
            return;
        if (/^\/cargar(?:@\w+)?(?:\s+|$)/i.test(rawText))
            return;
        const pending = getPendingFixState(ctx.from.id);
        if (!pending) {
            if (await mergePlainTextIntoRecentMediaDraftForCtx(ctx, rawText)) {
                return;
            }
            if (!config.aiParserTextEnabled) {
                return;
            }
            if (await shouldSuppressAutoTextForCtx(ctx)) {
                return;
            }
            if (!(await requireLinkedPremium(ctx)))
                return;
            await processTextTransactionForCtx(ctx, rawText, 'plain_text');
            return;
        }
        if (!(await requireLinkedPremium(ctx)))
            return;
        const telegramUserId = BigInt(ctx.from.id);
        const field = pending.field;
        const draft = pending.draftId
            ? await findDraftByIDForUser(telegramUserId, pending.draftId)
            : await latestDraftByUser(telegramUserId);
        if (!draft)
            return;
        const parsed = toReceiptParseResult(draft.parseResultJson);
        let value = rawText;
        if (field === 'type') {
            const parsedType = parseTypeInput(value);
            if (!parsedType) {
                await ctx.reply('No entendi el tipo. Escribe "gasto", "ingreso" o "reintegro".');
                return;
            }
            value = parsedType;
        }
        const nextStatus = draft.status === DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
            ? DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
            : DRAFT_STATUS.AWAITING_CONFIRM;
        const correction = buildDraftCorrectionUpdate(parsed, field, value, nextStatus);
        if (correction.error === 'invalid_payment_method') {
            await ctx.reply('No entendi el metodo. Escribe: "transferencia", "efectivo" o "tarjeta credito".');
            return;
        }
        if (!canResolveDraft(draft.status, EDITABLE_DRAFT_STATUSES)) {
            pendingFix.delete(ctx.from.id);
            return;
        }
        await prisma.receiptDraft.update({
            where: { id: draft.id },
            data: correction.data
        });
        pendingFix.delete(ctx.from.id);
        draftResults.inc({ status: 'corrected' });
        await ctx.reply(draftSummary(correction.parsed), { parse_mode: 'Markdown', ...decisionKeyboardForDraftStatus(nextStatus, draft.id) });
    });
    bot.on(['photo', 'document'], async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx)))
            return;
        receiptsReceived.inc();
        const stopTotal = stageLatency.startTimer({ stage: 'handler_receipt_total' });
        const message = ctx.message;
        const doc = message?.document;
        const photo = message?.photo?.at(-1);
        const fileType = doc ? 'pdf' : 'image';
        if (doc && doc.mime_type !== 'application/pdf') {
            await ctx.reply('Si envias como documento, debe ser PDF. Si prefieres, envialo como imagen.');
            return;
        }
        const fileId = doc?.file_id ?? photo?.file_id;
        const fileUniqueId = doc?.file_unique_id ?? photo?.file_unique_id;
        if (!fileId || !fileUniqueId)
            return;
        const telegramUserId = BigInt(ctx.from.id);
        const chatId = BigInt(ctx.chat.id);
        const messageId = ctx.message.message_id;
        const receiptMessageKey = buildReceiptMessageKey(telegramUserId, chatId, messageId);
        if (inFlightReceiptMessages.has(receiptMessageKey)) {
            logger.info('receipt_message_deduped_inflight', { receiptMessageKey });
            return;
        }
        inFlightReceiptMessages.add(receiptMessageKey);
        markRecentReceiptActivity(recentReceiptActivity, {
            telegramUserId,
            chatId,
            messageId,
            phase: 'processing'
        });
        const link = await ctx.telegram.getFileLink(fileId);
        const ext = fileType === 'pdf' ? 'pdf' : 'jpg';
        const tempPath = await tempPathFor(ext);
        let createdDraft = null;
        try {
            const existingDraft = await prisma.receiptDraft.findFirst({
                where: {
                    telegramUserId,
                    chatId,
                    messageId
                },
                orderBy: { createdAt: 'desc' }
            });
            if (existingDraft) {
                logger.info('receipt_message_deduped_existing', {
                    receiptMessageKey,
                    existingDraftId: existingDraft.id
                });
                return;
            }
            const stopDownload = stageLatency.startTimer({ stage: 'telegram_download' });
            try {
                const res = await fetch(link.toString());
                const buff = Buffer.from(await res.arrayBuffer());
                await writeFile(tempPath, buff);
            }
            finally {
                stopDownload();
            }
            const telegramMeta = {
                chat_id: ctx.chat.id,
                message_id: ctx.message.message_id,
                file_id: fileId,
                file_unique_id: fileUniqueId
            };
            const processed = await processReceipt({
                filePath: tempPath,
                fileType,
                telegramMeta,
                userText: message?.caption
            });
            const parsed = processed?.result ?? processed;
            const fallbackInfo = processed?.fallback;
            parsed.source_app = normalizePaymentMethod(parsed.source_app);
            parsed.currency = normalizeCurrency(parsed.currency);
            let rulesDb = [];
            try {
                rulesDb = await prisma.userRule.findMany({
                    where: { telegramUserId, enabled: true },
                    orderBy: { priority: 'asc' }
                });
            }
            catch (error) {
                logger.warn('user_rules_load_failed', { telegramUserId: String(telegramUserId), error });
            }
            parsed.rule_output = applyRules(parsed, rulesDb.map((r) => ({
                enabled: r.enabled,
                priority: r.priority,
                when: r.whenJson,
                then: r.thenJson
            })));
            const parseStatus = fallbackInfo?.used
                ? 'ok_fallback_ai'
                : (fallbackInfo?.attempted ? 'ok_fallback_native' : 'ok');
            parseResults.inc({ status: parseStatus });
            const probableDuplicate = parsed.reference
                ? await prisma.receiptDraft.findFirst({
                    where: {
                        telegramUserId,
                        reference: parsed.reference,
                        status: 'confirmed'
                    }
                })
                : await findFallbackDuplicateByTimeWindow(telegramUserId, parsed);
            const draft = await prisma.receiptDraft.create({
                data: {
                    telegramUserId,
                    chatId,
                    messageId,
                    fileId,
                    fileUniqueId,
                    fileType,
                    status: probableDuplicate ? DRAFT_STATUS.AWAITING_DUPLICATE_DECISION : (mustHaveRequired(parsed) ? DRAFT_STATUS.AWAITING_CONFIRM : DRAFT_STATUS.AWAITING_FIX),
                    parseResultJson: parsed,
                    dedupeKey: dedupeKey(parsed),
                    reference: parsed.reference
                }
            });
            createdDraft = draft;
            markRecentReceiptActivity(recentReceiptActivity, {
                telegramUserId,
                chatId,
                messageId,
                phase: 'draft_created'
            });
            if (probableDuplicate) {
                await ctx.reply(`Detecte una posible carga duplicada. Quieres crearla igual?\n\n${draftSummary(parsed)}`, { parse_mode: 'Markdown', ...dedupeKeyboard(draft.id) });
            }
            else {
                await ctx.reply(draftSummary(parsed), { parse_mode: 'Markdown', ...mainDecisionKeyboard(draft.id) });
            }
            logger.info('draft_created', { id: draft.id, awaitingExplicitDecision: true, duplicate: Boolean(probableDuplicate) });
        }
        catch (error) {
            if (!createdDraft) {
                parseResults.inc({ status: 'fail' });
                logger.error('processing_failed', { error, phase: 'pre_draft' });
                await ctx.reply('No pude leer bien el comprobante. Prueba con otra imagen mas nitida o envia el PDF.');
            }
            else {
                logger.error('processing_failed', { error, phase: 'post_draft', draftId: createdDraft.id });
                await ctx.reply('Pude leer el comprobante y el borrador ya existe, pero fallo un paso posterior. No reenvies el mismo comprobante; usa el borrador actual.');
            }
        }
        finally {
            inFlightReceiptMessages.delete(receiptMessageKey);
            await safeDelete(tempPath);
            stopTotal();
        }
    });
    bot.action(/^fix_menu:[0-9a-f-]+$/i, async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx)))
            return;
        await answerCallback(ctx);
        const action = parseDraftAction(ctx.callbackQuery?.data, 'fix_menu');
        if (!action)
            return;
        await ctx.editMessageReplyMarkup(fixMenuKeyboard(action.draftId).reply_markup);
    });
    bot.action(/^back_summary:[0-9a-f-]+$/i, async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx)))
            return;
        await answerCallback(ctx);
        const action = parseDraftAction(ctx.callbackQuery?.data, 'back_summary');
        if (!action)
            return;
        await ctx.editMessageReplyMarkup(mainDecisionKeyboard(action.draftId).reply_markup);
    });
    for (const { field, action } of [
        { field: 'amount', action: 'amount' },
        { field: 'datetime_iso', action: 'datetime' },
        { field: 'counterparty', action: 'counterparty' },
        { field: 'type', action: 'type' },
        { field: 'source_app', action: 'source' },
        { field: 'motive', action: 'motive' }
    ]) {
        bot.action(new RegExp(`^fix_${action}:[0-9a-f-]+$`, 'i'), async (ctx) => {
            if (!(await ensurePrivateAllowed(ctx)))
                return;
            if (!(await requireLinkedPremium(ctx)))
                return;
            await answerCallback(ctx);
            const parsedAction = parseDraftAction(ctx.callbackQuery?.data, `fix_${action}`);
            if (!parsedAction)
                return;
            const draft = await findDraftByIDForUser(BigInt(ctx.from.id), parsedAction.draftId);
            if (!draft || !canResolveDraft(draft.status, EDITABLE_DRAFT_STATUSES)) {
                await ctx.reply('Este borrador ya fue resuelto y no se puede modificar.');
                return;
            }
            pendingFix.set(ctx.from.id, { field, draftId: parsedAction.draftId });
            const prompt = fieldPromptByKey[field];
            const hintLine = prompt?.hint ? `\n${prompt.hint}` : '';
            await ctx.reply(`Escribe el nuevo valor para ${prompt?.label ?? 'este campo'}.${hintLine}`);
        });
    }
    bot.action(/^fix_retry_ai:[0-9a-f-]+$/i, async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx)))
            return;
        await answerCallback(ctx);
        if (!canUseAIParser()) {
            await ctx.reply('El parser AI no esta habilitado en este entorno.');
            return;
        }
        const action = parseDraftAction(ctx.callbackQuery?.data, 'fix_retry_ai');
        if (!action)
            return;
        const telegramUserId = BigInt(ctx.from.id);
        const draft = await findDraftByIDForUser(telegramUserId, action.draftId);
        if (!draft) {
            await ctx.reply('No encontre un borrador reciente para mejorar.');
            return;
        }
        if (!canResolveDraft(draft.status, EDITABLE_DRAFT_STATUSES)) {
            await ctx.reply('Este borrador ya fue resuelto y no se puede reintentar.');
            return;
        }
        const parsed = toReceiptParseResult(draft.parseResultJson);
        const aiInputText = buildAITextFromDraft(parsed);
        if (!aiInputText) {
            await ctx.reply('No hay texto suficiente para reintentar con AI.');
            return;
        }
        await ctx.reply('Reintentando con parser AI...');
        try {
            const aiParsed = await parseWithAIParser({
                text: aiInputText,
                fileType: draft.fileType || 'image',
                telegramMeta: parsed?.telegram_meta || {
                    chat_id: ctx.chat?.id,
                    message_id: draft.messageId
                },
                nativeResult: parsed
            });
            aiParsed.source_app = normalizePaymentMethod(aiParsed.source_app);
            aiParsed.currency = normalizeCurrency(aiParsed.currency);
            let rulesDb = [];
            try {
                rulesDb = await prisma.userRule.findMany({
                    where: { telegramUserId, enabled: true },
                    orderBy: { priority: 'asc' }
                });
            }
            catch (error) {
                logger.warn('user_rules_load_failed', { telegramUserId: String(telegramUserId), error });
            }
            aiParsed.rule_output = applyRules(aiParsed, rulesDb.map((r) => ({
                enabled: r.enabled,
                priority: r.priority,
                when: r.whenJson,
                then: r.thenJson
            })));

            const useAI = shouldPreferAICandidate(parsed, aiParsed);
            const finalParsed = useAI ? aiParsed : parsed;
            await prisma.receiptDraft.update({
                where: { id: draft.id },
                data: {
                    status: mustHaveRequired(finalParsed) ? DRAFT_STATUS.AWAITING_CONFIRM : DRAFT_STATUS.AWAITING_FIX,
                    parseResultJson: finalParsed,
                    dedupeKey: dedupeKey(finalParsed),
                    reference: finalParsed.reference
                }
            });
            parseResults.inc({ status: useAI ? 'ok_fix_ai_used' : 'ok_fix_ai_native_kept' });
            if (finalParsed === aiParsed) {
                await ctx.reply('Listo, aplique la mejora con AI.');
            }
            else {
                await ctx.reply('AI no mejoro el borrador. Mantengo la version actual.');
            }
            await ctx.reply(draftSummary(finalParsed), { parse_mode: 'Markdown', ...mainDecisionKeyboard(draft.id) });
        }
        catch (error) {
            parseResults.inc({ status: 'fail_fix_ai' });
            logger.warn('fix_retry_ai_failed', { error, telegramUserId: String(telegramUserId) });
            await ctx.reply('No pude completar el reintento AI en este momento. Intenta de nuevo en unos segundos.');
        }
    });
    bot.action(/^reject:[0-9a-f-]+$/i, async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx)))
            return;
        await answerCallback(ctx);
        const action = parseDraftAction(ctx.callbackQuery?.data, 'reject');
        if (!action)
            return;
        const draft = await findDraftByIDForUser(BigInt(ctx.from.id), action.draftId);
        if (!draft)
            return;
        const updated = await prisma.receiptDraft.updateMany({
            where: { id: draft.id, telegramUserId: BigInt(ctx.from.id), status: { in: REJECTABLE_DRAFT_STATUSES } },
            data: { status: DRAFT_STATUS.REJECTED }
        });
        if (updated.count !== 1)
            return;
        draftResults.inc({ status: DRAFT_STATUS.REJECTED });
        await ctx.reply('Listo, descarte este borrador.');
    });
    bot.action(/^dedupe_cancel:[0-9a-f-]+$/i, async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx)))
            return;
        await answerCallback(ctx);
        const action = parseDraftAction(ctx.callbackQuery?.data, 'dedupe_cancel');
        if (!action)
            return;
        const draft = await findDraftByIDForUser(BigInt(ctx.from.id), action.draftId);
        if (!draft)
            return;
        const updated = await prisma.receiptDraft.updateMany({
            where: { id: draft.id, telegramUserId: BigInt(ctx.from.id), status: { in: [DRAFT_STATUS.AWAITING_DUPLICATE_DECISION] } },
            data: { status: DRAFT_STATUS.REJECTED }
        });
        if (updated.count !== 1)
            return;
        draftResults.inc({ status: DRAFT_STATUS.REJECTED });
        await ctx.reply('Perfecto, no cree la carga duplicada.');
    });
    const createTransactionFromDraft = async (ctx, draft, source = 'manual', allowedStatuses = CONFIRMABLE_DRAFT_STATUSES) => {
        const parsed = toReceiptParseResult(draft.parseResultJson);
        if (isTerminalDraftStatus(draft.status) || !canResolveDraft(draft.status, allowedStatuses)) {
            return undefined;
        }
        if (!mustHaveRequired(parsed)) {
            const missing = getMissingRequiredLabels(parsed);
            await ctx.reply(`Faltan datos obligatorios: ${missing.join(', ')}.\nToca "Corregir datos" para completarlos.`);
            return undefined;
        }
        const claimed = await prisma.receiptDraft.updateMany({
            where: { id: draft.id, telegramUserId: BigInt(ctx.from.id), status: { in: allowedStatuses } },
            data: { status: DRAFT_STATUS.CONFIRMING }
        });
        if (claimed.count !== 1)
            return undefined;
        const stopCreateTx = stageLatency.startTimer({ stage: 'expenselog_create' });
        let created;
        const normalizedSource = normalizePaymentMethod(parsed.source_app);
        parsed.source_app = normalizedSource;
        const currency = normalizeCurrency(parsed.currency);
        const transactionTags = buildBotTags(parsed.rule_output?.tags);
        try {
            if (multiUserLinkingEnabled) {
                created = await expenselogClient.createBotExpense({
                    telegram_user_id: ctx.from.id,
                    type: parsed.type,
                    amount: parsed.amount,
                    currency,
                    datetime_iso: parsed.datetime_iso,
                    counterparty: parsed.counterparty,
                    reference: parsed.reference,
                    motive: parsed.motive,
                    category: parsed.rule_output?.category,
                    tags: transactionTags,
                    provider: normalizedSource,
                    source_meta: parsed.telegram_meta
                });
            }
            else {
                created = await expenselogClient.createTransaction({
                    type: parsed.type,
                    amount: parsed.amount,
                    currency,
                    datetime_iso: parsed.datetime_iso,
                    counterparty: parsed.counterparty,
                    reference: parsed.reference,
                    motive: parsed.motive,
                    category: parsed.rule_output?.category,
                    tags: transactionTags,
                    provider: normalizedSource,
                    source_meta: parsed.telegram_meta
                });
            }
        }
        catch (error) {
            if (error instanceof ExpenseLogAPIError) {
                if (error.code === 'not_linked') {
                    linkStatusCache.set(ctx.from.id, { expiresAt: Date.now() + LINK_STATUS_CACHE_TTL_MS, value: { ok: false, reason: 'not_linked' } });
                    await prisma.receiptDraft.update({ where: { id: draft.id }, data: { status: DRAFT_STATUS.FAILED } });
                    await ctx.reply('Tu cuenta ya no esta vinculada. Genera un nuevo codigo en ExpenseLog y usa /vincular TU-CODIGO.');
                    return undefined;
                }
                if (error.code === 'premium_required') {
                    linkStatusCache.set(ctx.from.id, { expiresAt: Date.now() + LINK_STATUS_CACHE_TTL_MS, value: { ok: false, reason: 'premium_required' } });
                    await prisma.receiptDraft.update({ where: { id: draft.id }, data: { status: DRAFT_STATUS.FAILED } });
                    await ctx.reply('Tu cuenta necesita Premium activo para confirmar comprobantes.');
                    return undefined;
                }
                await prisma.receiptDraft.update({ where: { id: draft.id }, data: { status: DRAFT_STATUS.FAILED } });
                await ctx.reply(error.message || 'No pude crear la transaccion en ExpenseLog.');
                return undefined;
            }
            logger.error('expenselog_create_failed', { error, source });
            await prisma.receiptDraft.update({ where: { id: draft.id }, data: { status: DRAFT_STATUS.FAILED } });
            await ctx.reply('No pude crear la transaccion en ExpenseLog.');
            return undefined;
        }
        finally {
            stopCreateTx();
        }
        await prisma.receiptDraft.update({
            where: { id: draft.id },
            data: {
                status: DRAFT_STATUS.CONFIRMED,
                expenselogTransactionId: created.transaction_id
            }
        });
        draftResults.inc({ status: DRAFT_STATUS.CONFIRMED });
        return created;
    };
    const confirmHandler = async (ctx, callbackAction) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx, true)))
            return;
        await answerCallback(ctx);
        const action = parseDraftAction(ctx.callbackQuery?.data, callbackAction);
        if (!action)
            return;
        const draft = await findDraftByIDForUser(BigInt(ctx.from.id), action.draftId);
        if (!draft)
            return;
        const allowedStatuses = callbackAction === 'dedupe_create_anyway' ? DUPLICATE_CONFIRMABLE_DRAFT_STATUSES : CONFIRMABLE_DRAFT_STATUSES;
        const created = await createTransactionFromDraft(ctx, draft, callbackAction === 'dedupe_create_anyway' ? 'dedupe_override' : 'manual', allowedStatuses);
        if (!created)
            return;
        await ctx.editMessageReplyMarkup(postConfirmKeyboard(created.url).reply_markup);
        await ctx.reply('✅ Listo. Ya cargue la transaccion.');
    };
    bot.action('post_cancel', async (ctx) => {
        if (!(await ensurePrivateAllowed(ctx)))
            return;
        if (!(await requireLinkedPremium(ctx)))
            return;
        await answerCallback(ctx);
        await ctx.reply('Entendido. Si quieres revertirla, puedes abrir la transaccion desde ExpenseLog y eliminarla manualmente.');
    });
    bot.action(/^confirm:[0-9a-f-]+$/i, async (ctx) => confirmHandler(ctx, 'confirm'));
    bot.action(/^dedupe_create_anyway:[0-9a-f-]+$/i, async (ctx) => confirmHandler(ctx, 'dedupe_create_anyway'));
    return bot;
};
