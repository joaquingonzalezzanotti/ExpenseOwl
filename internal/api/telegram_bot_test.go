package api

import (
	"net/http"
	"testing"
	"time"
)

func TestNormalizeTelegramLinkCode(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "abcd-1234", want: "ABCD1234"},
		{input: "ab cd 12 34", want: "ABCD1234"},
		{input: "ABCD1234", want: "ABCD1234"},
		{input: "AB12", want: ""},
		{input: "ABC#1234", want: ""},
	}
	for _, tt := range tests {
		got := normalizeTelegramLinkCode(tt.input)
		if got != tt.want {
			t.Fatalf("normalizeTelegramLinkCode(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestParseTelegramDateTime(t *testing.T) {
	fallback := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)

	gotRFC := parseTelegramDateTime("2026-03-01T11:15:00-03:00", fallback)
	if gotRFC.Year() != 2026 || gotRFC.Month() != time.March || gotRFC.Day() != 1 {
		t.Fatalf("expected RFC3339 parse to keep date, got %v", gotRFC)
	}

	gotAR := parseTelegramDateTime("01/03/2026 19:45", fallback)
	if gotAR.Year() != 2026 || gotAR.Month() != time.March || gotAR.Day() != 1 || gotAR.Hour() != 19 {
		t.Fatalf("expected AR parse to work, got %v", gotAR)
	}

	gotFallback := parseTelegramDateTime("invalid", fallback)
	if !gotFallback.Equal(fallback) {
		t.Fatalf("expected fallback on invalid datetime, got %v", gotFallback)
	}
}

func TestFormatTelegramLinkCode(t *testing.T) {
	got := formatTelegramLinkCode("ABCDEFG1")
	if got != "ABCD-EFG1" {
		t.Fatalf("formatTelegramLinkCode returned %q", got)
	}
}

func TestSanitizeTelegramBotUsername(t *testing.T) {
	if got := sanitizeTelegramBotUsername("@ExpenseLogBot"); got != "ExpenseLogBot" {
		t.Fatalf("sanitizeTelegramBotUsername returned %q", got)
	}
	if got := sanitizeTelegramBotUsername("ab"); got != "" {
		t.Fatalf("expected invalid short username to be rejected, got %q", got)
	}
}

func TestNormalizeBotExpenseSource(t *testing.T) {
	tests := []struct {
		provider string
		want     string
	}{
		{provider: "", want: ""},
		{provider: "UNKNOWN", want: ""},
		{provider: "Desconocido", want: ""},
		{provider: "No especificado", want: ""},
		{provider: "MODO", want: "CA"},
		{provider: "Galicia", want: "CA"},
		{provider: "Transferencia", want: "CA"},
		{provider: "Tarjeta debito", want: "CA"},
		{provider: "Visa Debito", want: "CA"},
		{provider: "Santander Visa Débito - 2959", want: "CA"},
		{provider: "Debit card", want: "CA"},
		{provider: "Tarjeta credito", want: "TARJETA"},
		{provider: "VISA", want: "TARJETA"},
		{provider: "Efectivo", want: "EFECTIVO"},
	}
	for _, tt := range tests {
		got := normalizeBotExpenseSource(tt.provider)
		if got != tt.want {
			t.Fatalf("normalizeBotExpenseSource(%q) = %q, want %q", tt.provider, got, tt.want)
		}
	}
}

func TestBuildBotExpenseNameOmitsOpaqueReferenceAndGenericMotive(t *testing.T) {
	got := buildBotExpenseName(
		"Santiago Javier Mercau",
		"VAR",
		"c5fe2df2-55b7-4f96-9fa8-4a2fd30732db",
	)
	if got != "Santiago Javier Mercau" {
		t.Fatalf("buildBotExpenseName should keep only counterparty, got %q", got)
	}
}

func TestBuildBotExpenseNameKeepsUsefulDetails(t *testing.T) {
	got := buildBotExpenseName("Farmacia Central", "Ibuprofeno", "A12345")
	if got != "Ibuprofeno - Farmacia Central" {
		t.Fatalf("unexpected bot expense name: %q", got)
	}
}

func TestBuildBotExpenseNameUsesCounterpartyFallback(t *testing.T) {
	got := buildBotExpenseName("Juan Jose Palacio", "VAR", "A12345")
	if got != "Juan Jose Palacio" {
		t.Fatalf("expected counterparty fallback, got %q", got)
	}
}

func TestBuildBotExpenseURLUsesConfiguredAppBaseURL(t *testing.T) {
	t.Setenv("APP_BASE_URL", "https://www.expenselog.com.ar/")
	req, err := http.NewRequest(http.MethodPost, "https://ignored.test/api/bot/expense", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}

	got := buildBotExpenseURL(req)
	if got != "https://www.expenselog.com.ar/app/table" {
		t.Fatalf("unexpected bot expense url: %q", got)
	}
}

func TestBuildBotExpenseURLFallsBackToLocalRequestBase(t *testing.T) {
	t.Setenv("APP_BASE_URL", "")
	req, err := http.NewRequest(http.MethodPost, "http://localhost:8080/api/bot/expense", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = "localhost:8080"

	got := buildBotExpenseURL(req)
	if got != "http://localhost:8080/app/table" {
		t.Fatalf("unexpected bot expense url from local request: %q", got)
	}
}
