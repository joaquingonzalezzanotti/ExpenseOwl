const colorPalette = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
    '#FFBE0B', '#FF006E', '#8338EC', '#3A86FF', 
    '#FB5607', '#38B000', '#9B5DE5', '#F15BB5'
];
const currencyBehaviors = {
    ars: {symbol: "$", useComma: true, useDecimals: true, useSpace: false, right: false},
    usd: {symbol: "$", useComma: false, useDecimals: true, useSpace: false, right: false},
    eur: {symbol: "EUR", useComma: true, useDecimals: true, useSpace: false, right: false},
};

function resolveFlow(exp) {
    if (!exp) return 'expense';
    const flow = (exp.flow || '').toLowerCase();
    if (flow) return flow;
    return exp.amount > 0 ? 'income' : 'expense';
}

function normalizeSourceCode(source) {
    const code = String(source || '').trim().toUpperCase();
    if (code === '' || code === 'CA') return 'CA';
    if (code === 'TARJETA') return 'TARJETA';
    if (code === 'EFECTIVO') return 'EFECTIVO';
    return 'CA';
}

function formatSourceLabel(source) {
    if (String(source || '').trim() === '') return 'Medio no especificado';
    const code = normalizeSourceCode(source);
    if (code === 'CA') return 'Transferencia';
    if (code === 'TARJETA') return 'Tarjeta de credito';
    if (code === 'EFECTIVO') return 'Efectivo (solo registro)';
    return code || '-';
}

let authChecked = false;
let currentUser = null;
let pendingAuthErrorMessage = null;
let authCheckPromise = null;
const NOTIFICATION_FETCH_CURRENCY = 'ars';
const NOTIFICATION_FETCH_DAYS = 7;
const NOTIFICATION_REFRESH_MS = 45000;
const NOTIFICATION_SEEN_STORAGE_KEY = 'expenselog_notification_seen_v1';
const NOTIFICATION_DISMISS_STORAGE_KEY = 'expenselog_liquidity_dismiss_v1';
let notificationCenterBound = false;
let notificationCenterTimer = null;
let latestNotificationPayload = null;
let currentVisibleNotificationItems = [];
let notificationCenterDisabled = false;
let notificationCenterFetchWarned = false;
let logoutInFlight = false;
let navigationPlanTier = 'free';
let planTierRefreshPromise = null;
const PLAN_TIER_CACHE_KEY = 'expenselog_plan_tier_cache_v1';
const PLAN_TIER_CACHE_TTL_MS = 5 * 60 * 1000;

const API_ROUTE_REGEX = /^\/(auth|config|categories|currency|startdate|reconciliation|expense|expenses|recurring-expense|recurring-expenses|alerts|export|import|version|card|telegram|whatsapp)(\/|$)/;
const originalFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
if (originalFetch) {
    window.fetch = (input, init) => {
        if (typeof input === 'string' && API_ROUTE_REGEX.test(input) && !input.startsWith('/api/')) {
            return originalFetch(`/api${input}`, init);
        }
        return originalFetch(input, init);
    };
}

function buildIdempotencyKey(prefix = 'req') {
    const normalized = String(prefix || 'req').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 32) || 'req';
    const now = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 12);
    return `${normalized}-${now}-${random}`;
}

window.expenseLogIdempotencyKey = buildIdempotencyKey;

function setAuthPending(pending) {
    if (!document.body || !document.getElementById('authOverlay')) return;
    document.body.classList.toggle('auth-pending', !!pending);
}

setAuthPending(true);

function showAuthMessageFromURL() {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (!authError) return;
    pendingAuthErrorMessage = authError;
    params.delete('auth_error');
    const cleaned = params.toString();
    const nextURL = cleaned ? `${window.location.pathname}?${cleaned}` : window.location.pathname;
    window.history.replaceState({}, '', nextURL);
}

function normalizePlanTier(value) {
    return String(value || '').trim().toLowerCase() === 'premium' ? 'premium' : 'free';
}

function readPlanTierCache() {
    try {
        const raw = localStorage.getItem(PLAN_TIER_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.planTier !== 'string') return null;
        if (typeof parsed.cachedAt !== 'number') return null;
        return {
            planTier: normalizePlanTier(parsed.planTier),
            cachedAt: parsed.cachedAt,
        };
    } catch (_) {
        return null;
    }
}

function writePlanTierCache(planTier) {
    try {
        localStorage.setItem(PLAN_TIER_CACHE_KEY, JSON.stringify({
            planTier: normalizePlanTier(planTier),
            cachedAt: Date.now(),
        }));
    } catch (_) {
        // ignore storage failures
    }
}

function clearPlanTierCache() {
    try {
        localStorage.removeItem(PLAN_TIER_CACHE_KEY);
    } catch (_) {
        // ignore storage failures
    }
}

function getPlanAwareAnalyticsRoute(planTier) {
    void planTier;
    return '/app/analisis';
}

function normalizeNavigationRoute(pathname, search = '') {
    const cleanedPath = String(pathname || '/').replace(/\/+$/, '') || '/';
    const aliases = {
        '/table': '/app/table',
        '/analisis': '/app/analisis',
        '/reportes': '/app/reportes',
        '/settings': '/app/perfil',
        '/perfil': '/app/perfil',
        '/categorias': '/app/categorias',
        '/recurrentes': '/app/recurrentes',
        '/conciliacion': '/app/conciliacion',
        '/bots': '/app/bots',
        '/telegram': '/app/bots',
        '/whatsapp': '/app/bots',
        '/app/telegram': '/app/bots',
        '/app/whatsapp': '/app/bots',
        '/app/settings': '/app/perfil',
    };
    const canonicalPath = aliases[cleanedPath] || cleanedPath;
    return `${canonicalPath}${String(search || '')}`;
}

function applyPlanAwareAnalyticsNavigation(planTier) {
    navigationPlanTier = normalizePlanTier(planTier);
    const targetRoute = getPlanAwareAnalyticsRoute(navigationPlanTier);
    const iconClasses = 'fa-solid fa-chart-pie';
    const label = 'Analisis';

    document.querySelectorAll('[data-plan-nav-slot="analytics"]').forEach((node) => {
        if (!(node instanceof HTMLAnchorElement)) return;
        node.setAttribute('href', targetRoute);
        node.dataset.planTier = navigationPlanTier;
        const icon = node.querySelector('i');
        if (icon) {
            icon.className = iconClasses;
            icon.setAttribute('aria-hidden', 'true');
        }
        const text = node.querySelector('span');
        if (text) {
            text.textContent = label;
        }
    });

    window.dispatchEvent(new CustomEvent('expenselog:routechange'));
}

async function refreshPlanTierNavigation(options = {}) {
    if (planTierRefreshPromise) return planTierRefreshPromise;
    const force = !!options.force;
    const cached = readPlanTierCache();
    if (cached && !force) {
        applyPlanAwareAnalyticsNavigation(cached.planTier);
        if ((Date.now() - cached.cachedAt) < PLAN_TIER_CACHE_TTL_MS) {
            return cached.planTier;
        }
    }

    planTierRefreshPromise = (async () => {
        if (!currentUser) {
            clearPlanTierCache();
            applyPlanAwareAnalyticsNavigation('free');
            return 'free';
        }
        try {
            const response = await fetch('/config', { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`status ${response.status}`);
            }
            const config = await response.json();
            const resolvedPlanTier = normalizePlanTier(config?.planTier);
            writePlanTierCache(resolvedPlanTier);
            applyPlanAwareAnalyticsNavigation(resolvedPlanTier);
            return resolvedPlanTier;
        } catch (_) {
            clearPlanTierCache();
            applyPlanAwareAnalyticsNavigation('free');
            return 'free';
        }
    })().finally(() => {
        planTierRefreshPromise = null;
    });

    return planTierRefreshPromise;
}

async function checkAuthStatus() {
    if (authCheckPromise) return authCheckPromise;

    const overlay = document.getElementById('authOverlay');
    if (!overlay) {
        setAuthPending(false);
        return null;
    }

    authCheckPromise = (async () => {
        let user = null;
        try {
            const res = await fetch('/auth/me', { cache: 'no-store' });
            if (res.ok) {
                user = await res.json();
                currentUser = user;
                updateUserBadge(user);
                hideAuthOverlay();
                ensureNotificationCenter();
                await refreshPlanTierNavigation();
                authChecked = true;
                setAuthPending(false);
                return user;
            }
            if (res.status === 401) {
                currentUser = null;
                updateUserBadge(null);
                teardownNotificationCenter();
                clearPlanTierCache();
                applyPlanAwareAnalyticsNavigation('free');
                if (pendingAuthErrorMessage) {
                    showAuthOverlay(pendingAuthErrorMessage, 'error');
                    pendingAuthErrorMessage = null;
                } else {
                    showAuthOverlay();
                }
                authChecked = true;
                setAuthPending(false);
                return null;
            }
            showAuthOverlay('No se pudo validar la sesion', 'error');
            teardownNotificationCenter();
            applyPlanAwareAnalyticsNavigation('free');
        } catch (error) {
            console.error('Auth check failed:', error);
            showAuthOverlay('No se pudo validar la sesion', 'error');
            teardownNotificationCenter();
            clearPlanTierCache();
            applyPlanAwareAnalyticsNavigation('free');
        }
        authChecked = true;
        setAuthPending(false);
        return null;
    })().finally(() => {
        authCheckPromise = null;
    });

    return authCheckPromise;
}

function guardAppInit(initFn) {
    return async () => {
        const user = await checkAuthStatus();
        if (!user) return;
        if (typeof initFn === 'function') {
            await initFn();
        }
    };
}

function showAuthOverlay(message, type) {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    setAuthPending(false);
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('auth-locked');
    const msg = document.getElementById('authMessage');
    if (msg) {
        msg.textContent = message || '';
        if (!message) {
            msg.className = 'form-message';
        } else if (type === 'success') {
            msg.className = 'form-message success';
        } else {
            msg.className = 'form-message error';
        }
    }
}

function hideAuthOverlay() {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('auth-locked');
}

function userInitialsFromUser(user) {
    if (!user || typeof user !== 'object') return '';
    const displayName = (user.name || user.displayName || '').trim();
    if (displayName) {
        const parts = displayName.split(/\s+/).filter(Boolean);
        const initials = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
        if (initials) return initials;
    }
    const normalized = (user.email || '').trim().toLowerCase();
    if (!normalized) return '';
    const localPart = normalized.split('@')[0] || '';
    const chars = localPart.replace(/[^a-z0-9]/g, '');
    if (!chars) return '';
    return chars.slice(0, 2).toUpperCase();
}

function updateUserBadge(user) {
    const badge = document.getElementById('userEmailBadge');
    if (!badge) return;
    if (user && (user.email || user.name || user.displayName)) {
        badge.textContent = userInitialsFromUser(user);
        badge.setAttribute('aria-label', 'Usuario conectado');
        badge.style.display = 'inline-flex';
    } else {
        badge.textContent = '';
        badge.removeAttribute('aria-label');
        badge.style.display = 'none';
    }
}

function getNotificationCenterDOM() {
    const button = document.getElementById('notificationCenterButton');
    const badge = document.getElementById('notificationCenterBadge');
    const panel = document.getElementById('notificationCenterPanel');
    const list = document.getElementById('notificationCenterList');
    const icon = button ? button.querySelector('i') : null;
    const slot = button ? button.closest('.nav-right-slot') : null;
    return { button, badge, panel, list, icon, slot };
}

function readJSONStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
    } catch (error) {
        return fallback;
    }
}

function writeJSONStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        // ignore storage write failures
    }
}

function readSeenNotificationKeys() {
    const raw = readJSONStorage(NOTIFICATION_SEEN_STORAGE_KEY, []);
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter(item => typeof item === 'string' && item));
}

function saveSeenNotificationKeys(keys) {
    writeJSONStorage(NOTIFICATION_SEEN_STORAGE_KEY, Array.from(keys));
}

function readNotificationDismissMap() {
    const value = readJSONStorage(NOTIFICATION_DISMISS_STORAGE_KEY, {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}

function writeNotificationDismissMap(map) {
    writeJSONStorage(NOTIFICATION_DISMISS_STORAGE_KEY, map);
}

function buildNotificationKey(item) {
    if (typeof ExpenseLogAlertUI !== 'undefined' && typeof ExpenseLogAlertUI.buildLiquidityAlertKey === 'function') {
        return ExpenseLogAlertUI.buildLiquidityAlertKey(item);
    }
    const recurringId = String(item?.recurringId || 'sin-recurring');
    const dueDate = String(item?.dueDate || '');
    const kind = String(item?.kind || 'preview_7d');
    return `${recurringId}|${dueDate}|${kind}`;
}

function shouldHideDismissedNotification(item, dismissMap, reappearDays) {
    if (typeof ExpenseLogAlertUI !== 'undefined' && typeof ExpenseLogAlertUI.shouldHideDismissedAlert === 'function') {
        return ExpenseLogAlertUI.shouldHideDismissedAlert(item, dismissMap, reappearDays);
    }
    const key = buildNotificationKey(item);
    const entry = dismissMap[key];
    if (!entry) return false;
    const daysUntil = Number(item?.daysUntil || 0);
    const dismissedDaysUntil = typeof entry === 'object'
        ? Number(entry.daysUntil ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
    const is24hWindow = daysUntil <= reappearDays;
    const wasDismissedBeforeWindow = dismissedDaysUntil > reappearDays;
    if (is24hWindow && wasDismissedBeforeWindow) {
        return false;
    }
    return true;
}

function getNotificationLead(item, criticalDays) {
    if (item?.kind === 'due') return 'Vencimiento';
    if (item?.kind === 'risk_4d') return `Riesgo en ${criticalDays} dias`;
    if (item?.kind === 'monitor_4d') return `Seguimiento ${criticalDays} dias`;
    return 'Aviso 7 dias';
}

function formatNotificationDueDate(isoDate) {
    if (typeof getDateInputValueFromISO === 'function') {
        const ymd = getDateInputValueFromISO(isoDate);
        if (!ymd) return '-';
        const [year, month, day] = ymd.split('-');
        return `${day}/${month}/${year}`;
    }
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('es-AR');
}

function formatNotificationDays(daysUntil) {
    if (daysUntil < 0) {
        const ago = Math.abs(daysUntil);
        return ago === 1 ? 'hace 1 dia' : `hace ${ago} dias`;
    }
    if (daysUntil === 0) return 'hoy';
    if (daysUntil === 1) return 'en 1 dia';
    return `en ${daysUntil} dias`;
}

function formatNotificationAmount(amount, currencyCode) {
    const code = (currencyCode || 'ars').toLowerCase();
    const behavior = currencyBehaviors[code] || currencyBehaviors.ars;
    const isNegative = amount < 0;
    const absAmount = Math.abs(amount);
    const formatted = new Intl.NumberFormat(behavior.useComma ? 'de-DE' : 'en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(absAmount);
    const result = behavior.right
        ? `${formatted}${behavior.useSpace ? ' ' : ''}${behavior.symbol}`
        : `${behavior.symbol}${behavior.useSpace ? ' ' : ''}${formatted}`;
    return isNegative ? `-${result}` : result;
}

function getVisibleNotificationItems(payload) {
    const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
    const dismissMap = readNotificationDismissMap();
    const reappearDays = Number(payload?.reappearDays || 1);
    return alerts.filter((item) => !shouldHideDismissedNotification(item, dismissMap, reappearDays));
}

function markCurrentNotificationsAsSeen() {
    if (!currentVisibleNotificationItems.length) return;
    const seenKeys = readSeenNotificationKeys();
    currentVisibleNotificationItems.forEach((item) => {
        seenKeys.add(buildNotificationKey(item));
    });
    saveSeenNotificationKeys(seenKeys);
}

function closeNotificationPanel() {
    const dom = getNotificationCenterDOM();
    if (!dom.panel || !dom.button) return;
    dom.panel.hidden = true;
    dom.button.setAttribute('aria-expanded', 'false');
}

async function openNotificationPanel() {
    const dom = getNotificationCenterDOM();
    if (!dom.panel || !dom.button) return;
    await refreshNotificationCenter();
    dom.panel.hidden = false;
    dom.button.setAttribute('aria-expanded', 'true');
    markCurrentNotificationsAsSeen();
    renderNotificationCenter(latestNotificationPayload);
}

function dismissNotification(itemKey) {
    const selected = currentVisibleNotificationItems.find((item) => buildNotificationKey(item) === itemKey);
    if (!selected) return;
    const dismissMap = readNotificationDismissMap();
    dismissMap[itemKey] = {
        dismissedAt: Date.now(),
        daysUntil: Number(selected?.daysUntil || 0),
    };
    writeNotificationDismissMap(dismissMap);
    renderNotificationCenter(latestNotificationPayload);
}

function renderNotificationCenter(payload) {
    const dom = getNotificationCenterDOM();
    if (!dom.button || !dom.list || !dom.badge) return;

    const visibleItems = getVisibleNotificationItems(payload);
    currentVisibleNotificationItems = visibleItems;
    const topItems = visibleItems.slice(0, 3);
    const hasCritical = visibleItems.some((item) => item?.severity === 'critical');
    const totalCount = visibleItems.length;
    const seenKeys = readSeenNotificationKeys();
    const unseenCount = visibleItems.filter((item) => !seenKeys.has(buildNotificationKey(item))).length;

    if (dom.icon) {
        dom.icon.className = hasCritical ? 'fa-solid fa-triangle-exclamation' : 'fa-regular fa-bell';
    }
    dom.button.classList.toggle('has-alert', hasCritical);

    if (!hasCritical && totalCount > 0 && unseenCount > 0) {
        dom.badge.textContent = String(Math.min(unseenCount, 99));
        dom.badge.hidden = false;
    } else {
        dom.badge.textContent = '';
        dom.badge.hidden = true;
    }

    if (topItems.length === 0) {
        dom.list.innerHTML = '<div class="notification-empty">🔕 Sin notificaciones pendientes.</div>';
        return;
    }

    const criticalDays = Number(payload?.criticalDays || 4);
    const currency = String(payload?.currency || NOTIFICATION_FETCH_CURRENCY).toLowerCase();
    dom.list.innerHTML = topItems.map((item) => {
        const itemKey = buildNotificationKey(item);
        const isCritical = item?.severity === 'critical';
        const requiredAmount = Number(item?.requiredAmount || 0);
        const projected = Number(item?.balanceAfter || 0);
        const shortfall = Number(item?.shortfall || 0);
        return `
            <article class="notification-item ${isCritical ? 'is-critical' : ''}" data-item-key="${itemKey}">
                <div class="notification-item-head">
                    <div class="notification-item-title">${escapeHTML(item?.name || 'Recurrente')}</div>
                    <span class="notification-item-badge ${isCritical ? 'critical' : ''}">${isCritical ? 'Alerta' : 'Info'}</span>
                </div>
                <div class="notification-item-summary">${getNotificationLead(item, criticalDays)}: ${formatNotificationDays(Number(item?.daysUntil || 0))} (${formatNotificationDueDate(item?.dueDate)})</div>
                <div class="notification-item-details">
                    <div>Importe: ${formatNotificationAmount(requiredAmount, currency)}</div>
                    <div>Saldo proyectado: ${formatNotificationAmount(projected, currency)}</div>
                    ${shortfall > 0 ? `<div>Faltante estimado: ${formatNotificationAmount(shortfall, currency)}</div>` : ''}
                </div>
                <div class="notification-item-actions">
                    <button type="button" class="notification-item-btn" data-notif-action="toggle" data-notif-key="${itemKey}">Ver completa</button>
                    <button type="button" class="notification-item-btn danger" data-notif-action="dismiss" data-notif-key="${itemKey}">Borrar</button>
                </div>
            </article>
        `;
    }).join('') + (visibleItems.length > 3 ? `<div class="notification-list-more">Mostrando ultimas 3 de ${visibleItems.length}</div>` : '');
}

function bindNotificationCenter() {
    if (notificationCenterBound) return;
    const dom = getNotificationCenterDOM();
    if (!dom.button || !dom.panel || !dom.list) return;

    dom.button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (dom.panel.hidden) {
            openNotificationPanel();
        } else {
            closeNotificationPanel();
        }
    });

    dom.list.addEventListener('click', (event) => {
        const actionButton = event.target.closest('[data-notif-action]');
        if (!actionButton) return;
        const action = actionButton.dataset.notifAction;
        const itemKey = actionButton.dataset.notifKey;
        if (!itemKey) return;
        if (action === 'dismiss') {
            dismissNotification(itemKey);
            return;
        }
        if (action === 'toggle') {
            const itemNode = actionButton.closest('.notification-item');
            if (!itemNode) return;
            const opened = itemNode.classList.toggle('is-open');
            actionButton.textContent = opened ? 'Ver menos' : 'Ver completa';
        }
    });

    document.addEventListener('click', (event) => {
        if (dom.panel.hidden) return;
        const insideButton = dom.button.contains(event.target);
        const insidePanel = dom.panel.contains(event.target);
        if (!insideButton && !insidePanel) {
            closeNotificationPanel();
        }
    });

    notificationCenterBound = true;
}

async function refreshNotificationCenter() {
    const dom = getNotificationCenterDOM();
    if (!dom.button || !currentUser || notificationCenterDisabled) return;
    try {
        const response = await fetch(`/alerts/liquidity?currency=${NOTIFICATION_FETCH_CURRENCY}&days=${NOTIFICATION_FETCH_DAYS}`, { cache: 'no-store' });
        if (response.status === 404) {
            notificationCenterDisabled = true;
            if (notificationCenterTimer) {
                window.clearInterval(notificationCenterTimer);
                notificationCenterTimer = null;
            }
            latestNotificationPayload = { alerts: [] };
            renderNotificationCenter(latestNotificationPayload);
            return;
        }
        if (!response.ok) throw new Error(`status ${response.status}`);
        latestNotificationPayload = await response.json();
        notificationCenterFetchWarned = false;
        renderNotificationCenter(latestNotificationPayload);
    } catch (error) {
        if (!notificationCenterFetchWarned) {
            console.warn('No se pudo refrescar el centro de notificaciones:', error);
            notificationCenterFetchWarned = true;
        }
        latestNotificationPayload = { alerts: [] };
        renderNotificationCenter(latestNotificationPayload);
    }
}

function ensureNotificationCenter() {
    const dom = getNotificationCenterDOM();
    if (!dom.button || notificationCenterDisabled) return;
    if (dom.slot) {
        dom.slot.style.display = 'inline-flex';
    }
    bindNotificationCenter();
    refreshNotificationCenter();
    if (!notificationCenterTimer) {
        notificationCenterTimer = window.setInterval(refreshNotificationCenter, NOTIFICATION_REFRESH_MS);
    }
}

function teardownNotificationCenter() {
    const dom = getNotificationCenterDOM();
    if (notificationCenterTimer) {
        window.clearInterval(notificationCenterTimer);
        notificationCenterTimer = null;
    }
    latestNotificationPayload = null;
    currentVisibleNotificationItems = [];
    if (dom.badge) {
        dom.badge.hidden = true;
        dom.badge.textContent = '';
    }
    if (dom.panel) {
        dom.panel.hidden = true;
    }
    if (dom.slot) {
        dom.slot.style.display = 'none';
    }
}

async function expenseLogLogout() {
    if (logoutInFlight) return;
    logoutInFlight = true;
    try {
        await fetch('/auth/logout', { method: 'POST' });
    } catch (error) {
        console.error('Logout failed:', error);
    } finally {
        teardownNotificationCenter();
        clearPlanTierCache();
        applyPlanAwareAnalyticsNavigation('free');
        showAuthOverlay();
        window.location.reload();
    }
}

window.expenseLogLogout = expenseLogLogout;

function setAuthTab(tab) {
    const tabs = document.querySelectorAll('.auth-tab');
    const forms = document.querySelectorAll('.auth-form');
    tabs.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.authTab === tab);
    });
    forms.forEach(form => {
        form.classList.toggle('active', form.dataset.authForm === tab);
    });
}

function setupAuthUI() {
    const overlay = document.getElementById('authOverlay');
    if (!overlay || overlay.dataset.bound === 'true') return;
    overlay.dataset.bound = 'true';

    const tabs = document.querySelectorAll('.auth-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => setAuthTab(tab.dataset.authTab));
    });
    const links = document.querySelectorAll('[data-auth-link]');
    links.forEach(link => {
        link.addEventListener('click', () => setAuthTab(link.dataset.authLink));
    });

    const loginForm = document.getElementById('authLoginForm');
    if (loginForm) {
        let loginPending = false;
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (loginPending) return;
            loginPending = true;
            const email = document.getElementById('authLoginEmail').value.trim();
            const password = document.getElementById('authLoginPassword').value;
            const remember = !!document.getElementById('authLoginRemember')?.checked;
            const submitButton = loginForm.querySelector('button[type="submit"]');
            const previousButtonLabel = submitButton ? submitButton.textContent : '';
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = 'Ingresando...';
            }
            try {
                const response = await fetch('/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, remember }),
                });
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    showAuthOverlay(error.error || 'No se pudo iniciar sesion', 'error');
                    return;
                }
                hideAuthOverlay();
                window.location.reload();
            } catch (error) {
                console.error('Login failed:', error);
                showAuthOverlay('No se pudo iniciar sesion', 'error');
            } finally {
                loginPending = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = previousButtonLabel || 'Ingresar';
                }
            }
        });
    }

    const registerForm = document.getElementById('authRegisterForm');
    if (registerForm) {
        let registerPending = false;
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (registerPending) return;
            registerPending = true;
            const email = document.getElementById('authRegisterEmail').value.trim();
            const password = document.getElementById('authRegisterPassword').value;
            const remember = !!document.getElementById('authRegisterRemember')?.checked;
            const submitButton = registerForm.querySelector('button[type="submit"]');
            const previousButtonLabel = submitButton ? submitButton.textContent : '';
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = 'Enviando...';
            }
            try {
                const response = await fetch('/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, remember }),
                });
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    showAuthOverlay(error.error || 'No se pudo registrar', 'error');
                    return;
                }
                registerForm.reset();
                showAuthOverlay('Te enviamos un email para verificar tu cuenta. Revisa tu correo.', 'success');
                setAuthTab('login');
            } catch (error) {
                console.error('Register failed:', error);
                showAuthOverlay('No se pudo registrar', 'error');
            } finally {
                registerPending = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = previousButtonLabel || 'Crear cuenta';
                }
            }
        });
    }

    const resetSendButton = document.getElementById('authSendResetCode');
    if (resetSendButton) {
        let resetRequestPending = false;
        resetSendButton.addEventListener('click', async () => {
            if (resetRequestPending) return;
            resetRequestPending = true;
            const email = document.getElementById('authResetEmail')?.value.trim();
            const previousButtonLabel = resetSendButton.textContent;
            resetSendButton.disabled = true;
            resetSendButton.textContent = 'Enviando...';
            if (!email) {
                showAuthOverlay('Ingresa un email valido', 'error');
                resetRequestPending = false;
                resetSendButton.disabled = false;
                resetSendButton.textContent = previousButtonLabel || 'Enviar codigo';
                return;
            }
            try {
                const response = await fetch('/auth/reset/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email }),
                });
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    showAuthOverlay(error.error || 'No se pudo enviar el codigo', 'error');
                    return;
                }
                showAuthOverlay('Te enviamos un codigo al email', 'success');
            } catch (error) {
                console.error('Reset request failed:', error);
                showAuthOverlay('No se pudo enviar el codigo', 'error');
            } finally {
                resetRequestPending = false;
                resetSendButton.disabled = false;
                resetSendButton.textContent = previousButtonLabel || 'Enviar codigo';
            }
        });
    }

    const resetForm = document.getElementById('authResetForm');
    if (resetForm) {
        let resetConfirmPending = false;
        resetForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (resetConfirmPending) return;
            resetConfirmPending = true;
            const email = document.getElementById('authResetEmail')?.value.trim();
            const code = document.getElementById('authResetCode')?.value.trim();
            const password = document.getElementById('authResetPassword')?.value || '';
            const submitButton = resetForm.querySelector('button[type="submit"]');
            const previousButtonLabel = submitButton ? submitButton.textContent : '';
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = 'Enviando...';
            }
            if (!email || !code || !password) {
                showAuthOverlay('Completa todos los campos', 'error');
                resetConfirmPending = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = previousButtonLabel || 'Cambiar contraseña';
                }
                return;
            }
            try {
                const response = await fetch('/auth/reset/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, code, password }),
                });
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    showAuthOverlay(error.error || 'No se pudo actualizar la contraseña', 'error');
                    return;
                }
                showAuthOverlay('Contraseña actualizada. Ya podes ingresar.', 'success');
                setAuthTab('login');
            } catch (error) {
                console.error('Reset confirm failed:', error);
                showAuthOverlay('No se pudo actualizar la contraseña', 'error');
            } finally {
                resetConfirmPending = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = previousButtonLabel || 'Cambiar contraseña';
                }
            }
        });
    }

    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
        logoutButton.addEventListener('click', expenseLogLogout);
    }

    setAuthTab('login');
}

function setupMobileDrawer() {
    const toggleButton = document.getElementById('mobileMenuToggle');
    const drawer = document.getElementById('mobileDrawer');
    const overlay = document.getElementById('mobileDrawerOverlay');
    if (!toggleButton || !drawer || !overlay) return;

    const closeButton = drawer.querySelector('[data-mobile-drawer-close]');
    const drawerLinks = Array.from(drawer.querySelectorAll('.mobile-drawer-link'));
    let isOpen = false;
    let restoreFocusElement = toggleButton;
    const supportsInert = 'inert' in HTMLElement.prototype;

    const updateDrawerActiveState = () => {
        const currentRoute = normalizeNavigationRoute(window.location.pathname, window.location.search);
        drawerLinks.forEach((link) => {
            try {
                const target = new URL(link.href, window.location.origin);
                const targetRoute = normalizeNavigationRoute(target.pathname, target.search);
                const isActive = targetRoute === currentRoute;
                link.classList.toggle('active', isActive);
                if (isActive) {
                    link.setAttribute('aria-current', 'page');
                } else {
                    link.removeAttribute('aria-current');
                }
            } catch (error) {
                console.error('Failed to parse drawer route:', error);
            }
        });
    };
    updateDrawerActiveState();
    window.addEventListener('popstate', updateDrawerActiveState);
    window.addEventListener('expenselog:routechange', updateDrawerActiveState);

    const getFocusableElements = () => {
        return Array.from(
            drawer.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ).filter((element) => {
            if (!(element instanceof HTMLElement)) return false;
            if (element.getAttribute('aria-hidden') === 'true') return false;
            return element.getClientRects().length > 0;
        });
    };

    const syncDrawerVisibility = () => {
        drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
        overlay.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
        if (supportsInert) {
            drawer.inert = !isOpen;
            overlay.inert = !isOpen;
        }
    };

    syncDrawerVisibility();

    const handleKeyDown = (event) => {
        if (!isOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            setDrawerOpen(false);
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = getFocusableElements();
        if (!focusable.length) {
            event.preventDefault();
            drawer.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeElement = document.activeElement;
        const isInsideDrawer = activeElement instanceof Node && drawer.contains(activeElement);

        if (!isInsideDrawer) {
            event.preventDefault();
            first.focus();
            return;
        }
        if (!event.shiftKey && activeElement === last) {
            event.preventDefault();
            first.focus();
            return;
        }
        if (event.shiftKey && activeElement === first) {
            event.preventDefault();
            last.focus();
        }
    };

    const setDrawerOpen = (nextOpen, options = { restoreFocus: true }) => {
        const shouldOpen = Boolean(nextOpen);
        if (shouldOpen === isOpen) return;

        if (!shouldOpen) {
            const activeElement = document.activeElement;
            const focusInsideDrawer = activeElement instanceof Node && drawer.contains(activeElement);
            if (focusInsideDrawer) {
                if (options.restoreFocus !== false && restoreFocusElement instanceof HTMLElement) {
                    restoreFocusElement.focus({ preventScroll: true });
                } else if (activeElement instanceof HTMLElement) {
                    activeElement.blur();
                }
            }
        }

        isOpen = shouldOpen;
        document.body.classList.toggle('mobile-drawer-open', isOpen);
        toggleButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        syncDrawerVisibility();

        if (isOpen) {
            restoreFocusElement = document.activeElement instanceof HTMLElement
                ? document.activeElement
                : toggleButton;
            document.addEventListener('keydown', handleKeyDown);
            const focusable = getFocusableElements();
            const target = focusable[0] || closeButton || drawer;
            requestAnimationFrame(() => target.focus());
            return;
        }

        document.removeEventListener('keydown', handleKeyDown);
        if (
            options.restoreFocus !== false &&
            restoreFocusElement instanceof HTMLElement &&
            document.activeElement !== restoreFocusElement
        ) {
            restoreFocusElement.focus();
        }
    };

    toggleButton.addEventListener('click', () => {
        setDrawerOpen(!isOpen);
    });

    overlay.addEventListener('click', () => setDrawerOpen(false));
    if (closeButton) {
        closeButton.addEventListener('click', () => setDrawerOpen(false));
    }

    drawerLinks.forEach((link) => {
        link.addEventListener('click', () => setDrawerOpen(false, { restoreFocus: false }));
    });
}

function setupMobileBottomNavActiveState() {
    const navLinks = Array.from(document.querySelectorAll('.mobile-bottom-nav .mobile-nav-item'));
    if (navLinks.length === 0) return;

    const updateBottomNavActiveState = () => {
        const currentRoute = normalizeNavigationRoute(window.location.pathname, window.location.search);
        navLinks.forEach((link) => {
            if (!(link instanceof HTMLAnchorElement)) return;
            try {
                const target = new URL(link.href, window.location.origin);
                const targetRoute = normalizeNavigationRoute(target.pathname, target.search);
                const isActive = targetRoute === currentRoute;
                link.classList.toggle('active', isActive);
                if (isActive) {
                    link.setAttribute('aria-current', 'page');
                } else {
                    link.removeAttribute('aria-current');
                }
            } catch (error) {
                console.error('Failed to parse bottom nav route:', error);
            }
        });
    };

    updateBottomNavActiveState();
    window.addEventListener('popstate', updateBottomNavActiveState);
    window.addEventListener('expenselog:routechange', updateBottomNavActiveState);
}

function setupRoutePrefetch() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effectiveType = String(connection?.effectiveType || '').toLowerCase();
    if (connection?.saveData || effectiveType.includes('2g')) {
        return;
    }

    const prefetchQueue = new Set();
    const supportsPrefetch = (() => {
        try {
            return !!document.createElement('link').relList?.supports?.('prefetch');
        } catch (_) {
            return false;
        }
    })();

    const normalizePrefetchPath = (rawPath) => {
        if (!rawPath) return '';
        try {
            const target = new URL(rawPath, window.location.origin);
            if (target.origin !== window.location.origin) return '';
            if (!target.pathname.startsWith('/app')) return '';
            if (target.pathname === window.location.pathname && target.search === window.location.search) return '';
            return `${target.pathname}${target.search}`;
        } catch (_) {
            return '';
        }
    };

    const prefetchPath = (rawPath) => {
        const path = normalizePrefetchPath(rawPath);
        if (!path || prefetchQueue.has(path)) return;
        prefetchQueue.add(path);

        if (supportsPrefetch) {
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.as = 'document';
            link.href = path;
            document.head.appendChild(link);
            return;
        }

        fetch(path, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'force-cache',
        }).catch(() => {});
    };

    const bindPrefetch = (node, getPath) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.dataset.prefetchBound === 'true') return;
        node.dataset.prefetchBound = 'true';
        const onIntent = () => prefetchPath(getPath());
        node.addEventListener('pointerenter', onIntent, { passive: true });
        node.addEventListener('focus', onIntent, { passive: true });
        node.addEventListener('touchstart', onIntent, { passive: true });
    };

    document.querySelectorAll('a[href]').forEach((link) => {
        bindPrefetch(link, () => link.getAttribute('href') || '');
    });

    document.querySelectorAll('[data-settings-route]').forEach((button) => {
        bindPrefetch(button, () => button.getAttribute('data-settings-route') || '');
    });

    const warmRoutes = (() => {
        const path = String(window.location.pathname || '').toLowerCase();
        const search = String(window.location.search || '').toLowerCase();
        if (path === '/app' || path === '/app/' || path === '/app/index' || path === '/app/index.html') {
            return ['/app/table', '/app/table?view=calendar', '/app/analisis', '/app/reportes', '/app/perfil'];
        }
        if (path.startsWith('/app/analisis')) {
            return ['/app', '/app/table', '/app/table?view=calendar', '/app/perfil', '/app/reportes'];
        }
        if (path.startsWith('/app/table')) {
            if (search.includes('view=calendar')) {
                return ['/app/table', '/app', '/app/analisis', '/app/reportes', '/app/perfil'];
            }
            return ['/app/table?view=calendar', '/app', '/app/analisis', '/app/reportes', '/app/perfil'];
        }
        if (path.startsWith('/app/perfil') || path.startsWith('/app/settings')) {
            return ['/app/analisis', '/app/reportes', '/app/bots', '/app/table', '/app/categorias', '/app/recurrentes', '/app'];
        }
        if (path.startsWith('/app/categorias') || path.startsWith('/app/recurrentes') || path.startsWith('/app/conciliacion') || path.startsWith('/app/reportes') || path.startsWith('/app/bots') || path.startsWith('/app/telegram') || path.startsWith('/app/whatsapp')) {
            return ['/app/perfil', '/app/table', '/app/table?view=calendar', '/app/analisis', '/app'];
        }
        return ['/app', '/app/table', '/app/table?view=calendar', '/app/analisis', '/app/reportes'];
    })();

    const scheduleWarmup = window.requestIdleCallback
        ? window.requestIdleCallback.bind(window)
        : (cb) => window.setTimeout(cb, 350);

    scheduleWarmup(() => {
        warmRoutes.forEach((route) => prefetchPath(route));
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const cachedPlanTier = readPlanTierCache()?.planTier || 'free';
    applyPlanAwareAnalyticsNavigation(cachedPlanTier);
    setupAuthUI();
    setupMobileDrawer();
    setupMobileBottomNavActiveState();
    setupRoutePrefetch();
    showAuthMessageFromURL();
    if (!authChecked) {
        checkAuthStatus();
    }
});

window.addEventListener('focus', () => {
    if (!document.getElementById('authOverlay')) return;
    checkAuthStatus();
});

function formatCurrency(amount) {
    const behavior = currencyBehaviors[currentCurrency] || {
        symbol: "$",
        useComma: false,
        useDecimals: true,
        useSpace: false,
        right: false,
    };
    const isNegative = amount < 0;
    const absAmount = Math.abs(amount);
    const options = {
        minimumFractionDigits: behavior.useDecimals ? 2 : 0,
        maximumFractionDigits: behavior.useDecimals ? 2 : 0,
    };
    let formattedAmount = new Intl.NumberFormat(behavior.useComma ? "de-DE" : "en-US",options).format(absAmount);
    let result = behavior.right
        ? `${formattedAmount}${behavior.useSpace ? " " : ""}${behavior.symbol}`
        : `${behavior.symbol}${behavior.useSpace ? " " : ""}${formattedAmount}`;
    return isNegative ? `-${result}` : result;
}

function getUserTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const EXPENSE_FORM_PREFS_KEY = 'expenselog_expense_form_prefs_v1';

function readExpenseFormPrefs() {
    try {
        const raw = localStorage.getItem(EXPENSE_FORM_PREFS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed;
    } catch (_) {
        return {};
    }
}

function writeExpenseFormPrefs(next) {
    try {
        localStorage.setItem(EXPENSE_FORM_PREFS_KEY, JSON.stringify(next || {}));
    } catch (_) {
        // ignore storage failures
    }
}

function getPreferredExpenseSource() {
    const prefs = readExpenseFormPrefs();
    const source = String(prefs.source || '').toUpperCase();
    if (source === 'CA' || source === 'EFECTIVO' || source === 'TARJETA') {
        return source;
    }
    return '';
}

function getPreferredExpenseCurrency(supportedCurrencyCodes = []) {
    const prefs = readExpenseFormPrefs();
    const currency = String(prefs.currency || '').toLowerCase();
    if (!currency) return '';
    if (Array.isArray(supportedCurrencyCodes) && supportedCurrencyCodes.length > 0) {
        return supportedCurrencyCodes.includes(currency) ? currency : '';
    }
    return currency;
}

function rememberExpenseFormPrefs(input) {
    const current = readExpenseFormPrefs();
    const next = { ...current };
    if (input && typeof input === 'object') {
        if (input.source !== undefined) {
            const source = String(input.source || '').toUpperCase();
            if (source === 'CA' || source === 'EFECTIVO' || source === 'TARJETA') {
                next.source = source;
            }
        }
        if (input.currency !== undefined) {
            const currency = String(input.currency || '').toLowerCase();
            if (currency) {
                next.currency = currency;
            }
        }
    }
    writeExpenseFormPrefs(next);
}

function formatMonth(date) {
    const formatted = date.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: 'long',
        timeZone: getUserTimeZone()
    });
    // Capitaliza la primera letra para mostrar el mes en mayuscula inicial.
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function getISODateWithLocalTime(dateInput) {
    const [year, month, day] = dateInput.split('-').map(Number);
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const milliseconds = now.getMilliseconds();
    const localDateTime = new Date(year, month - 1, day, hours, minutes, seconds, milliseconds);
    return localDateTime.toISOString();
}

// Stores date-only fields (like recurring start date) at local noon to avoid timezone day-shifts.
function getISODateWithLocalNoon(dateInput) {
    const [year, month, day] = dateInput.split('-').map(Number);
    const localNoon = new Date(year, month - 1, day, 12, 0, 0, 0);
    return localNoon.toISOString();
}

// Reads ISO date fields as calendar dates (UTC components) for stable YYYY-MM-DD inputs.
function getDateInputValueFromISO(isoDateString) {
    const date = new Date(isoDateString);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDateFromUTC(utcDateString) {
    const date = new Date(utcDateString);
    return date.toLocaleDateString('es-AR', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
    });
}

function updateMonthDisplay() {
    const currentMonthEl = document.getElementById('currentMonth');
    if (currentMonthEl) {
        currentMonthEl.textContent = formatMonth(currentDate);
    }
}

function getMonthBounds(date) {
    const localDate = new Date(date);
    if (startDate === 1) {
        const startLocal = new Date(localDate.getFullYear(), localDate.getMonth(), 1);
        const endLocal = new Date(localDate.getFullYear(), localDate.getMonth() + 1, 0, 23, 59, 59, 999);
        return { start: new Date(startLocal.toISOString()), end: new Date(endLocal.toISOString()) };
    }
    let thisMonthStartDate = startDate;
    let prevMonthStartDate = startDate;

    const currentMonth = localDate.getMonth();
    const currentYear = localDate.getFullYear();
    const daysInCurrentMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    thisMonthStartDate = Math.min(thisMonthStartDate, daysInCurrentMonth);
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const daysInPrevMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
    prevMonthStartDate = Math.min(prevMonthStartDate, daysInPrevMonth);

    if (localDate.getDate() < thisMonthStartDate) {
        const startLocal = new Date(prevYear, prevMonth, prevMonthStartDate);
        const endLocal = new Date(currentYear, currentMonth, thisMonthStartDate - 1, 23, 59, 59, 999);
        return { start: new Date(startLocal.toISOString()), end: new Date(endLocal.toISOString()) };
    } else {
        const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
        const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
        const daysInNextMonth = new Date(nextYear, nextMonth + 1, 0).getDate();
        let nextMonthStartDate = Math.min(startDate, daysInNextMonth);
        const startLocal = new Date(currentYear, currentMonth, thisMonthStartDate);
        const endLocal = new Date(nextYear, nextMonth, nextMonthStartDate - 1, 23, 59, 59, 999);
        return { start: new Date(startLocal.toISOString()), end: new Date(endLocal.toISOString()) };
    }
}

function getComparableExpenseDate(exp) {
    const rawDate = new Date(exp?.date);
    if (Number.isNaN(rawDate.getTime())) return new Date(0);
    if (!exp?.recurringID) return rawDate;
    const ymd = getDateInputValueFromISO(exp.date);
    if (!ymd) return rawDate;
    const [year, month, day] = ymd.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function getExpenseCreatedAtDate(exp) {
    const created = exp?.createdAt ? new Date(exp.createdAt) : null;
    if (created && !Number.isNaN(created.getTime())) return created;
    return getComparableExpenseDate(exp);
}

function compareExpensesDesc(a, b) {
    const primary = getComparableExpenseDate(b).getTime() - getComparableExpenseDate(a).getTime();
    if (primary !== 0) return primary;
    const byCreatedAt = getExpenseCreatedAtDate(b).getTime() - getExpenseCreatedAtDate(a).getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
}

function compareExpensesAsc(a, b) {
    const primary = getComparableExpenseDate(a).getTime() - getComparableExpenseDate(b).getTime();
    if (primary !== 0) return primary;
    const byCreatedAt = getExpenseCreatedAtDate(a).getTime() - getExpenseCreatedAtDate(b).getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function getMonthExpenses(expenses) {
    const { start, end } = getMonthBounds(currentDate);
    return expenses.filter(exp => {
        const expDate = getComparableExpenseDate(exp);
        return expDate >= start && expDate <= end;
    }).sort(compareExpensesDesc);
}

function escapeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g,
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function showToast(message, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type || ''}`.trim();
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.remove();
    }, 3000);
}
