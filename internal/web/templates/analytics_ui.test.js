const assert = require("node:assert/strict");
const test = require("node:test");
const AnalyticsUI = require("./analytics_ui.js");

test("sin tarjeta excluye consumos y pagos de tarjeta", () => {
    const rows = [
        { amount: 100000, currency: "ars", source: "CA", flow: "income" },
        { amount: -20000, currency: "ars", source: "CA", flow: "expense", category: "Comida" },
        { amount: -15000, currency: "ars", source: "TARJETA", flow: "expense", category: "Viajes" },
        { amount: -10000, currency: "ars", source: "CA", flow: "expense", category: "Tarjeta por pagar", systemOrigin: "card_payment_owner" },
    ];

    const scope = AnalyticsUI.buildScopedAnalytics(rows, {
        includeCreditCard: false,
        fallbackCurrency: "ars",
        currency: "ars",
    });

    assert.equal(scope.visibleMovements.length, 2);
    assert.equal(scope.expenseMovements.length, 1);
    assert.equal(scope.totalIncome, 100000);
    assert.equal(scope.totalRefund, 0);
    assert.equal(scope.totalExpenses, 20000);
    assert.equal(scope.totalCashSpend, 20000);
    assert.equal(scope.totalCardSpend, 0);
});

test("con tarjeta incluye consumos pero excluye pagos para evitar doble conteo", () => {
    const rows = [
        { amount: 100000, currency: "ars", source: "CA", flow: "income" },
        { amount: 3000, currency: "ars", source: "CA", flow: "refund" },
        { amount: -20000, currency: "ars", source: "CA", flow: "expense", category: "Comida" },
        { amount: -15000, currency: "ars", source: "TARJETA", flow: "expense", category: "Viajes" },
        { amount: -10000, currency: "ars", source: "CA", flow: "expense", category: "Tarjeta por pagar", systemOrigin: "card_payment_owner" },
    ];

    const scope = AnalyticsUI.buildScopedAnalytics(rows, {
        includeCreditCard: true,
        fallbackCurrency: "ars",
        currency: "ars",
    });

    assert.equal(scope.visibleMovements.length, 4);
    assert.equal(scope.expenseMovements.length, 2);
    assert.equal(scope.totalIncome, 100000);
    assert.equal(scope.totalRefund, 3000);
    assert.equal(scope.totalInflow, 103000);
    assert.equal(scope.totalExpenses, 35000);
    assert.equal(scope.totalCashSpend, 20000);
    assert.equal(scope.totalCardSpend, 15000);
});

test("reversion de conciliacion no infla ingresos del resumen", () => {
    const rows = [
        { amount: 100000, currency: "ars", source: "CA", flow: "income" },
        { amount: 5000, currency: "ars", source: "CA", flow: "income", systemOrigin: "reconciliation_adjustment" },
        { amount: -5000, currency: "ars", source: "CA", flow: "expense", systemOrigin: "reconciliation_reversal" },
    ];

    const scope = AnalyticsUI.buildScopedAnalytics(rows, {
        includeCreditCard: false,
        fallbackCurrency: "ars",
        currency: "ars",
    });

    assert.equal(scope.totalIncome, 100000);
    assert.equal(scope.totalExpenses, 0);
});

test("reintegro suma a caja disponible pero no infla KPI de ingresos", () => {
    const rows = [
        { amount: 100000, currency: "ars", source: "CA", flow: "income" },
        { amount: -30000, currency: "ars", source: "CA", flow: "expense", category: "Viajes" },
        { amount: 10000, currency: "ars", source: "CA", flow: "refund", category: "Viajes" },
    ];

    const scope = AnalyticsUI.buildScopedAnalytics(rows, {
        includeCreditCard: false,
        fallbackCurrency: "ars",
        currency: "ars",
    });

    assert.equal(scope.totalIncome, 100000);
    assert.equal(scope.totalRefund, 10000);
    assert.equal(scope.totalInflow, 110000);
    assert.equal(scope.totalExpenses, 30000);
});
