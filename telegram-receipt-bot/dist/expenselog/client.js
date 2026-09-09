import { config } from '../config.js';
export const buildExpenseLogWebURL = (pathname = '/app/table', webBaseURL = config.expenselogWebBaseUrl) => {
    const base = String(webBaseURL || '').replace(/\/+$/, '');
    const path = String(pathname || '').trim();
    if (/^https?:\/\//i.test(path)) {
        return path;
    }
    if (!base) {
        return path.startsWith('/') ? path : `/${path}`;
    }
    if (!path) {
        return `${base}/app/table`;
    }
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};
export const normalizeTransactionURL = (rawURL, webBaseURL = config.expenselogWebBaseUrl) => {
    const clean = String(rawURL || '').trim();
    if (!clean) {
        return buildExpenseLogWebURL('/app/table', webBaseURL);
    }
    return buildExpenseLogWebURL(clean, webBaseURL);
};
export class ExpenseLogAPIError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.name = 'ExpenseLogAPIError';
        this.status = status;
        this.code = code;
    }
}
const isTechnicalBankMemo = (raw) => {
    const normalized = String(raw || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.\-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
    return ['VAR', 'N A', 'NA', 'N/A', 'SIN MOTIVO', 'SIN CONCEPTO', 'S E U O', 'SEUO'].includes(normalized);
};
const buildVisibleTransactionName = (counterparty, motive) => {
    const cleanCounterparty = String(counterparty || '').replace(/\s+/g, ' ').trim();
    const cleanMotive = String(motive || '').replace(/\s+/g, ' ').trim();
    if (cleanMotive && !isTechnicalBankMemo(cleanMotive)) {
        return cleanCounterparty ? `${cleanMotive} - ${cleanCounterparty}` : cleanMotive;
    }
    return cleanCounterparty || 'Movimiento Telegram';
};
export class ExpenseLogAdapter {
    async createTransaction(payload) {
        if (config.expenselogAdapterMode === 'transactions_api') {
            return this.createViaTransactionsAPI(payload);
        }
        return this.createViaExpenseAPI(payload);
    }
    async consumeLinkCode(payload) {
        const response = await fetch(this.buildURL(config.expenselogBotConsumeLinkCodePath), {
            method: 'POST',
            headers: this.botHeaders(),
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw await this.readAPIError(response, 'ExpenseLog consume-link-code failed');
        }
    }
    async getTelegramLinkStatus(telegramUserID) {
        const response = await fetch(this.buildURL(config.expenselogBotLinkStatusPath), {
            method: 'POST',
            headers: this.botHeaders(),
            body: JSON.stringify({ telegram_user_id: telegramUserID })
        });
        if (!response.ok) {
            throw await this.readAPIError(response, 'ExpenseLog link-status failed');
        }
        return (await response.json());
    }
    async createBotExpense(payload) {
        const response = await fetch(this.buildURL(config.expenselogBotExpensePath), {
            method: 'POST',
            headers: this.botHeaders(),
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw await this.readAPIError(response, 'ExpenseLog bot-expense API error');
        }
        const data = (await response.json());
        if (!data.transaction_id) {
            throw new Error('ExpenseLog bot-expense API returned no transaction_id');
        }
        data.url = normalizeTransactionURL(data.url);
        return data;
    }
    async readAPIError(response, fallback) {
        const payload = (await response.json().catch(() => ({})));
        return new ExpenseLogAPIError(response.status, payload.error || fallback, payload.code);
    }
    baseHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (config.expenselogApiToken) {
            headers.Authorization = `Bearer ${config.expenselogApiToken}`;
        }
        if (config.expenselogSessionCookie) {
            headers.Cookie = `expense_session=${config.expenselogSessionCookie}`;
        }
        if (!headers.Authorization && !headers.Cookie) {
            throw new Error('ExpenseLog auth is missing. Set EXPENSELOG_API_TOKEN or EXPENSELOG_SESSION_COOKIE.');
        }
        return headers;
    }
    botHeaders() {
        if (!config.expenselogBotInternalSecret) {
            throw new Error('Missing EXPENSELOG_BOT_INTERNAL_SECRET for bot integration.');
        }
        return {
            'Content-Type': 'application/json',
            'X-ExpenseLog-Bot-Secret': config.expenselogBotInternalSecret
        };
    }
    buildURL(pathname) {
        const base = String(config.expenselogApiBaseUrl || '').replace(/\/+$/, '');
        const path = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
        return `${base}${path}`;
    }
    buildExpenseAPIPayload(payload) {
        const name = buildVisibleTransactionName(payload.counterparty, payload.motive);
        const category = payload.category || (payload.type === 'income'
            ? config.expenselogDefaultIncomeCategory
            : config.expenselogDefaultExpenseCategory);
        return {
            name,
            category,
            amount: Math.abs(payload.amount),
            currency: String(payload.currency || 'ARS').toLowerCase(),
            source: String(payload.provider || '').trim().toUpperCase(),
            flow: payload.type,
            tags: Array.isArray(payload.tags) ? payload.tags : [],
            date: payload.datetime_iso
        };
    }
    async createViaTransactionsAPI(payload) {
        const response = await fetch(this.buildURL(config.expenselogTransactionsPath), {
            method: 'POST',
            headers: this.baseHeaders(),
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`ExpenseLog transactions API error: ${response.status}`);
        }
        const data = (await response.json());
        if (!data.transaction_id) {
            throw new Error('ExpenseLog transactions API returned no transaction_id');
        }
        data.url = normalizeTransactionURL(data.url);
        return data;
    }
    async createViaExpenseAPI(payload) {
        const response = await fetch(this.buildURL(config.expenselogExpensePath), {
            method: 'PUT',
            headers: this.baseHeaders(),
            body: JSON.stringify(this.buildExpenseAPIPayload(payload))
        });
        if (!response.ok) {
            throw new Error(`ExpenseLog expense API error: ${response.status}`);
        }
        const data = (await response.json());
        const transactionID = String(data.id || '').trim();
        if (!transactionID) {
            throw new Error('ExpenseLog expense API returned no id');
        }
        return {
            transaction_id: transactionID,
            url: buildExpenseLogWebURL('/app/table')
        };
    }
}
