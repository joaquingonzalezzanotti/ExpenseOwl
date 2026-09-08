import { config } from '../config.js';
import { logger } from '../observability/logger.js';
const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const asNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};
const pickFirstString = (...values) => {
    for (const value of values) {
        const normalized = String(value ?? '').trim();
        if (normalized)
            return normalized;
    }
    return undefined;
};
const normalizeType = (value) => {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized)
        return undefined;
    if (['income', 'ingreso', 'entrada'].includes(normalized))
        return 'income';
    if (['refund', 'reintegro'].includes(normalized))
        return 'refund';
    if (['expense', 'gasto', 'egreso', 'salida'].includes(normalized))
        return 'expense';
    return undefined;
};
const normalizeCurrency = (value) => {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (['USD', 'US$', 'U$S'].includes(normalized))
        return 'USD';
    if (['EUR', '€'].includes(normalized))
        return 'EUR';
    if (['ARS', '$', 'PESO', 'PESOS'].includes(normalized))
        return 'ARS';
    return normalized || 'ARS';
};
const normalizeConfidence = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { overall: value };
    }
    if (isObject(value)) {
        const overall = asNumber(value.overall);
        if (typeof overall === 'number') {
            return { ...value, overall };
        }
    }
    return undefined;
};
const sanitizeExcerpt = (raw) => String(raw || '')
    .replace(/\b\d{10,22}\b/g, '[REDACTED_LONG_NUMBER]')
    .slice(0, 300);
export const normalizeAIParserResult = (payload, fallbackText, telegramMeta) => {
    const source = isObject(payload?.result)
        ? payload.result
        : isObject(payload?.parse_result)
            ? payload.parse_result
            : isObject(payload?.parsed)
                ? payload.parsed
                : isObject(payload)
                    ? payload
                    : null;
    if (!source) {
        throw new Error('AI parser returned an invalid payload');
    }
    const normalized = {
        source_app: pickFirstString(source.source_app, source.source, source.provider, source.payment_method, source.method),
        type: normalizeType(source.type ?? source.flow ?? source.direction ?? source.movement_type),
        amount: asNumber(source.amount ?? source.total ?? source.monto),
        currency: normalizeCurrency(pickFirstString(source.currency, source.moneda)),
        datetime_iso: pickFirstString(source.datetime_iso, source.date_time_iso, source.date_time, source.datetime, source.fecha_hora, source.date),
        counterparty: pickFirstString(source.counterparty, source.merchant, source.comercio, source.destination, source.destino, source.recipient),
        reference: pickFirstString(source.reference, source.ref, source.operation_id, source.comprobante),
        motive: pickFirstString(source.motive, source.description, source.concept, source.detalle),
        confidence: normalizeConfidence(source.confidence ?? source.score),
        raw_text_excerpt: pickFirstString(source.raw_text_excerpt, source.excerpt) || sanitizeExcerpt(fallbackText),
        telegram_meta: isObject(source.telegram_meta) ? source.telegram_meta : telegramMeta
    };
    if (isObject(source.rule_output)) {
        normalized.rule_output = source.rule_output;
    }
    return normalized;
};
const buildAIParserURL = () => {
    const base = String(config.aiParserBaseUrl || '').trim().replace(/\/+$/, '');
    const path = String(config.aiParserParsePath || '/api/parse').startsWith('/')
        ? String(config.aiParserParsePath || '/api/parse')
        : `/${String(config.aiParserParsePath || '/api/parse')}`;
    if (!base) {
        return '';
    }
    return `${base}${path}`;
};
const buildAIParserHealthURL = () => {
    const base = String(config.aiParserBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) {
        return '';
    }
    return `${base}/healthz`;
};
export const canUseAIParser = () => {
    return Boolean(config.aiParserFallbackEnabled && buildAIParserURL());
};
const RETRYABLE_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET'
]);
const AI_PARSER_RETRY_DELAYS_MS = [2000, 5000];
const AI_PARSER_HEALTHCHECK_RETRY_DELAYS_MS = [1500, 3000];
const AI_PARSER_COOLDOWN_MS = 120000;
let aiParserUnavailableUntil = 0;
const buildAIParserCooldownError = () => {
    const remainingMs = Math.max(0, aiParserUnavailableUntil - Date.now());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const error = new Error(`AI parser temporarily unavailable (${remainingSeconds}s remaining in cooldown)`);
    error.code = 'AI_PARSER_TEMP_UNAVAILABLE';
    return error;
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryableAIFetchError = (error) => {
    if (!error)
        return false;
    const message = String(error?.message || '').toLowerCase();
    const code = String(error?.code || error?.cause?.code || '').trim().toUpperCase();
    const name = String(error?.name || '').trim();
    if (name === 'AbortError')
        return true;
    if (RETRYABLE_ERROR_CODES.has(code))
        return true;
    if (message.includes('fetch failed') || message.includes('network') || message.includes('timed out')) {
        return true;
    }
    return false;
};
const ensureAIParserReady = async () => {
    const healthURL = buildAIParserHealthURL();
    if (!healthURL) {
        return;
    }
    let lastError = null;
    const timeoutMs = Math.min(config.aiParserTimeoutMs, 5000);
    const maxAttempts = AI_PARSER_HEALTHCHECK_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetchWithTimeout(healthURL, { method: 'GET' }, timeoutMs);
            if (!response.ok) {
                throw new Error(`AI parser healthz failed with status ${response.status}`);
            }
            if (attempt > 1) {
                logger.info('ai_parser_healthcheck_recovered', { healthURL, attempt });
            }
            return;
        }
        catch (error) {
            lastError = error;
            const retryable = isRetryableAIFetchError(error);
            logger.warn('ai_parser_healthcheck_failed', {
                healthURL,
                timeoutMs,
                attempt,
                maxAttempts,
                retryable,
                error: {
                    name: error?.name,
                    message: error?.message,
                    code: error?.code,
                    causeCode: error?.cause?.code
                }
            });
            if (!retryable || attempt >= maxAttempts) {
                throw error;
            }
            await sleep(AI_PARSER_HEALTHCHECK_RETRY_DELAYS_MS[attempt - 1] || 1000);
        }
    }
    throw lastError || new Error('AI parser healthcheck failed');
};
export const parseWithAIParser = async ({ text, fileType, telegramMeta, nativeResult }) => {
    const url = buildAIParserURL();
    if (!url) {
        throw new Error('AI parser URL is not configured');
    }
    if (aiParserUnavailableUntil > Date.now()) {
        throw buildAIParserCooldownError();
    }
    await ensureAIParserReady();
    const headers = {
        'Content-Type': 'application/json'
    };
    if (config.aiParserApiKey) {
        headers[config.aiParserApiKeyHeader || 'X-API-Key'] = config.aiParserApiKey;
    }
    const payload = {
        text,
        file_type: fileType,
        telegram_meta: telegramMeta,
        native_result: nativeResult
    };
    const maxAttempts = AI_PARSER_RETRY_DELAYS_MS.length + 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetchWithTimeout(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
            }, config.aiParserTimeoutMs);
            if (!response.ok) {
                throw new Error(`AI parser request failed with status ${response.status}`);
            }
            const data = await response.json();
            if (attempt > 1) {
                logger.info('ai_parser_request_recovered', { url, attempt });
            }
            aiParserUnavailableUntil = 0;
            return normalizeAIParserResult(data, text, telegramMeta);
        }
        catch (error) {
            lastError = error;
            const retryable = isRetryableAIFetchError(error);
            logger.warn('ai_parser_request_failed', {
                url,
                timeoutMs: config.aiParserTimeoutMs,
                attempt,
                maxAttempts,
                retryable,
                error: {
                    name: error?.name,
                    message: error?.message,
                    code: error?.code,
                    cause: error?.cause
                        ? {
                            name: error.cause?.name,
                            message: error.cause?.message,
                            code: error.cause?.code,
                            errno: error.cause?.errno,
                            syscall: error.cause?.syscall,
                            hostname: error.cause?.hostname,
                            address: error.cause?.address,
                            port: error.cause?.port
                        }
                        : undefined,
                    stack: error?.stack
                }
            });
            if (retryable && attempt >= maxAttempts) {
                aiParserUnavailableUntil = Date.now() + AI_PARSER_COOLDOWN_MS;
                logger.warn('ai_parser_circuit_opened', {
                    url,
                    cooldownMs: AI_PARSER_COOLDOWN_MS,
                    retryable,
                    error: {
                        message: error?.message,
                        code: error?.code,
                        causeCode: error?.cause?.code
                    }
                });
            }
            if (!retryable || attempt >= maxAttempts) {
                throw error;
            }
            await sleep(AI_PARSER_RETRY_DELAYS_MS[attempt - 1] || 1000);
        }
    }
    throw lastError || new Error('AI parser request failed');
};
