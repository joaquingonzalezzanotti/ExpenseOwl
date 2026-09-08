import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONFIRMABLE_DRAFT_STATUSES,
    DRAFT_STATUS,
    DUPLICATE_CONFIRMABLE_DRAFT_STATUSES,
    REJECTABLE_DRAFT_STATUSES,
    canResolveDraft,
    isTerminalDraftStatus
} from './draft_state.js';

test('pending draft without user action is not confirmable by side effect', () => {
    assert.equal(canResolveDraft(DRAFT_STATUS.AWAITING_FIX, CONFIRMABLE_DRAFT_STATUSES), false);
    assert.equal(canResolveDraft(DRAFT_STATUS.AWAITING_CONFIRM, CONFIRMABLE_DRAFT_STATUSES), true);
});

test('duplicate cancel and override are separate terminal paths', () => {
    assert.equal(canResolveDraft(DRAFT_STATUS.AWAITING_DUPLICATE_DECISION, REJECTABLE_DRAFT_STATUSES), true);
    assert.equal(canResolveDraft(DRAFT_STATUS.AWAITING_DUPLICATE_DECISION, DUPLICATE_CONFIRMABLE_DRAFT_STATUSES), true);
    assert.equal(canResolveDraft(DRAFT_STATUS.AWAITING_DUPLICATE_DECISION, CONFIRMABLE_DRAFT_STATUSES), false);
});

test('repeated callbacks against terminal drafts cannot resolve again', () => {
    for (const status of [DRAFT_STATUS.CONFIRMED, DRAFT_STATUS.REJECTED, DRAFT_STATUS.FAILED]) {
        assert.equal(isTerminalDraftStatus(status), true);
        assert.equal(canResolveDraft(status, CONFIRMABLE_DRAFT_STATUSES), false);
        assert.equal(canResolveDraft(status, DUPLICATE_CONFIRMABLE_DRAFT_STATUSES), false);
        assert.equal(canResolveDraft(status, REJECTABLE_DRAFT_STATUSES), false);
    }
});
