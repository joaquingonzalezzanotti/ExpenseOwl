import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pino } from "pino";
import { GoogleGenAI, createPartFromBase64, createPartFromText, } from "@google/genai";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { subDays } from "date-fns";
const TZ = "America/Argentina/Buenos_Aires";
const PORT = Number(process.env.PORT || 3000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "20mb";
const INTERNAL_TOKEN = (process.env.INTERNAL_TOKEN || "").trim();
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES || 8 * 1024 * 1024);
const SUPPORTED_MEDIA_MIME_TYPES = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
]);
const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    transport: {
        target: "pino-pretty",
        options: { colorize: true },
    },
});
const ConfidenceSchema = z.object({
    type: z.number().min(0).max(1),
    amount: z.number().min(0).max(1),
    datetime_iso: z.number().min(0).max(1),
    counterparty: z.number().min(0).max(1),
    overall: z.number().min(0).max(1),
}).partial();
const TransactionSchema = z.object({
    type: z.enum(["income", "expense", "refund"]).optional(),
    amount: z.number().finite().optional(),
    currency: z.enum(["ARS", "USD", "EUR"]).optional(),
    datetime_iso: z
        .string()
        .optional()
        .refine((value) => !value || !Number.isNaN(Date.parse(value)), "datetime_iso must be a valid ISO date"),
    counterparty: z.string().optional(),
    reference: z.string().optional(),
    motive: z.string().optional(),
    source_app: z.enum(["MODO", "BANK", "WALLET", "UNKNOWN"]).optional(),
    confidence: ConfidenceSchema.optional(),
    missing_required: z.array(z.string()).default([]),
    warnings: z.array(z.string()).default([]),
});
const MediaInputSchema = z.object({
    data_base64: z.string().min(1),
    mime_type: z.string().min(1),
    filename: z.string().trim().max(180).optional(),
});
const ParseRequestSchema = z
    .object({
    text: z.string().trim().min(1).optional(),
    context_date: z.string().trim().min(1).optional(),
    media: MediaInputSchema.optional(),
})
    .superRefine((value, ctx) => {
    if (!value.text && !value.media) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "At least one of 'text' or 'media' is required",
            path: ["text"],
        });
    }
});
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "HttpError";
    }
}
function normalizeContextDate(value) {
    if (!value) {
        return formatInTimeZone(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    }
    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
        throw new HttpError(400, "context_date must be a valid date or datetime string");
    }
    return parsedDate.toISOString();
}
function stripDataUrlPrefix(base64Value) {
    const trimmed = base64Value.trim();
    const marker = "base64,";
    const markerIndex = trimmed.indexOf(marker);
    if (markerIndex === -1)
        return trimmed;
    return trimmed.slice(markerIndex + marker.length);
}
function decodeBase64OrThrow(base64Value) {
    const cleaned = stripDataUrlPrefix(base64Value).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
        throw new HttpError(400, "media.data_base64 is not valid base64 content");
    }
    try {
        return Buffer.from(cleaned, "base64");
    }
    catch {
        throw new HttpError(400, "media.data_base64 could not be decoded");
    }
}
function normalizeMediaInput(media) {
    if (!media)
        return null;
    const mimeType = media.mime_type.trim().toLowerCase();
    if (!SUPPORTED_MEDIA_MIME_TYPES.has(mimeType)) {
        throw new HttpError(400, `Unsupported media MIME type '${mimeType}'. Allowed: ${Array.from(SUPPORTED_MEDIA_MIME_TYPES).join(", ")}`);
    }
    const decoded = decodeBase64OrThrow(media.data_base64);
    if (decoded.byteLength === 0) {
        throw new HttpError(400, "media payload is empty");
    }
    if (decoded.byteLength > MAX_MEDIA_BYTES) {
        throw new HttpError(413, `media payload exceeds ${MAX_MEDIA_BYTES} bytes`);
    }
    return {
        base64Data: decoded.toString("base64"),
        mimeType,
        sizeBytes: decoded.byteLength,
        filename: media.filename,
    };
}
function buildSystemInstruction(referenceDateISO) {
    const reference = new Date(referenceDateISO);
    const y1 = formatInTimeZone(subDays(reference, 1), TZ, "yyyy-MM-dd");
    const y2 = formatInTimeZone(subDays(reference, 2), TZ, "yyyy-MM-dd");
    return `
Eres un experto en procesamiento de comprobantes bancarios y lenguaje financiero de Argentina.
Tu tarea es extraer datos estructurados a partir de:
1) texto libre (chat, OCR), y/o
2) imagenes o PDF de comprobantes.

REGLAS CRITICAS:
1. No inventes datos. Si un dato no esta claro, usa "" y agrega ese campo en missing_required.
2. Moneda: conserva monedas explicitas del usuario/comprobante. Soporta "ARS", "USD" y "EUR". No conviertas montos. Si no hay moneda explicita, usa "ARS".
3. Zona horaria: America/Argentina/Buenos_Aires (UTC-3).
4. Fecha de referencia "hoy": ${referenceDateISO}
   - ayer: ${y1}
   - anteayer: ${y2}
5. source_app:
   - MODO: si hay referencias explicitas a MODO.
   - BANK: comprobante bancario tradicional.
   - WALLET: Mercado Pago, Personal Pay, etc.
   - UNKNOWN: si no puede determinarse.
6. type:
   - expense: pagos, transferencias enviadas, compras.
   - income: transferencias recibidas, depositos, sueldos.
   - refund: reintegros, devoluciones, cashback. Es entrada de caja pero no ingreso de negocio.
7. amount debe ser numero distinto de 0.
8. Responde SOLO JSON valido, sin markdown ni texto extra.

CONTRATO DE SALIDA:
{
  "type": "income" | "expense" | "refund",
  "amount": number,
  "currency": "ARS" | "USD" | "EUR",
  "datetime_iso": "YYYY-MM-DDTHH:mm:ss-03:00",
  "counterparty": "Nombre de persona o comercio",
  "reference": "Opcional",
  "motive": "Opcional",
  "source_app": "MODO" | "BANK" | "WALLET" | "UNKNOWN",
  "confidence": {
    "type": 0-1,
    "amount": 0-1,
    "datetime_iso": 0-1,
    "counterparty": 0-1,
    "overall": 0-1
  },
  "missing_required": ["..."],
  "warnings": ["..."]
}
`.trim();
}
function parseModelJSON(rawResponseText) {
    const trimmed = (rawResponseText || "").trim();
    if (!trimmed)
        return {};
    if (trimmed.startsWith("```")) {
        const withoutFence = trimmed
            .replace(/^```[a-zA-Z]*\s*/u, "")
            .replace(/\s*```$/u, "");
        return JSON.parse(withoutFence);
    }
    return JSON.parse(trimmed);
}
function normalizeForMatch(raw) {
    return String(raw ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();
}
function pickFirstNonEmptyString(...values) {
    for (const value of values) {
        const normalized = String(value ?? "").trim();
        if (normalized)
            return normalized;
    }
    return undefined;
}
function normalizeType(raw) {
    const value = normalizeForMatch(raw);
    if (!value)
        return undefined;
    if (["income", "ingreso", "entrada", "credito", "cobro", "deposito", "recibido"].includes(value)) {
        return "income";
    }
    if (["expense", "gasto", "egreso", "salida", "debito", "pago"].includes(value)) {
        return "expense";
    }
    if (["refund", "reintegro", "devolucion", "cashback"].includes(value)) {
        return "refund";
    }
    return undefined;
}
function normalizeSourceApp(raw) {
    const value = String(raw || "").trim().toUpperCase();
    if (value === "MODO")
        return "MODO";
    if (value === "BANK")
        return "BANK";
    if (value === "WALLET")
        return "WALLET";
    return "UNKNOWN";
}
function normalizeAmount(raw) {
    if (typeof raw === "number" && Number.isFinite(raw))
        return raw;
    const value = String(raw || "").trim();
    if (!value)
        return undefined;
    const cleaned = value.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed))
        return undefined;
    return parsed;
}
function normalizeCurrency(raw, inputText) {
    const explicit = normalizeForMatch(raw);
    if (explicit === "usd" || explicit === "us$" || explicit === "u$s" || explicit === "dolar" || explicit === "dolares" || explicit === "dólar" || explicit === "dólares") {
        return "USD";
    }
    if (explicit === "eur" || explicit === "euro" || explicit === "euros") {
        return "EUR";
    }
    if (explicit === "ars" || explicit === "peso" || explicit === "pesos") {
        return "ARS";
    }
    const text = normalizeForMatch(inputText);
    if (text.includes("us$") || text.includes("u$s") || /\b(usd|dolar(?:es)?|dólar(?:es)?)\b/.test(text))
        return "USD";
    if (/\b(eur|euro(?:s)?)\b/.test(text))
        return "EUR";
    if (/\b(ars|peso(?:s)?)\b/.test(text))
        return "ARS";
    return "ARS";
}
function inferTypeFromText(text) {
    const value = normalizeForMatch(text);
    if (!value)
        return undefined;
    if (/\b(reintegro|devolucion|cashback)\b/.test(value))
        return "refund";
    if (/\b(cobre|recibi|ingrese|depositaron|me transfirieron)\b/.test(value))
        return "income";
    if (/\b(gaste|pague|compre|pago)\b/.test(value))
        return "expense";
    return undefined;
}
function inferAmountFromText(text) {
    const value = String(text || "");
    const withCurrency = value.match(/\$\s*([\d\.,]+)/);
    const generic = value.match(/\b(\d[\d\.,]*)\b/);
    return normalizeAmount(withCurrency?.[1] || generic?.[1] || "");
}
function inferCounterpartyFromText(text) {
    const value = String(text || "").trim();
    if (!value)
        return undefined;
    const toOrAt = value.match(/\b(?:en|a)\s+(.+)$/i)?.[1]?.trim();
    if (toOrAt)
        return toOrAt;
    return undefined;
}
function normalizeDateTime(raw) {
    const value = String(raw || "").trim();
    if (!value)
        return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return undefined;
    return parsed.toISOString();
}
function normalizeConfidence(raw, fallbackOverall) {
    const fromObject = typeof raw === "object" && raw !== null ? raw : {};
    const asNumber = (key, fallback) => {
        const n = Number(fromObject[key]);
        if (Number.isFinite(n))
            return Math.max(0, Math.min(1, n));
        return fallback;
    };
    return {
        type: asNumber("type", fallbackOverall),
        amount: asNumber("amount", fallbackOverall),
        datetime_iso: asNumber("datetime_iso", fallbackOverall),
        counterparty: asNumber("counterparty", fallbackOverall),
        overall: asNumber("overall", fallbackOverall),
    };
}
function normalizeModelOutput(raw, inputText, contextDateISO) {
    const source = typeof raw === "object" && raw !== null ? raw : {};
    const warnings = [];
    const missingRequired = [];
    const modelType = normalizeType(source.type ?? source.flow ?? source.direction ?? source.movement_type);
    const inferredType = inferTypeFromText(inputText);
    const type = modelType || inferredType;
    if (!type) {
        missingRequired.push("type");
    }
    else if (!modelType && inferredType) {
        warnings.push("Tipo inferido por texto.");
    }
    const modelAmount = normalizeAmount(source.amount ?? source.total ?? source.monto);
    const inferredAmount = inferAmountFromText(inputText);
    const amount = (typeof modelAmount === "number" && modelAmount !== 0) ? modelAmount : inferredAmount;
    if (!(typeof amount === "number" && Number.isFinite(amount) && amount !== 0)) {
        missingRequired.push("amount");
    }
    else if (!(typeof modelAmount === "number" && modelAmount !== 0) && typeof inferredAmount === "number") {
        warnings.push("Monto inferido por texto.");
    }
    const directDate = normalizeDateTime(source.datetime_iso ?? source.date_time_iso ?? source.date_time ?? source.datetime ?? source.fecha_hora ?? source.date);
    const datetimeISO = directDate || contextDateISO;
    if (!directDate) {
        warnings.push("Fecha y hora inferidas.");
    }
    const inferredCounterparty = inferCounterpartyFromText(inputText);
    const counterparty = pickFirstNonEmptyString(source.counterparty, source.merchant, source.comercio, source.destination, source.destino, source.recipient, inferredCounterparty);
    if (!counterparty) {
        missingRequired.push("counterparty");
    }
    else if (!pickFirstNonEmptyString(source.counterparty, source.merchant, source.comercio, source.destination, source.destino, source.recipient) &&
        inferredCounterparty) {
        warnings.push("Contraparte inferida por texto.");
    }
    const sourceApp = normalizeSourceApp(source.source_app ?? source.source ?? source.provider ?? source.payment_method ?? source.method);
    const overallConfidence = missingRequired.length > 0 ? 0.45 : 0.82;
    const confidence = normalizeConfidence(source.confidence ?? source.score, overallConfidence);
    return {
        type,
        amount,
        currency: normalizeCurrency(source.currency ?? source.moneda, inputText),
        datetime_iso: datetimeISO,
        counterparty,
        reference: pickFirstNonEmptyString(source.reference, source.ref, source.operation_id, source.comprobante),
        motive: pickFirstNonEmptyString(source.motive, source.description, source.concept, source.detalle),
        source_app: sourceApp,
        confidence,
        missing_required: Array.from(new Set(missingRequired)),
        warnings: Array.from(new Set([...(Array.isArray(source.warnings) ? source.warnings.map((item) => String(item)) : []), ...warnings])),
    };
}
class AIService {
    ai;
    constructor(apiKey) {
        this.ai = new GoogleGenAI({ apiKey });
    }
    async parse(input) {
        const parts = [];
        parts.push(createPartFromText("Extrae el movimiento financiero y devuelve exclusivamente JSON con el contrato pedido."));
        if (input.text) {
            parts.push(createPartFromText(`Texto provisto por usuario/OCR:\n${input.text}`));
        }
        if (input.media) {
            const mediaIntro = input.media.mimeType === "application/pdf"
                ? "Archivo PDF del comprobante adjunto."
                : "Imagen del comprobante adjunta.";
            parts.push(createPartFromText(mediaIntro));
            parts.push(createPartFromBase64(input.media.base64Data, input.media.mimeType));
        }
        const response = await this.ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: parts,
            config: {
                systemInstruction: buildSystemInstruction(input.contextDateISO),
                responseMimeType: "application/json",
                temperature: 0.1,
            },
        });
        const parsed = parseModelJSON(response.text || "");
        const normalized = normalizeModelOutput(parsed, input.text, input.contextDateISO);
        return TransactionSchema.parse(normalized);
    }
}
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.get("/healthz", (_req, res) => {
    res.json({
        status: "ok",
        model: GEMINI_MODEL,
        timezone: TZ,
        timestamp: new Date().toISOString(),
    });
});
app.get("/metrics", (_req, res) => {
    res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    });
});
app.post("/api/parse", async (req, res) => {
    try {
        if (INTERNAL_TOKEN) {
            const providedToken = String(req.header("x-internal-token") || "").trim();
            if (providedToken !== INTERNAL_TOKEN) {
                throw new HttpError(401, "Unauthorized");
            }
        }
        const parsedBody = ParseRequestSchema.safeParse(req.body);
        if (!parsedBody.success) {
            return res.status(400).json({
                error: "Invalid request body",
                details: parsedBody.error.flatten(),
            });
        }
        const contextDateISO = normalizeContextDate(parsedBody.data.context_date);
        const normalizedMedia = normalizeMediaInput(parsedBody.data.media);
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new HttpError(500, "GEMINI_API_KEY is not configured");
        }
        const aiService = new AIService(apiKey);
        const result = await aiService.parse({
            text: parsedBody.data.text,
            contextDateISO,
            media: normalizedMedia,
        });
        logger.info({
            flow: "parse_ok",
            hasText: Boolean(parsedBody.data.text),
            hasMedia: Boolean(normalizedMedia),
            mediaMimeType: normalizedMedia?.mimeType,
            mediaSizeBytes: normalizedMedia?.sizeBytes,
            result: { ...result, counterparty: "***" },
        }, "Parsing successful");
        return res.json(result);
    }
    catch (error) {
        if (error instanceof HttpError) {
            return res.status(error.status).json({ error: error.message });
        }
        if (error instanceof z.ZodError) {
            logger.warn({ issues: error.issues }, "Model response validation failed");
            return res.status(422).json({
                error: "Model response failed schema validation",
                details: error.issues,
            });
        }
        const message = error instanceof Error ? error.message : "unknown error";
        logger.error({ err: message }, "Parser endpoint failed");
        return res.status(500).json({
            error: "Internal Server Error",
            details: process.env.NODE_ENV === "development" ? message : undefined,
        });
    }
});
app.listen(PORT, "0.0.0.0", () => {
    logger.info({ port: PORT, model: GEMINI_MODEL, maxMediaBytes: MAX_MEDIA_BYTES }, "ExpenseLog AI Parser running");
});
