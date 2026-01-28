package storage

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// Storage interface for all storage types
type Storage interface {
	Close() error

	// Users
	CreateUser(email, passwordHash string) (User, error)
	GetUserByEmail(email string) (User, error)
	GetUserByID(id string) (User, error)
	UpdateUserPassword(userID, passwordHash string) error

	// Sessions
	CreateSession(session Session) error
	GetSession(id string) (Session, error)
	DeleteSession(id string) error

	// Password resets
	CreatePasswordReset(reset PasswordReset) error
	GetLatestPasswordReset(userID string) (PasswordReset, error)
	MarkPasswordResetUsed(resetID string) error

	// User Config
	GetConfig(userID string) (*Config, error)

	// Basic Config Updates
	GetCategories(userID string) ([]string, error)
	UpdateCategories(userID string, categories []string) error
	// GetTags() ([]string, error)
	// UpdateTags(tags []string) error
	GetCurrency(userID string) (string, error)
	UpdateCurrency(userID string, currency string) error
	GetStartDate(userID string) (int, error)
	UpdateStartDate(userID string, startDate int) error

	// Recurring Expenses
	GetRecurringExpenses(userID string) ([]RecurringExpense, error)
	GetRecurringExpense(userID, id string) (RecurringExpense, error)
	AddRecurringExpense(userID string, recurringExpense RecurringExpense) error
	RemoveRecurringExpense(userID, id string, removeAll bool) error
	UpdateRecurringExpense(userID, id string, recurringExpense RecurringExpense, updateAll bool) error

	// Expenses
	GetAllExpenses(userID string) ([]Expense, error)
	GetExpense(userID, id string) (Expense, error)
	AddExpense(userID string, expense Expense) error
	RemoveExpense(userID, id string) error
	AddMultipleExpenses(userID string, expenses []Expense) error
	RemoveMultipleExpenses(userID string, ids []string) error
	UpdateExpense(userID, id string, expense Expense) error

	// Potential Future Feature: Multi-currency
	// GetConversions() (map[string]float64, error)
	// UpdateConversions(conversions map[string]float64) error
}

// config for expense data
type Config struct {
	Categories        []string           `json:"categories"`
	Currency          string             `json:"currency"`
	StartDate         int                `json:"startDate"`
	RecurringExpenses []RecurringExpense `json:"recurringExpenses"`
	// Tags              []string           `json:"tags"`
}

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"createdAt"`
}

type PasswordReset struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	CodeHash  string    `json:"-"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
}

type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	IP        string    `json:"ip"`
	UserAgent string    `json:"userAgent"`
}

type RecurringExpense struct {
	UserID      string    `json:"-"`
	Flow        string    `json:"flow"`
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Amount      float64   `json:"amount"`
	Currency    string    `json:"currency"`
	Tags        []string  `json:"tags"`
	Category    string    `json:"category"`
	StartDate   time.Time `json:"startDate"`   // date of the first occurrence
	Interval    string    `json:"interval"`    // daily, weekly, monthly, yearly
	Occurrences int       `json:"occurrences"` // 0 for 3000 occurrences (heuristic)
}

type BackendType string

const (
	// BackendTypeJSON is deprecated and no longer supported at runtime.
	BackendTypeJSON     BackendType = "json"
	BackendTypePostgres BackendType = "postgres"
)

// config for the storage backend
type SystemConfig struct {
	StorageURL  string
	StorageType BackendType
	StorageUser string
	StoragePass string
	StorageSSL  string
}

// expense struct
type Expense struct {
	UserID      string    `json:"-"`
	Flow        string    `json:"flow"`
	ID          string    `json:"id"`
	RecurringID string    `json:"recurringID"`
	Name        string    `json:"name"`
	Tags        []string  `json:"tags"`
	Category    string    `json:"category"`
	Amount      float64   `json:"amount"`
	Currency    string    `json:"currency"`
	Source      string    `json:"source"`
	Card        string    `json:"card"`
	Date        time.Time `json:"date"`
}

func (c *Config) SetBaseConfig() {
	c.Categories = defaultCategories
	c.Currency = "usd"
	c.StartDate = 1
	// c.Tags = []string{}
	c.RecurringExpenses = []RecurringExpense{}
}

func (c *SystemConfig) SetStorageConfig() {
	c.StorageType = backendTypeFromEnv(os.Getenv("STORAGE_TYPE"))
	c.StorageURL = backendURLFromEnv(os.Getenv("STORAGE_URL"))
	c.StorageSSL = backendSSLFromEnv(os.Getenv("STORAGE_SSL"))
	c.StorageUser = os.Getenv("STORAGE_USER")
	c.StoragePass = os.Getenv("STORAGE_PASS")
}

func backendTypeFromEnv(env string) BackendType {
	switch env {
	case "json":
		return BackendTypeJSON
	case "postgres":
		return BackendTypePostgres
	default:
		return ""
	}
}

func backendURLFromEnv(env string) string {
	return env
}

func backendSSLFromEnv(env string) string {
	switch env {
	case "disable", "require", "verify-full", "verify-ca":
		return env
	default:
		return "disable"
	}
}

// initializes the storage backend
func InitializeStorage() (Storage, error) {
	baseConfig := SystemConfig{}
	baseConfig.SetStorageConfig()
	if baseConfig.StorageType == "" {
		return nil, fmt.Errorf("missing STORAGE_TYPE (set STORAGE_TYPE=postgres)")
	}
	if baseConfig.StorageType != BackendTypePostgres {
		return nil, fmt.Errorf("unsupported storage type: %q (json storage deprecated; set STORAGE_TYPE=postgres)", baseConfig.StorageType)
	}
	if baseConfig.StorageURL == "" {
		return nil, fmt.Errorf("missing STORAGE_URL for postgres backend")
	}
	if baseConfig.StorageUser == "" {
		return nil, fmt.Errorf("missing STORAGE_USER for postgres backend")
	}
	if baseConfig.StoragePass == "" {
		return nil, fmt.Errorf("missing STORAGE_PASS for postgres backend")
	}
	return InitializePostgresStore(baseConfig)
}

var REInvalidChars *regexp.Regexp = regexp.MustCompile(`[^\p{L}\p{N}\s.,\-'_!"]`)
var RERepeatingSpaces *regexp.Regexp = regexp.MustCompile(`\s+`)

// allows readable chars like unicode, otherwise replaces with whitespace
func SanitizeString(s string) string {
	sanitized := REInvalidChars.ReplaceAllString(s, " ")
	sanitized = RERepeatingSpaces.ReplaceAllString(sanitized, " ")
	return strings.TrimSpace(sanitized)
}

func ValidateCategory(category string) (string, error) {
	sanitized := SanitizeString(category)
	if sanitized == "" {
		return "", fmt.Errorf("category name cannot be empty or contain only invalid characters")
	}
	return sanitized, nil
}

func (e *Expense) Validate() error {
	e.Name = SanitizeString(e.Name)
	if e.Name == "" {
		return fmt.Errorf("expense 'name' cannot be empty")
	}
	if e.Category == "" {
		return fmt.Errorf("expense 'category' cannot be empty")
	}
	if e.Amount == 0 {
		return fmt.Errorf("expense 'amount' cannot be 0")
	}
	e.Source = SanitizeString(e.Source)
	e.Card = SanitizeString(e.Card)
	// if e.Currency == "" {
	// 	return fmt.Errorf("expense 'currency' cannot be empty")
	// }
	if len(e.Tags) > 0 {
		var cleanedTags []string
		for _, tag := range e.Tags {
			sanitizedTag := SanitizeString(tag)
			if sanitizedTag != "" {
				cleanedTags = append(cleanedTags, sanitizedTag)
			}
		}
		e.Tags = cleanedTags
	}
	if e.Date.IsZero() {
		return fmt.Errorf("expense 'date' cannot be empty")
	}
	return nil
}

func (e *RecurringExpense) Validate() error {
	e.Name = SanitizeString(e.Name)
	if e.Name == "" {
		return fmt.Errorf("recurring expense 'name' cannot be empty")
	}
	if e.Category == "" {
		return fmt.Errorf("recurring expense 'category' cannot be empty")
	}
	if len(e.Tags) > 0 {
		var cleanedTags []string
		for _, tag := range e.Tags {
			sanitizedTag := SanitizeString(tag)
			if sanitizedTag != "" {
				cleanedTags = append(cleanedTags, sanitizedTag)
			}
		}
		e.Tags = cleanedTags
	}
	if e.Occurrences < 2 {
		return fmt.Errorf("at least 2 occurences required to recur")
	}
	if e.StartDate.IsZero() {
		return fmt.Errorf("start date for recurring expense must be specified")
	}
	validIntervals := map[string]bool{
		"daily":   true,
		"weekly":  true,
		"monthly": true,
		"yearly":  true,
	}
	if !validIntervals[e.Interval] {
		return fmt.Errorf("invalid interval: '%s'. Must be one of 'daily', 'weekly', 'monthly', or 'yearly'", e.Interval)
	}
	return nil
}

// variables
var defaultCategories = []string{
	"Food",
	"Groceries",
	"Travel",
	"Rent",
	"Utilities",
	"Entertainment",
	"Healthcare",
	"Shopping",
	"Miscellaneous",
	"Income",
}

var SupportedCurrencies = []string{
	"ars", // Argentine Peso
	"usd", // US Dollar
	"eur", // Euro
}
