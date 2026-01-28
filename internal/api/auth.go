package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/tanq16/expenseowl/internal/storage"
)

const (
	sessionCookieName       = "expense_session"
	sessionDuration         = 24 * time.Hour
	sessionRememberDuration = 30 * 24 * time.Hour
	minPasswordLength       = 8
	resetCodeTTL            = 15 * time.Minute
)

type contextKey string

const userIDContextKey contextKey = "userID"

type authPayload struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Remember bool   `json:"remember"`
}

type authUserResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
}

type resetRequestPayload struct {
	Email string `json:"email"`
}

type resetConfirmPayload struct {
	Email    string `json:"email"`
	Code     string `json:"code"`
	Password string `json:"password"`
}

func userIDFromContext(ctx context.Context) (string, bool) {
	userID, ok := ctx.Value(userIDContextKey).(string)
	return userID, ok
}

func (h *Handler) RequireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil || cookie == nil || cookie.Value == "" {
			writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: "Unauthorized"})
			return
		}
		session, err := h.storage.GetSession(cookie.Value)
		if err != nil {
			if err == sql.ErrNoRows {
				clearSessionCookie(w, r)
				writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: "Unauthorized"})
				return
			}
			writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to validate session"})
			return
		}
		if time.Now().After(session.ExpiresAt) {
			_ = h.storage.DeleteSession(session.ID)
			clearSessionCookie(w, r)
			writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: "Session expired"})
			return
		}
		ctx := context.WithValue(r.Context(), userIDContextKey, session.UserID)
		next(w, r.WithContext(ctx))
	}
}

func (h *Handler) AuthRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	var payload authPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid request body"})
		return
	}
	email := normalizeEmail(payload.Email)
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid email"})
		return
	}
	if len(payload.Password) < minPasswordLength {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Password must be at least 8 characters"})
		return
	}
	if _, err := h.storage.GetUserByEmail(email); err == nil {
		writeJSON(w, http.StatusConflict, ErrorResponse{Error: "Email already registered"})
		return
	} else if err != sql.ErrNoRows {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to check user"})
		return
	}
	hash, err := storage.HashPassword(payload.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to hash password"})
		return
	}
	user, err := h.storage.CreateUser(email, hash)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to create user"})
		return
	}
	if err := h.createSession(w, r, user.ID, payload.Remember); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to create session"})
		return
	}
	writeJSON(w, http.StatusCreated, authUserResponse{
		ID:        user.ID,
		Email:     user.Email,
		Status:    user.Status,
		CreatedAt: user.CreatedAt,
	})
}

func (h *Handler) AuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	var payload authPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid request body"})
		return
	}
	email := normalizeEmail(payload.Email)
	user, err := h.storage.GetUserByEmail(email)
	if err != nil {
		if err == sql.ErrNoRows {
			writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: "Invalid credentials"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to check user"})
		return
	}
	if err := storage.ComparePassword(user.PasswordHash, payload.Password); err != nil {
		writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: "Invalid credentials"})
		return
	}
	if err := h.createSession(w, r, user.ID, payload.Remember); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to create session"})
		return
	}
	writeJSON(w, http.StatusOK, authUserResponse{
		ID:        user.ID,
		Email:     user.Email,
		Status:    user.Status,
		CreatedAt: user.CreatedAt,
	})
}

func (h *Handler) AuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie != nil && cookie.Value != "" {
		_ = h.storage.DeleteSession(cookie.Value)
	}
	clearSessionCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]string{"status": "success"})
}

func (h *Handler) AuthMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	user, err := h.storage.GetUserByID(userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to fetch user"})
		return
	}
	writeJSON(w, http.StatusOK, authUserResponse{
		ID:        user.ID,
		Email:     user.Email,
		Status:    user.Status,
		CreatedAt: user.CreatedAt,
	})
}

func (h *Handler) AuthResetRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	var payload resetRequestPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid request body"})
		return
	}
	email := normalizeEmail(payload.Email)
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid email"})
		return
	}
	user, err := h.storage.GetUserByEmail(email)
	if err != nil {
		if err == sql.ErrNoRows {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to process request"})
		return
	}
	code, err := newResetCode()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to generate code"})
		return
	}
	reset := storage.PasswordReset{
		UserID:    user.ID,
		CodeHash:  hashResetCode(code),
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(resetCodeTTL),
	}
	if err := h.storage.CreatePasswordReset(reset); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to create reset code"})
		return
	}
	if err := sendResetCodeEmail(email, code); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to send reset code"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) AuthResetConfirm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "Method not allowed"})
		return
	}
	var payload resetConfirmPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid request body"})
		return
	}
	email := normalizeEmail(payload.Email)
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid email"})
		return
	}
	if len(payload.Password) < minPasswordLength {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Password must be at least 8 characters"})
		return
	}
	code := strings.TrimSpace(payload.Code)
	if len(code) < 4 {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid code"})
		return
	}
	user, err := h.storage.GetUserByEmail(email)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid code"})
		return
	}
	reset, err := h.storage.GetLatestPasswordReset(user.ID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Invalid code"})
		return
	}
	if time.Now().After(reset.ExpiresAt) {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Codigo expirado"})
		return
	}
	if hashResetCode(code) != reset.CodeHash {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "Codigo invalido"})
		return
	}
	hash, err := storage.HashPassword(payload.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to update password"})
		return
	}
	if err := h.storage.UpdateUserPassword(user.ID, hash); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "Failed to update password"})
		return
	}
	_ = h.storage.MarkPasswordResetUsed(reset.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) createSession(w http.ResponseWriter, r *http.Request, userID string, remember bool) error {
	sessionID, err := newSessionID()
	if err != nil {
		return err
	}
	duration := sessionDuration
	if remember {
		duration = sessionRememberDuration
	}
	now := time.Now()
	session := storage.Session{
		ID:        sessionID,
		UserID:    userID,
		CreatedAt: now,
		ExpiresAt: now.Add(duration),
		IP:        readClientIP(r),
		UserAgent: r.UserAgent(),
	}
	if err := h.storage.CreateSession(session); err != nil {
		return err
	}
	setSessionCookie(w, r, session)
	return nil
}

func newSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, session storage.Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    session.ID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecureRequest(r),
		Expires:  session.ExpiresAt,
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecureRequest(r),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

func isSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func readClientIP(r *http.Request) string {
	xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
	if xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	return r.RemoteAddr
}
