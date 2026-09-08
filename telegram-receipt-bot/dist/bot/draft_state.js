export const DRAFT_STATUS = {
    AWAITING_CONFIRM: 'awaiting_confirm',
    AWAITING_FIX: 'awaiting_fix',
    AWAITING_DUPLICATE_DECISION: 'awaiting_duplicate_decision',
    CONFIRMING: 'confirming',
    CONFIRMED: 'confirmed',
    REJECTED: 'rejected',
    FAILED: 'failed'
};

export const TERMINAL_DRAFT_STATUSES = new Set([
    DRAFT_STATUS.CONFIRMED,
    DRAFT_STATUS.REJECTED,
    DRAFT_STATUS.FAILED
]);

export const CONFIRMABLE_DRAFT_STATUSES = [
    DRAFT_STATUS.AWAITING_CONFIRM
];

export const DUPLICATE_CONFIRMABLE_DRAFT_STATUSES = [
    DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
];

export const REJECTABLE_DRAFT_STATUSES = [
    DRAFT_STATUS.AWAITING_CONFIRM,
    DRAFT_STATUS.AWAITING_FIX,
    DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
];

export const EDITABLE_DRAFT_STATUSES = [
    DRAFT_STATUS.AWAITING_CONFIRM,
    DRAFT_STATUS.AWAITING_FIX,
    DRAFT_STATUS.AWAITING_DUPLICATE_DECISION
];

export const isTerminalDraftStatus = (status) => TERMINAL_DRAFT_STATUSES.has(String(status || '').trim());

export const canResolveDraft = (status, allowedStatuses) => {
    const normalized = String(status || '').trim();
    return Array.isArray(allowedStatuses) && allowedStatuses.includes(normalized);
};
