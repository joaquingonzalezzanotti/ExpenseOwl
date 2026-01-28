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

let authChecked = false;

async function checkAuthStatus() {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return null;
    try {
        const res = await fetch('/auth/me');
        if (res.ok) {
            const user = await res.json();
            hideAuthOverlay();
            authChecked = true;
            return user;
        }
        if (res.status === 401) {
            showAuthOverlay();
            authChecked = true;
            return null;
        }
        showAuthOverlay('No se pudo validar la sesion');
    } catch (error) {
        console.error('Auth check failed:', error);
        showAuthOverlay('No se pudo validar la sesion');
    }
    authChecked = true;
    return null;
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

function showAuthOverlay(message) {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('auth-locked');
    const msg = document.getElementById('authMessage');
    if (msg) {
        msg.textContent = message || '';
        msg.className = message ? 'form-message error' : 'form-message';
    }
}

function hideAuthOverlay() {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('auth-locked');
}

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

    const loginForm = document.getElementById('authLoginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('authLoginEmail').value.trim();
            const password = document.getElementById('authLoginPassword').value;
            const remember = !!document.getElementById('authLoginRemember')?.checked;
            try {
                const response = await fetch('/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, remember }),
                });
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    showAuthOverlay(error.error || 'No se pudo iniciar sesion');
                    return;
                }
                hideAuthOverlay();
                window.location.reload();
            } catch (error) {
                console.error('Login failed:', error);
                showAuthOverlay('No se pudo iniciar sesion');
            }
        });
    }

    const registerForm = document.getElementById('authRegisterForm');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('authRegisterEmail').value.trim();
            const password = document.getElementById('authRegisterPassword').value;
            const remember = !!document.getElementById('authRegisterRemember')?.checked;
            try {
                const response = await fetch('/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, remember }),
                });
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    showAuthOverlay(error.error || 'No se pudo registrar');
                    return;
                }
                hideAuthOverlay();
                window.location.reload();
            } catch (error) {
                console.error('Register failed:', error);
                showAuthOverlay('No se pudo registrar');
            }
        });
    }

    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            try {
                await fetch('/auth/logout', { method: 'POST' });
            } catch (error) {
                console.error('Logout failed:', error);
            } finally {
                showAuthOverlay();
                window.location.reload();
            }
        });
    }

    setAuthTab('login');
}

document.addEventListener('DOMContentLoaded', () => {
    setupAuthUI();
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
    const localDateTime = new Date(year, month - 1, day, hours, minutes, seconds);
    return localDateTime.toISOString();
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

function getMonthExpenses(expenses) {
    const { start, end } = getMonthBounds(currentDate);
    return expenses.filter(exp => {
        const expDate = new Date(exp.date);
        return expDate >= start && expDate <= end;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
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
