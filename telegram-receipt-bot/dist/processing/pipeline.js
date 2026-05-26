import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { ocrImage } from './ocr.js';
import { extractPdfText } from './pdf.js';
import { parseModoReceipt } from '../parsing/modo.js';
import { parseGaliciaReceipt } from '../parsing/galicia.js';
import { parseTransferReceipt } from '../parsing/transfer.js';
import { parseGenericReceipt } from '../parsing/generic.js';
import { safeDeleteMany } from './file.js';
import { stageLatency } from '../observability/metrics.js';
import { canUseAIParser, parseWithAIParser } from './ai_parser.js';

const hasRequiredFields = (parsed) => {
    if (!parsed || typeof parsed !== 'object')
        return false;
    const type = String(parsed.type || '').trim().toLowerCase();
    const hasType = type === 'expense' || type === 'income' || type === 'refund';
    const amount = Number(parsed.amount);
    const hasAmount = Number.isFinite(amount) && amount !== 0;
    const hasDateTime = String(parsed.datetime_iso || '').trim().length > 0;
    const hasCounterparty = String(parsed.counterparty || '').trim().length > 0;
    return hasType && hasAmount && hasDateTime && hasCounterparty;
};

const getOverallConfidence = (parsed) => {
    const value = Number(parsed?.confidence?.overall);
    return Number.isFinite(value) ? value : undefined;
};

const shouldTriggerAIFallback = (nativeParsed) => {
    if (!canUseAIParser()) {
        return { tryFallback: false, reason: 'ai_parser_disabled' };
    }
    if (Array.isArray(nativeParsed?.warnings) &&
        nativeParsed.warnings.some((warning) => String(warning || '').toLowerCase().includes('transferencia ambigua'))) {
        return { tryFallback: false, reason: 'ambiguous_self_transfer' };
    }
    if (!hasRequiredFields(nativeParsed)) {
        return { tryFallback: true, reason: 'missing_required_fields' };
    }
    const confidence = getOverallConfidence(nativeParsed);
    if (typeof confidence !== 'number') {
        return { tryFallback: true, reason: 'missing_confidence' };
    }
    if (typeof confidence === 'number' && confidence < config.aiParserMinConfidence) {
        return { tryFallback: true, reason: 'low_confidence' };
    }
    return { tryFallback: false, reason: 'not_needed' };
};

const shouldPreferAIResult = (nativeParsed, aiParsed) => {
    const nativeRequired = hasRequiredFields(nativeParsed);
    const aiRequired = hasRequiredFields(aiParsed);
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

const parseWithNativeParser = (text, input) => {
    if ((/Transferencia de/i.test(text) && /CBU\/CVU/i.test(text)) || (/MODO/i.test(text) && /(Pagaste a|Ref\.?)/i.test(text))) {
        return parseModoReceipt(text, config.myAliases, input.telegramMeta);
    }
    if (/Galicia/i.test(text) && /(Transferencia enviada|N[°ºo]\s+de operaci[oó]n)/i.test(text)) {
        return parseGaliciaReceipt(text, config.myAliases, input.telegramMeta);
    }
    if (/Comprobante de transferencia/i.test(text) || /(Mercado Pago|Fecha de ejecuci[oó]n|Destinatario)/i.test(text)) {
        return parseTransferReceipt(text, config.myAliases, input.telegramMeta);
    }
    return parseGenericReceipt(text, input.telegramMeta);
};

export const processReceipt = async (input) => {
    let text = '';
    const renderedImagePaths = [];
    const stopPipeline = stageLatency.startTimer({ stage: 'pipeline_total' });
    try {
        if (input.fileType === 'image') {
            text = await ocrImage(input.filePath);
        }
        else {
            const extraction = await extractPdfText(input.filePath);
            text = extraction.text;
            renderedImagePaths.push(...extraction.renderedImagePaths);
            if (text.trim().length < 30 && renderedImagePaths.length > 0) {
                for (const renderedImagePath of renderedImagePaths.slice(0, config.pdfRenderMaxPages)) {
                    text += `\n${await ocrImage(renderedImagePath)}`;
                }
            }
        }

        logger.info('receipt_text_processed', { excerpt: logger.sanitizeText(text) });
        const stopParse = stageLatency.startTimer({ stage: 'parse' });
        try {
            const nativeParsed = parseWithNativeParser(text, input);
            const fallbackDecision = shouldTriggerAIFallback(nativeParsed);
            if (!fallbackDecision.tryFallback) {
                return {
                    result: nativeParsed,
                    fallback: { attempted: false, used: false, reason: fallbackDecision.reason }
                };
            }

            if (typeof input.onFallbackAttempt === 'function') {
                try {
                    await input.onFallbackAttempt({ reason: fallbackDecision.reason, nativeResult: nativeParsed });
                }
                catch (error) {
                    logger.warn('ai_fallback_notify_failed', { error });
                }
            }

            try {
                const aiParsed = await parseWithAIParser({
                    text,
                    fileType: input.fileType,
                    telegramMeta: input.telegramMeta,
                    nativeResult: nativeParsed
                });
                if (shouldPreferAIResult(nativeParsed, aiParsed)) {
                    return {
                        result: aiParsed,
                        fallback: { attempted: true, used: true, reason: fallbackDecision.reason }
                    };
                }
                return {
                    result: nativeParsed,
                    fallback: { attempted: true, used: false, reason: `${fallbackDecision.reason}_native_kept` }
                };
            }
            catch (error) {
                return {
                    result: nativeParsed,
                    fallback: {
                        attempted: true,
                        used: false,
                        reason: `${fallbackDecision.reason}_ai_failed`,
                        error: String(error?.message || error || '')
                    }
                };
            }
        }
        finally {
            stopParse();
        }
    }
    finally {
        await safeDeleteMany(renderedImagePaths);
        stopPipeline();
    }
};
