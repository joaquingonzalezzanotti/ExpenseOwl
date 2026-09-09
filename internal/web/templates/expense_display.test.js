const test = require("node:test");
const assert = require("node:assert/strict");
const ExpenseDisplay = require("./expense_display.js");

test("telegram display uses useful motive as title and counterparty as secondary", () => {
    const display = ExpenseDisplay.resolveExpenseDisplayParts({
        name: "Juan Jose Palacio - Empanadas en el almuerzo (ABC123)",
        systemOrigin: "telegram_bot",
    });

    assert.equal(display.title, "Empanadas en el almuerzo");
    assert.equal(display.secondary, "Juan Jose Palacio");
});

test("telegram display falls back to counterparty when motive is technical", () => {
    const display = ExpenseDisplay.resolveExpenseDisplayParts({
        name: "Juan Jose Palacio - VAR",
        tags: ["telegram_bot"],
    });

    assert.equal(display.title, "Juan Jose Palacio");
    assert.equal(display.secondary, "");
});
