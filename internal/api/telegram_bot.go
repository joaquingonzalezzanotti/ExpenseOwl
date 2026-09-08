package api

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"github.com/joaquingonzalezzanotti/ExpenseLog/internal/storage"
)

const (
	telegramBotSecretHeader = "X-ExpenseLog-Bot-Secret"
	telegramLinkCodeTTL     = 10 * time.Minute
	telegramCodeAlphabet    = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	telegramCodeLength      = 8
)

var telegramBotUsernameRE = regexp.MustCompile(`^[a-zA-Z0-9_]{5,64}$`)

type botAPIErrorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

type telegramLinkStatusResponse struct {
	Premium          bool                    `json:"premium"`
	Linked           bool                    `json:"linked"`
	TelegramUserID   *int64                  `json:"telegram_user_id,omitempty"`
	TelegramUsername string                  `json:"telegram_username,omitempty"`
	LinkedAt         *time.Time              `json:"linked_at,omitempty"`
	ActiveCode       *telegramActiveCodeView `json:"active_code,omitempty"`
	BotURL           string                  `json:"bot_url,omitempty"`
	BotUsername      string                  `json:"bot_username,omitempty"`
}

type telegramActiveCodeView struct {
	CodeMasked string    `json:"code_masked"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type telegramCreateCodeResponse struct {
	Code        string    `json:"code"`
	ExpiresAt   time.Time `json:"expires_at"`
	BotURL      string    `json:"bot_url,omitempty"`
	DeepLinkURL string    `json:"deep_link_url,omitempty"`
}

type consumeLinkCodeRequest struct {
	Code             string `json:"code"`
	TelegramUserID   int64  `json:"telegram_user_id"`
	TelegramUsername string `json:"telegram_username"`
}

type botLinkStatusRequest struct {
	TelegramUserID int64 `json:"telegram_user_id"`
}

type botLinkStatusResponse struct {
	Linked  bool `json:"linked"`
	Premium bool `json:"premium"`
}

type botExpensePayload struct {
	TelegramUserID int64           `json:"telegram_user_id"`
	Type           string          `json:"type"`
	Amount         float64         `json:"amount"`
	Currency       string          `json:"currency"`
	DateTimeISO    string          `json:"datetime_iso"`
	Counterparty   string          `json:"counterparty"`
	Reference      string          `json:"reference"`
	Motive         string          `json:"motive"`
	Category       string          `json:"category"`
	Tags           []string        `json:"tags"`
	Provider       string          `json:"provider"`
	SourceMeta     json.RawMessage `json:"source_meta"`
}

type botExpenseResponse struct {
	TransactionID string `json:"transaction_id"`
	URL           string `json:"url"`
}

func writeBotError(w http.ResponseWriter, status int, errMessage string, code string) {
	writeJSON(w, status, botAPIErrorResponse{
		Error: errMessage,
		Code:  code,
	})
}

func (h *Handler) RequireBotAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret := strings.TrimSpace(os.Getenv("EXPENSELOG_BOT_INTERNAL_SECRET"))
		if secret == "" {
			writeBotError(w, http.StatusUnauthorized, "Bot integration is not configured", "unauthorized")
			return
		}
		headerSecret := strings.TrimSpace(r.Header.Get(telegramBotSecretHeader))
		if headerSecret == "" || headerSecret != secret {
			writeBotError(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
			return
		}
		next(w, r)
	}
}

func (h *Handler) isUserPremium(userID string) (bool, error) {
	planTier, err := h.storage.GetUserPlanTier(userID)
	if err != nil {
		return false, err
	}
	return storage.NormalizePlanTier(planTier) == storage.PlanTierPremium, nil
}

func sanitizeTelegramBotUsername(raw string) string {
	username := strings.TrimPrefix(strings.TrimSpace(raw), "@")
	if !telegramBotUsernameRE.MatchString(username) {
		return ""
	}
	return username
}

func telegramBotUsernameFromEnv() string {
	return sanitizeTelegramBotUsername(os.Getenv("TELEGRAM_BOT_USERNAME"))
}

func telegramBotURL(username string) string {
	if username == "" {
		return ""
	}
	return fmt.Sprintf("https://t.me/%s", username)
}

func normalizeTelegramLinkCode(raw string) string {
	compact := strings.ToUpper(strings.TrimSpace(raw))
	compact = strings.ReplaceAll(compact, "-", "")
	compact = strings.ReplaceAll(compact, " ", "")
	if len(compact) != telegramCodeLength {
		return ""
	}
	for _, r := range compact {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return ""
		}
	}
	return compact
}

func formatTelegramLinkCode(compact string) string {
	if len(compact) != telegramCodeLength {
		return compact
	}
	return fmt.Sprintf("%s-%s", compact[:4], compact[4:])
}

func maskTelegramLinkCode(_ storage.TelegramLinkCode) string {
	return "****-****"
}

func hashTelegramLinkCode(compact string) string {
	sum := sha256.Sum256([]byte(compact))
	return hex.EncodeToString(sum[:])
}

func newTelegramLinkCode() (string, error) {
	var b strings.Builder
	for i := 0; i < telegramCodeLength; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(telegramCodeAlphabet))))
		if err != nil {
			return "", err
		}
		b.WriteByte(telegramCodeAlphabet[n.Int64()])
	}
	return b.String(), nil
}

func isUniqueViolationOnCodeHash(err error) bool {
	var pqErr *pq.Error
	if !errors.As(err, &pqErr) {
		return false
	}
	return string(pqErr.Code) == "23505" && pqErr.Constraint == "telegram_link_codes_code_hash_key"
}

func parseTelegramDateTime(value string, fallback time.Time) time.Time {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return fallback
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006-01-02",
		"02/01/2006 15:04",
		"02/01/2006",
	}
	for _, layout := range layouts {
		if ts, err := time.Parse(layout, raw); err == nil {
			return ts
		}
	}
	location, err := time.LoadLocation("America/Argentina/Buenos_Aires")
	if err != nil {
		location = time.FixedZone("-03", -3*60*60)
	}
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "02/01/2006 15:04", "02/01/2006"} {
		if ts, err := time.ParseInLocation(layout, raw, location); err == nil {
			return ts
		}
	}
	return fallback
}

func uniqueTags(tags []string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		clean := storage.SanitizeString(tag)
		if clean == "" {
			continue
		}
		key := strings.ToLower(clean)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, clean)
	}
	return out
}

func buildBotExpenseName(counterparty, motive, reference string) string {
	base := strings.TrimSpace(counterparty)
	if base == "" {
		base = "Movimiento Telegram"
	}
	motive = normalizeBotExpenseMotive(motive)
	reference = normalizeBotExpenseReference(reference)
	switch {
	case motive != "" && reference != "":
		return fmt.Sprintf("%s - %s (%s)", base, motive, reference)
	case motive != "":
		return fmt.Sprintf("%s - %s", base, motive)
	case reference != "":
		return fmt.Sprintf("%s (%s)", base, reference)
	default:
		return base
	}
}

func normalizeBotExpenseMotive(raw string) string {
	clean := storage.SanitizeString(raw)
	if clean == "" {
		return ""
	}
	if strings.EqualFold(clean, "var") {
		return ""
	}
	return clean
}

func normalizeBotExpenseReference(raw string) string {
	clean := storage.SanitizeString(raw)
	if clean == "" {
		return ""
	}
	if _, err := uuid.Parse(clean); err == nil {
		return ""
	}
	if len(clean) > 24 {
		return ""
	}
	return clean
}

func buildBotExpenseURL(r *http.Request) string {
	base, err := externalBaseURL(r)
	if err != nil {
		return "/app/table"
	}
	return strings.TrimRight(base, "/") + "/app/table"
}

func normalizeBotExpenseSource(provider string) string {
	clean := strings.ToUpper(storage.SanitizeString(provider))
	clean = strings.NewReplacer(
		"Á", "A",
		"À", "A",
		"Â", "A",
		"Ã", "A",
		"Ä", "A",
		"É", "E",
		"È", "E",
		"Ê", "E",
		"Ë", "E",
		"Í", "I",
		"Ì", "I",
		"Î", "I",
		"Ï", "I",
		"Ó", "O",
		"Ò", "O",
		"Ô", "O",
		"Õ", "O",
		"Ö", "O",
		"Ú", "U",
		"Ù", "U",
		"Û", "U",
		"Ü", "U",
		"Ñ", "N",
	).Replace(clean)
	switch {
	case clean == "", clean == "UNKNOWN", clean == "DESCONOCIDO", clean == "NO ESPECIFICADO":
		return ""
	case strings.Contains(clean, "EFECTIVO"), strings.Contains(clean, "CASH"):
		return "EFECTIVO"
	case strings.Contains(clean, "DEBITO"),
		strings.Contains(clean, "DEBIT"),
		strings.Contains(clean, "TRANSFER"),
		strings.Contains(clean, "BANCO"),
		strings.Contains(clean, "BANK"),
		strings.Contains(clean, "WALLET"),
		strings.Contains(clean, "MODO"),
		strings.Contains(clean, "GALICIA"):
		return "CA"
	case strings.Contains(clean, "TARJETA"),
		strings.Contains(clean, "CREDITO"),
		strings.Contains(clean, "CREDIT"),
		strings.Contains(clean, "VISA"),
		strings.Contains(clean, "MASTERCARD"),
		strings.Contains(clean, "AMEX"):
		return "TARJETA"
	default:
		// Bot providers such as MODO/GALICIA are channels, not payment methods.
		return "CA"
	}
}

func (h *Handler) buildTelegramLinkStatusResponse(userID string, now time.Time) (telegramLinkStatusResponse, error) {
	premium, err := h.isUserPremium(userID)
	if err != nil {
		return telegramLinkStatusResponse{}, err
	}
	username := telegramBotUsernameFromEnv()
	response := telegramLinkStatusResponse{
		Premium:     premium,
		Linked:      false,
		BotUsername: username,
		BotURL:      telegramBotURL(username),
	}

	link, err := h.storage.GetTelegramUserLinkByUserID(userID)
	if err != nil && err != sql.ErrNoRows {
		return telegramLinkStatusResponse{}, err
	}
	if err == nil {
		response.Linked = true
		response.TelegramUserID = &link.TelegramUserID
		response.TelegramUsername = link.TelegramUsername
		response.LinkedAt = &link.CreatedAt
	}

	activeCode, err := h.storage.GetActiveTelegramLinkCode(userID, now)
	if err != nil && err != sql.ErrNoRows {
		return telegramLinkStatusResponse{}, err
	}
	if err == nil {
		response.ActiveCode = &telegramActiveCodeView{
			CodeMasked: maskTelegramLinkCode(activeCode),
			ExpiresAt:  activeCode.ExpiresAt,
		}
	}

	return response, nil
}

func (h *Handler) GetTelegramLinkStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	response, err := h.buildTelegramLinkStatusResponse(userID, time.Now().UTC())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "No se pudo obtener el estado de Telegram"})
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) RefreshTelegramLinkStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	response, err := h.buildTelegramLinkStatusResponse(userID, time.Now().UTC())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "No se pudo actualizar el estado de Telegram"})
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) CreateTelegramLinkCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	premium, err := h.isUserPremium(userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "No se pudo validar el plan actual"})
		return
	}
	if !premium {
		writeBotError(w, http.StatusForbidden, "Disponible solo para cuentas Premium", "premium_required")
		return
	}

	now := time.Now().UTC()
	if err := h.storage.InvalidateActiveTelegramLinkCodes(userID, now); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "No se pudo limpiar codigos previos"})
		return
	}

	var compactCode string
	var stored storage.TelegramLinkCode
	for attempts := 0; attempts < 5; attempts++ {
		compactCode, err = newTelegramLinkCode()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "No se pudo generar codigo de vinculacion"})
			return
		}
		stored, err = h.storage.CreateTelegramLinkCode(
			userID,
			hashTelegramLinkCode(compactCode),
			now.Add(telegramLinkCodeTTL),
			now,
		)
		if err == nil {
			break
		}
		if !isUniqueViolationOnCodeHash(err) {
			writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "No se pudo guardar codigo de vinculacion"})
			return
		}
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "No se pudo generar codigo unico"})
		return
	}

	botUsername := telegramBotUsernameFromEnv()
	botURL := telegramBotURL(botUsername)
	deepLinkURL := ""
	if botURL != "" {
		deepLinkURL = fmt.Sprintf("%s?start=vincular_%s", botURL, compactCode)
	}
	writeJSON(w, http.StatusOK, telegramCreateCodeResponse{
		Code:        formatTelegramLinkCode(compactCode),
		ExpiresAt:   stored.ExpiresAt,
		BotURL:      botURL,
		DeepLinkURL: deepLinkURL,
	})
}

func (h *Handler) ConsumeTelegramLinkCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeBotError(w, http.StatusMethodNotAllowed, "Method not allowed", "method_not_allowed")
		return
	}
	var payload consumeLinkCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeBotError(w, http.StatusBadRequest, "Invalid request body", "invalid_payload")
		return
	}
	if payload.TelegramUserID <= 0 {
		writeBotError(w, http.StatusBadRequest, "telegram_user_id is required", "invalid_payload")
		return
	}
	compactCode := normalizeTelegramLinkCode(payload.Code)
	if compactCode == "" {
		writeBotError(w, http.StatusBadRequest, "El codigo no es valido", "invalid_link_code")
		return
	}

	_, err := h.storage.ConsumeTelegramLinkCode(
		hashTelegramLinkCode(compactCode),
		payload.TelegramUserID,
		payload.TelegramUsername,
		time.Now().UTC(),
	)
	if err != nil {
		switch {
		case errors.Is(err, storage.ErrTelegramInvalidLinkCode):
			writeBotError(w, http.StatusBadRequest, "El codigo no es valido", "invalid_link_code")
		case errors.Is(err, storage.ErrTelegramLinkCodeExpired):
			writeBotError(w, http.StatusBadRequest, "El codigo ya vencio", "link_code_expired")
		case errors.Is(err, storage.ErrTelegramLinkCodeUsed):
			writeBotError(w, http.StatusConflict, "El codigo ya fue usado", "link_code_used")
		case errors.Is(err, storage.ErrTelegramPremiumRequired):
			writeBotError(w, http.StatusForbidden, "Necesitas Premium activo para vincular Telegram", "premium_required")
		case errors.Is(err, storage.ErrTelegramAlreadyLinked):
			writeBotError(w, http.StatusConflict, "La cuenta de ExpenseLog ya esta vinculada", "already_linked")
		case errors.Is(err, storage.ErrTelegramUserAlreadyLinked):
			writeBotError(w, http.StatusConflict, "Este Telegram ya esta vinculado", "telegram_already_linked")
		default:
			writeBotError(w, http.StatusInternalServerError, "No se pudo completar la vinculacion", "internal_error")
		}
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) GetBotTelegramLinkStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeBotError(w, http.StatusMethodNotAllowed, "Method not allowed", "method_not_allowed")
		return
	}
	var payload botLinkStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeBotError(w, http.StatusBadRequest, "Invalid request body", "invalid_payload")
		return
	}
	if payload.TelegramUserID <= 0 {
		writeBotError(w, http.StatusBadRequest, "telegram_user_id is required", "invalid_payload")
		return
	}

	link, err := h.storage.GetTelegramUserLinkByTelegramUserID(payload.TelegramUserID)
	if err == sql.ErrNoRows {
		writeJSON(w, http.StatusOK, botLinkStatusResponse{Linked: false, Premium: false})
		return
	}
	if err != nil {
		writeBotError(w, http.StatusInternalServerError, "No se pudo obtener el estado de vinculacion", "internal_error")
		return
	}

	planTier, err := h.storage.GetUserPlanTier(link.UserID)
	if err != nil {
		writeBotError(w, http.StatusInternalServerError, "No se pudo validar el plan del usuario", "internal_error")
		return
	}
	premium := storage.NormalizePlanTier(planTier) == storage.PlanTierPremium
	writeJSON(w, http.StatusOK, botLinkStatusResponse{
		Linked:  true,
		Premium: premium,
	})
}

func (h *Handler) CreateBotExpense(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeBotError(w, http.StatusMethodNotAllowed, "Method not allowed", "method_not_allowed")
		return
	}
	var payload botExpensePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeBotError(w, http.StatusBadRequest, "Invalid request body", "invalid_payload")
		return
	}
	if payload.TelegramUserID <= 0 {
		writeBotError(w, http.StatusBadRequest, "telegram_user_id is required", "invalid_payload")
		return
	}

	link, err := h.storage.GetTelegramUserLinkByTelegramUserID(payload.TelegramUserID)
	if err == sql.ErrNoRows {
		writeBotError(w, http.StatusNotFound, "Telegram user not linked", "not_linked")
		return
	}
	if err != nil {
		writeBotError(w, http.StatusInternalServerError, "No se pudo resolver el usuario de Telegram", "internal_error")
		return
	}

	premium, err := h.isUserPremium(link.UserID)
	if err != nil {
		writeBotError(w, http.StatusInternalServerError, "No se pudo validar el plan del usuario", "internal_error")
		return
	}
	if !premium {
		writeBotError(w, http.StatusForbidden, "Premium requerido", "premium_required")
		return
	}

	flow, adjustedAmount, err := normalizeFlow(payload.Type, payload.Amount)
	if err != nil {
		writeBotError(w, http.StatusBadRequest, err.Error(), "invalid_payload")
		return
	}
	currency := strings.ToLower(strings.TrimSpace(payload.Currency))
	if currency == "" {
		if configCurrency, getErr := h.storage.GetCurrency(link.UserID); getErr == nil {
			currency = strings.ToLower(strings.TrimSpace(configCurrency))
		}
	}
	if currency == "" {
		currency = "ars"
	}
	category := storage.SanitizeString(payload.Category)
	if category == "" {
		if flow == "income" {
			category = "Ingresos"
		} else {
			category = "Varios"
		}
	}

	createdAt := parseTelegramDateTime(payload.DateTimeISO, time.Now().UTC())
	tags := uniqueTags(append(payload.Tags, "telegram_bot"))
	expense := storage.Expense{
		ID:           uuid.New().String(),
		Flow:         flow,
		Name:         buildBotExpenseName(payload.Counterparty, payload.Motive, payload.Reference),
		Category:     category,
		Amount:       adjustedAmount,
		Currency:     currency,
		Source:       normalizeBotExpenseSource(payload.Provider),
		Tags:         tags,
		SystemOrigin: "telegram_bot",
		Date:         createdAt,
	}
	if err := expense.Validate(); err != nil {
		writeBotError(w, http.StatusBadRequest, err.Error(), "invalid_payload")
		return
	}
	if err := h.storage.AddExpense(link.UserID, expense); err != nil {
		writeBotError(w, http.StatusInternalServerError, "No se pudo crear la transaccion", "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, botExpenseResponse{
		TransactionID: expense.ID,
		URL:           buildBotExpenseURL(r),
	})
}
