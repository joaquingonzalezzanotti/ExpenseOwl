package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

// databaseStore implements the Storage interface for PostgreSQL.
type databaseStore struct {
	db *sql.DB
}

// SQL queries as constants for reusability and clarity.
const (
	createUsersTableSQL = `
	CREATE TABLE IF NOT EXISTS users (
		id VARCHAR(36) PRIMARY KEY,
		email TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		status VARCHAR(20) NOT NULL DEFAULT 'active',
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);`

	createSessionsTableSQL = `
	CREATE TABLE IF NOT EXISTS sessions (
		id VARCHAR(64) PRIMARY KEY,
		user_id VARCHAR(36) NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		expires_at TIMESTAMPTZ NOT NULL,
		ip VARCHAR(100),
		user_agent TEXT
	);`

	createUserConfigTableSQL = `
	CREATE TABLE IF NOT EXISTS user_config (
		user_id VARCHAR(36) PRIMARY KEY,
		currency VARCHAR(255) NOT NULL,
		start_date INTEGER NOT NULL
	);`

	createExpensesTableSQL = `
	CREATE TABLE IF NOT EXISTS expenses (
		id VARCHAR(36) PRIMARY KEY,
		user_id VARCHAR(36) NOT NULL,
		recurring_id VARCHAR(36),
		name VARCHAR(255) NOT NULL,
		category VARCHAR(255) NOT NULL,
		amount NUMERIC(10, 2) NOT NULL,
		currency VARCHAR(3) NOT NULL,
		date TIMESTAMPTZ NOT NULL,
		tags TEXT,
		source VARCHAR(50),
		card VARCHAR(100)
	);`

	createRecurringExpensesTableSQL = `
	CREATE TABLE IF NOT EXISTS recurring_expenses (
		id VARCHAR(36) PRIMARY KEY,
		user_id VARCHAR(36) NOT NULL,
		name VARCHAR(255) NOT NULL,
		amount NUMERIC(10, 2) NOT NULL,
		currency VARCHAR(3) NOT NULL,
		category VARCHAR(255) NOT NULL,
		start_date TIMESTAMPTZ NOT NULL,
		interval VARCHAR(50) NOT NULL,
		occurrences INTEGER NOT NULL,
		tags TEXT
	);`

	createConfigTableSQL = `
	CREATE TABLE IF NOT EXISTS config (
		id VARCHAR(255) PRIMARY KEY DEFAULT 'default',
		categories TEXT NOT NULL,
		currency VARCHAR(255) NOT NULL,
		start_date INTEGER NOT NULL
	);`

	createCategoriesTableSQL = `
	CREATE TABLE IF NOT EXISTS categories (
		id SERIAL PRIMARY KEY,
		user_id VARCHAR(36) NOT NULL,
		name TEXT NOT NULL,
		position INTEGER NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);`
)

func InitializePostgresStore(baseConfig SystemConfig) (Storage, error) {
	dbURL := makeDBURL(baseConfig)
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open PostgreSQL database: %v", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping PostgreSQL database: %v", err)
	}
	log.Println("Connected to PostgreSQL database")

	if err := createTables(db); err != nil {
		return nil, fmt.Errorf("failed to create database tables: %v", err)
	}
	if err := ensureBootstrapUser(db); err != nil {
		return nil, fmt.Errorf("failed to bootstrap user data: %v", err)
	}
	return &databaseStore{db: db}, nil
}

func makeDBURL(baseConfig SystemConfig) string {
	return fmt.Sprintf("postgres://%s:%s@%s?sslmode=%s", baseConfig.StorageUser, baseConfig.StoragePass, baseConfig.StorageURL, baseConfig.StorageSSL)
}

func createTables(db *sql.DB) error {
	for _, query := range []string{
		createUsersTableSQL,
		createSessionsTableSQL,
		createUserConfigTableSQL,
		createExpensesTableSQL,
		createRecurringExpensesTableSQL,
		createConfigTableSQL,
		createCategoriesTableSQL,
	} {
		if _, err := db.Exec(query); err != nil {
			return err
		}
	}
	// ensure columns exist for backward compatibility
	alterStmts := []string{
		"ALTER TABLE expenses ADD COLUMN IF NOT EXISTS user_id VARCHAR(36)",
		"ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source VARCHAR(50)",
		"ALTER TABLE expenses ADD COLUMN IF NOT EXISTS card VARCHAR(100)",
		"ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS user_id VARCHAR(36)",
		"ALTER TABLE categories ADD COLUMN IF NOT EXISTS user_id VARCHAR(36)",
	}
	for _, stmt := range alterStmts {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	if _, err := db.Exec(`ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_key ON categories (user_id, name)`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS expenses_user_date_idx ON expenses (user_id, date DESC)`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS recurring_expenses_user_idx ON recurring_expenses (user_id)`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS categories_user_idx ON categories (user_id, position)`); err != nil {
		return err
	}
	return nil
}

const defaultBootstrapEmail = "joaquingzzz79@gmail.com"
const defaultBootstrapPassword = "admin2008"

func ensureBootstrapUser(db *sql.DB) error {
	email, password := bootstrapCredentials()
	if email == "" || password == "" {
		log.Printf("[BOOTSTRAP] skipped: missing BOOTSTRAP_EMAIL or BOOTSTRAP_PASSWORD")
		return nil
	}
	userID, err := ensureUser(db, email, password)
	if err != nil {
		return err
	}
	if err := backfillUserIDs(db, userID); err != nil {
		return err
	}
	legacyConfig, legacyErr := readLegacyConfig(db)
	if legacyErr != nil {
		legacyConfig.SetBaseConfig()
	}
	if err := ensureUserConfig(db, userID, &legacyConfig); err != nil {
		return err
	}
	if err := ensureUserCategories(db, userID, readLegacyCategories(db)); err != nil {
		return err
	}
	if err := setNotNullIfNoNulls(db, "expenses", "user_id"); err != nil {
		return err
	}
	if err := setNotNullIfNoNulls(db, "recurring_expenses", "user_id"); err != nil {
		return err
	}
	if err := setNotNullIfNoNulls(db, "categories", "user_id"); err != nil {
		return err
	}
	return nil
}

func bootstrapCredentials() (string, string) {
	email := strings.TrimSpace(os.Getenv("BOOTSTRAP_EMAIL"))
	password := strings.TrimSpace(os.Getenv("BOOTSTRAP_PASSWORD"))
	if email == "" {
		email = defaultBootstrapEmail
	}
	if password == "" {
		password = defaultBootstrapPassword
	}
	return strings.ToLower(email), password
}

func ensureUser(db *sql.DB, email, password string) (string, error) {
	var id string
	err := db.QueryRow(`SELECT id FROM users WHERE email = $1`, strings.ToLower(email)).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}
	hashed, err := HashPassword(password)
	if err != nil {
		return "", err
	}
	id = uuid.New().String()
	if _, err := db.Exec(`INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, $3, 'active')`, id, strings.ToLower(email), hashed); err != nil {
		return "", err
	}
	return id, nil
}

func ensureUserConfig(db *sql.DB, userID string, defaults *Config) error {
	var count int
	if err := db.QueryRow(`SELECT COUNT(1) FROM user_config WHERE user_id = $1`, userID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	config := Config{}
	if defaults != nil && defaults.Currency != "" {
		config = *defaults
	} else {
		config.SetBaseConfig()
	}
	_, err := db.Exec(`INSERT INTO user_config (user_id, currency, start_date) VALUES ($1, $2, $3)`, userID, config.Currency, config.StartDate)
	return err
}

func readLegacyConfig(db *sql.DB) (Config, error) {
	var config Config
	err := db.QueryRow(`SELECT currency, start_date FROM config WHERE id = 'default'`).Scan(&config.Currency, &config.StartDate)
	if err != nil {
		return Config{}, err
	}
	return config, nil
}

func backfillUserIDs(db *sql.DB, userID string) error {
	stmts := []string{
		`UPDATE expenses SET user_id = $1 WHERE user_id IS NULL`,
		`UPDATE recurring_expenses SET user_id = $1 WHERE user_id IS NULL`,
		`UPDATE categories SET user_id = $1 WHERE user_id IS NULL`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt, userID); err != nil {
			return err
		}
	}
	return nil
}

func setNotNullIfNoNulls(db *sql.DB, table, column string) error {
	var count int
	query := fmt.Sprintf(`SELECT COUNT(1) FROM %s WHERE %s IS NULL`, table, column)
	if err := db.QueryRow(query).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	alter := fmt.Sprintf(`ALTER TABLE %s ALTER COLUMN %s SET NOT NULL`, table, column)
	if _, err := db.Exec(alter); err != nil {
		return err
	}
	return nil
}

func ensureUserCategories(db *sql.DB, userID string, seed []string) error {
	var count int
	if err := db.QueryRow(`SELECT COUNT(1) FROM categories WHERE user_id = $1`, userID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	categories := seed
	if len(categories) == 0 {
		categories = defaultCategories
	}
	return seedCategories(db, userID, categories)
}

func readLegacyCategories(db *sql.DB) []string {
	var categories []string
	var categoriesStr string
	if err := db.QueryRow(`SELECT categories FROM config WHERE id = 'default'`).Scan(&categoriesStr); err != nil {
		return nil
	}
	if err := json.Unmarshal([]byte(categoriesStr), &categories); err != nil {
		return nil
	}
	return categories
}

func seedCategories(db *sql.DB, userID string, categories []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	for i, name := range categories {
		if _, err = tx.Exec(
			`INSERT INTO categories (user_id, name, position) VALUES ($1, $2, $3)
			 ON CONFLICT (user_id, name) DO UPDATE SET position = EXCLUDED.position`,
			userID, name, i+1,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *databaseStore) Close() error {
	return s.db.Close()
}

func (s *databaseStore) CreateUser(email, passwordHash string) (User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	user := User{
		ID:           uuid.New().String(),
		Email:        email,
		PasswordHash: passwordHash,
		Status:       "active",
	}
	query := `INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, $3, $4) RETURNING created_at`
	if err := s.db.QueryRow(query, user.ID, user.Email, user.PasswordHash, user.Status).Scan(&user.CreatedAt); err != nil {
		return User{}, err
	}
	if err := ensureUserConfig(s.db, user.ID, nil); err != nil {
		return User{}, err
	}
	if err := ensureUserCategories(s.db, user.ID, nil); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *databaseStore) GetUserByEmail(email string) (User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	query := `SELECT id, email, password_hash, status, created_at FROM users WHERE email = $1`
	var user User
	if err := s.db.QueryRow(query, email).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Status, &user.CreatedAt); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *databaseStore) GetUserByID(id string) (User, error) {
	query := `SELECT id, email, password_hash, status, created_at FROM users WHERE id = $1`
	var user User
	if err := s.db.QueryRow(query, id).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Status, &user.CreatedAt); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *databaseStore) CreateSession(session Session) error {
	if session.CreatedAt.IsZero() {
		session.CreatedAt = time.Now()
	}
	query := `INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`
	_, err := s.db.Exec(query, session.ID, session.UserID, session.CreatedAt, session.ExpiresAt, session.IP, session.UserAgent)
	return err
}

func (s *databaseStore) GetSession(id string) (Session, error) {
	query := `SELECT id, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE id = $1`
	var session Session
	if err := s.db.QueryRow(query, id).Scan(&session.ID, &session.UserID, &session.CreatedAt, &session.ExpiresAt, &session.IP, &session.UserAgent); err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *databaseStore) DeleteSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = $1`, id)
	return err
}

func (s *databaseStore) GetConfig(userID string) (*Config, error) {
	currency, startDate, err := s.getOrCreateUserConfig(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user config: %v", err)
	}
	categories, err := s.GetCategories(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories from db: %v", err)
	}
	recurring, err := s.GetRecurringExpenses(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get recurring expenses for config: %v", err)
	}

	return &Config{
		Categories:        categories,
		Currency:          currency,
		StartDate:         startDate,
		RecurringExpenses: recurring,
	}, nil
}

func (s *databaseStore) getOrCreateUserConfig(userID string) (string, int, error) {
	var currency string
	var startDate int
	err := s.db.QueryRow(`SELECT currency, start_date FROM user_config WHERE user_id = $1`, userID).Scan(&currency, &startDate)
	if err == nil {
		return currency, startDate, nil
	}
	if err != sql.ErrNoRows {
		return "", 0, err
	}
	config := Config{}
	config.SetBaseConfig()
	if _, err := s.db.Exec(`INSERT INTO user_config (user_id, currency, start_date) VALUES ($1, $2, $3)`, userID, config.Currency, config.StartDate); err != nil {
		return "", 0, err
	}
	return config.Currency, config.StartDate, nil
}

func (s *databaseStore) GetCategories(userID string) ([]string, error) {
	categories, err := s.getCategoriesFromTable(userID)
	if err != nil {
		return nil, err
	}
	if len(categories) == 0 {
		categories = defaultCategories
		if seedErr := seedCategories(s.db, userID, categories); seedErr != nil {
			return nil, seedErr
		}
	}
	return categories, nil
}

func (s *databaseStore) UpdateCategories(userID string, categories []string) error {
	if err := s.updateCategoriesTable(userID, categories); err != nil {
		return err
	}
	return nil
}

func (s *databaseStore) getCategoriesFromTable(userID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT name FROM categories WHERE user_id = $1 ORDER BY position ASC`, userID)
	if err != nil {
		log.Printf("[DEBUG] getCategoriesFromTable query error: %v", err)
		return nil, err
	}
	defer rows.Close()

	var categories []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			log.Printf("[DEBUG] getCategoriesFromTable scan error: %v", err)
			return nil, err
		}
		categories = append(categories, name)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[DEBUG] getCategoriesFromTable rows error: %v", err)
		return nil, err
	}
	log.Printf("[DEBUG] getCategoriesFromTable returned %d categories: %v", len(categories), categories)
	return categories, nil
}

func (s *databaseStore) updateCategoriesTable(userID string, categories []string) error {
	if len(categories) == 0 {
		return fmt.Errorf("categories cannot be empty")
	}

	// Validate that no category is empty
	for _, cat := range categories {
		if strings.TrimSpace(cat) == "" {
			return fmt.Errorf("category names cannot be empty")
		}
	}

	log.Printf("[DEBUG] updateCategoriesTable called with %d categories: %v", len(categories), categories)

	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[DEBUG] updateCategoriesTable begin transaction error: %v", err)
		return err
	}
	defer func() {
		if err != nil {
			log.Printf("[DEBUG] updateCategoriesTable rolling back transaction due to error: %v", err)
			_ = tx.Rollback()
		}
	}()

	for i, name := range categories {
		log.Printf("[DEBUG] updateCategoriesTable inserting category %d: %s", i+1, name)
		if _, err = tx.Exec(
			`INSERT INTO categories (user_id, name, position) VALUES ($1, $2, $3)
			 ON CONFLICT (user_id, name) DO UPDATE SET position = EXCLUDED.position`,
			userID, name, i+1,
		); err != nil {
			log.Printf("[DEBUG] updateCategoriesTable insert error for category %s: %v", name, err)
			return err
		}
	}

	log.Printf("[DEBUG] updateCategoriesTable deleting categories not in list")
	// Delete categories that are not in the new list
	// Using a safer approach with explicit list building
	if _, err = tx.Exec(`DELETE FROM categories WHERE user_id = $1 AND NOT (name = ANY($2))`, userID, pq.Array(categories)); err != nil {
		log.Printf("[DEBUG] updateCategoriesTable delete error: %v", err)
		return fmt.Errorf("failed to delete removed categories: %v", err)
	}

	if err = tx.Commit(); err != nil {
		log.Printf("[DEBUG] updateCategoriesTable commit error: %v", err)
		return fmt.Errorf("failed to commit category update: %v", err)
	}

	log.Printf("[DEBUG] updateCategoriesTable successfully updated categories")
	return nil
}

func (s *databaseStore) GetCurrency(userID string) (string, error) {
	currency, _, err := s.getOrCreateUserConfig(userID)
	if err != nil {
		return "", err
	}
	return currency, nil
}

func (s *databaseStore) UpdateCurrency(userID string, currency string) error {
	if !slices.Contains(SupportedCurrencies, currency) {
		return fmt.Errorf("invalid currency: %s", currency)
	}
	_, startDate, err := s.getOrCreateUserConfig(userID)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO user_config (user_id, currency, start_date)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE SET currency = EXCLUDED.currency`,
		userID, currency, startDate,
	)
	return err
}

func (s *databaseStore) GetStartDate(userID string) (int, error) {
	_, startDate, err := s.getOrCreateUserConfig(userID)
	if err != nil {
		return 0, err
	}
	return startDate, nil
}

func (s *databaseStore) UpdateStartDate(userID string, startDate int) error {
	if startDate < 1 || startDate > 31 {
		return fmt.Errorf("invalid start date: %d", startDate)
	}
	currency, _, err := s.getOrCreateUserConfig(userID)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO user_config (user_id, currency, start_date)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE SET start_date = EXCLUDED.start_date`,
		userID, currency, startDate,
	)
	return err
}

func scanExpense(scanner interface{ Scan(...any) error }) (Expense, error) {
	var expense Expense
	var tagsStr sql.NullString
	var recurringID sql.NullString
	var source sql.NullString
	var card sql.NullString
	err := scanner.Scan(
		&expense.ID,
		&recurringID,
		&expense.Name,
		&expense.Category,
		&expense.Amount,
		&expense.Currency,
		&expense.Date,
		&tagsStr,
		&source,
		&card,
	)
	if err != nil {
		return Expense{}, err
	}
	if recurringID.Valid {
		expense.RecurringID = recurringID.String
	}
	if source.Valid {
		expense.Source = source.String
	}
	if card.Valid {
		expense.Card = card.String
	}
	if tagsStr.Valid && tagsStr.String != "" {
		if err := json.Unmarshal([]byte(tagsStr.String), &expense.Tags); err != nil {
			return Expense{}, fmt.Errorf("failed to parse tags for expense %s: %v", expense.ID, err)
		}
	}
	return expense, nil
}

func (s *databaseStore) GetAllExpenses(userID string) ([]Expense, error) {
	query := `SELECT id, recurring_id, name, category, amount, currency, date, tags, source, card FROM expenses WHERE user_id = $1 ORDER BY date DESC`
	rows, err := s.db.Query(query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query expenses: %v", err)
	}
	defer rows.Close()

	var expenses []Expense
	for rows.Next() {
		expense, err := scanExpense(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan expense: %v", err)
		}
		expenses = append(expenses, expense)
	}
	return expenses, nil
}

func (s *databaseStore) GetExpense(userID, id string) (Expense, error) {
	query := `SELECT id, recurring_id, name, category, amount, currency, date, tags, source, card FROM expenses WHERE user_id = $1 AND id = $2`
	expense, err := scanExpense(s.db.QueryRow(query, userID, id))
	if err != nil {
		if err == sql.ErrNoRows {
			return Expense{}, fmt.Errorf("expense with ID %s not found", id)
		}
		return Expense{}, fmt.Errorf("failed to get expense: %v", err)
	}
	return expense, nil
}

func (s *databaseStore) AddExpense(userID string, expense Expense) error {
	if expense.ID == "" {
		expense.ID = uuid.New().String()
	}
	if expense.Currency == "" {
		if currency, err := s.GetCurrency(userID); err == nil {
			expense.Currency = currency
		}
	}
	if expense.Date.IsZero() {
		expense.Date = time.Now()
	}
	tagsJSON, err := json.Marshal(expense.Tags)
	if err != nil {
		return err
	}
	query := `
		INSERT INTO expenses (id, user_id, recurring_id, name, category, amount, currency, date, tags, source, card)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`
	_, err = s.db.Exec(query, expense.ID, userID, expense.RecurringID, expense.Name, expense.Category, expense.Amount, expense.Currency, expense.Date, string(tagsJSON), expense.Source, expense.Card)
	return err
}

func (s *databaseStore) UpdateExpense(userID, id string, expense Expense) error {
	tagsJSON, err := json.Marshal(expense.Tags)
	if err != nil {
		return err
	}
	// TODO: revisit to maybe remove this later, might not be a good default for update
	if expense.Currency == "" {
		if currency, err := s.GetCurrency(userID); err == nil {
			expense.Currency = currency
		}
	}
	query := `
		UPDATE expenses
		SET name = $1, category = $2, amount = $3, currency = $4, date = $5, tags = $6, recurring_id = $7, source = $8, card = $9
		WHERE user_id = $10 AND id = $11
	`
	result, err := s.db.Exec(query, expense.Name, expense.Category, expense.Amount, expense.Currency, expense.Date, string(tagsJSON), expense.RecurringID, expense.Source, expense.Card, userID, id)
	if err != nil {
		return fmt.Errorf("failed to update expense: %v", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %v", err)
	}
	if rowsAffected == 0 {
		return fmt.Errorf("expense with ID %s not found", id)
	}
	return nil
}

func (s *databaseStore) RemoveExpense(userID, id string) error {
	query := `DELETE FROM expenses WHERE user_id = $1 AND id = $2`
	result, err := s.db.Exec(query, userID, id)
	if err != nil {
		return fmt.Errorf("failed to delete expense: %v", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %v", err)
	}
	if rowsAffected == 0 {
		return fmt.Errorf("expense with ID %s not found", id)
	}
	return nil
}

func (s *databaseStore) AddMultipleExpenses(userID string, expenses []Expense) error {
	if len(expenses) == 0 {
		return nil
	}
	// use the same addexpense method
	for _, exp := range expenses {
		if err := s.AddExpense(userID, exp); err != nil {
			return err
		}
	}
	return nil
}

func (s *databaseStore) RemoveMultipleExpenses(userID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	query := `DELETE FROM expenses WHERE user_id = $1 AND id = ANY($2)`
	_, err := s.db.Exec(query, userID, pq.Array(ids))
	if err != nil {
		return fmt.Errorf("failed to delete multiple expenses: %v", err)
	}
	return nil
}

func scanRecurringExpense(scanner interface{ Scan(...any) error }) (RecurringExpense, error) {
	var re RecurringExpense
	var tagsStr sql.NullString
	err := scanner.Scan(&re.ID, &re.Name, &re.Amount, &re.Currency, &re.Category, &re.StartDate, &re.Interval, &re.Occurrences, &tagsStr)
	if err != nil {
		return RecurringExpense{}, err
	}
	if tagsStr.Valid && tagsStr.String != "" {
		if err := json.Unmarshal([]byte(tagsStr.String), &re.Tags); err != nil {
			return RecurringExpense{}, fmt.Errorf("failed to parse tags for recurring expense %s: %v", re.ID, err)
		}
	}
	return re, nil
}

func (s *databaseStore) GetRecurringExpenses(userID string) ([]RecurringExpense, error) {
	query := `SELECT id, name, amount, currency, category, start_date, interval, occurrences, tags FROM recurring_expenses WHERE user_id = $1`
	rows, err := s.db.Query(query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query recurring expenses: %v", err)
	}
	defer rows.Close()
	var recurringExpenses []RecurringExpense
	for rows.Next() {
		re, err := scanRecurringExpense(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan recurring expense: %v", err)
		}
		recurringExpenses = append(recurringExpenses, re)
	}
	return recurringExpenses, nil
}

func (s *databaseStore) GetRecurringExpense(userID, id string) (RecurringExpense, error) {
	query := `SELECT id, name, amount, currency, category, start_date, interval, occurrences, tags FROM recurring_expenses WHERE user_id = $1 AND id = $2`
	re, err := scanRecurringExpense(s.db.QueryRow(query, userID, id))
	if err != nil {
		if err == sql.ErrNoRows {
			return RecurringExpense{}, fmt.Errorf("recurring expense with ID %s not found", id)
		}
		return RecurringExpense{}, fmt.Errorf("failed to get recurring expense: %v", err)
	}
	return re, nil
}

func (s *databaseStore) AddRecurringExpense(userID string, recurringExpense RecurringExpense) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %v", err)
	}
	defer tx.Rollback() // Rollback on error

	if recurringExpense.ID == "" {
		recurringExpense.ID = uuid.New().String()
	}
	if recurringExpense.Currency == "" {
		if currency, err := s.GetCurrency(userID); err == nil {
			recurringExpense.Currency = currency
		}
	}
	tagsJSON, _ := json.Marshal(recurringExpense.Tags)
	ruleQuery := `
		INSERT INTO recurring_expenses (id, user_id, name, amount, currency, category, start_date, interval, occurrences, tags)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`
	_, err = tx.Exec(ruleQuery, recurringExpense.ID, userID, recurringExpense.Name, recurringExpense.Amount, recurringExpense.Currency, recurringExpense.Category, recurringExpense.StartDate, recurringExpense.Interval, recurringExpense.Occurrences, string(tagsJSON))
	if err != nil {
		return fmt.Errorf("failed to insert recurring expense rule: %v", err)
	}

	expensesToAdd := generateExpensesFromRecurring(userID, recurringExpense, false)
	if len(expensesToAdd) > 0 {
		stmt, err := tx.Prepare(pq.CopyIn("expenses", "id", "user_id", "recurring_id", "name", "category", "amount", "currency", "date", "tags"))
		if err != nil {
			return fmt.Errorf("failed to prepare copy in: %v", err)
		}
		defer stmt.Close()
		for _, exp := range expensesToAdd {
			expTagsJSON, _ := json.Marshal(exp.Tags)
			_, err = stmt.Exec(exp.ID, exp.UserID, exp.RecurringID, exp.Name, exp.Category, exp.Amount, exp.Currency, exp.Date, string(expTagsJSON))
			if err != nil {
				return fmt.Errorf("failed to execute copy in: %v", err)
			}
		}
		if _, err = stmt.Exec(); err != nil {
			return fmt.Errorf("failed to finalize copy in: %v", err)
		}
	}
	return tx.Commit()
}

func (s *databaseStore) UpdateRecurringExpense(userID, id string, recurringExpense RecurringExpense, updateAll bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %v", err)
	}
	defer tx.Rollback()
	recurringExpense.ID = id // Ensure ID is preserved
	if recurringExpense.Currency == "" {
		if currency, err := s.GetCurrency(userID); err == nil {
			recurringExpense.Currency = currency
		}
	}
	tagsJSON, _ := json.Marshal(recurringExpense.Tags)
	ruleQuery := `
		UPDATE recurring_expenses
		SET name = $1, amount = $2, category = $3, start_date = $4, interval = $5, occurrences = $6, tags = $7, currency = $8
		WHERE user_id = $9 AND id = $10
	`
	res, err := tx.Exec(ruleQuery, recurringExpense.Name, recurringExpense.Amount, recurringExpense.Category, recurringExpense.StartDate, recurringExpense.Interval, recurringExpense.Occurrences, string(tagsJSON), recurringExpense.Currency, userID, id)
	if err != nil {
		return fmt.Errorf("failed to update recurring expense rule: %v", err)
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("recurring expense with ID %s not found to update", id)
	}

	var deleteQuery string
	if updateAll {
		deleteQuery = `DELETE FROM expenses WHERE user_id = $1 AND recurring_id = $2`
		_, err = tx.Exec(deleteQuery, userID, id)
	} else {
		deleteQuery = `DELETE FROM expenses WHERE user_id = $1 AND recurring_id = $2 AND date > $3`
		_, err = tx.Exec(deleteQuery, userID, id, time.Now())
	}
	if err != nil {
		return fmt.Errorf("failed to delete old expense instances for update: %v", err)
	}

	expensesToAdd := generateExpensesFromRecurring(userID, recurringExpense, !updateAll)
	if len(expensesToAdd) > 0 {
		stmt, err := tx.Prepare(pq.CopyIn("expenses", "id", "user_id", "recurring_id", "name", "category", "amount", "currency", "date", "tags"))
		if err != nil {
			return fmt.Errorf("failed to prepare copy in for update: %v", err)
		}
		defer stmt.Close()
		for _, exp := range expensesToAdd {
			expTagsJSON, _ := json.Marshal(exp.Tags)
			_, err = stmt.Exec(exp.ID, exp.UserID, exp.RecurringID, exp.Name, exp.Category, exp.Amount, exp.Currency, exp.Date, string(expTagsJSON))
			if err != nil {
				return fmt.Errorf("failed to execute copy in for update: %v", err)
			}
		}
		if _, err = stmt.Exec(); err != nil {
			return fmt.Errorf("failed to finalize copy in for update: %v", err)
		}
	}
	return tx.Commit()
}

func (s *databaseStore) RemoveRecurringExpense(userID, id string, removeAll bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %v", err)
	}
	defer tx.Rollback()
	res, err := tx.Exec(`DELETE FROM recurring_expenses WHERE user_id = $1 AND id = $2`, userID, id)
	if err != nil {
		return fmt.Errorf("failed to delete recurring expense rule: %v", err)
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("recurring expense with ID %s not found", id)
	}

	var deleteQuery string
	if removeAll {
		deleteQuery = `DELETE FROM expenses WHERE user_id = $1 AND recurring_id = $2`
		_, err = tx.Exec(deleteQuery, userID, id)
	} else {
		deleteQuery = `DELETE FROM expenses WHERE user_id = $1 AND recurring_id = $2 AND date > $3`
		_, err = tx.Exec(deleteQuery, userID, id, time.Now())
	}
	if err != nil {
		return fmt.Errorf("failed to delete expense instances: %v", err)
	}
	return tx.Commit()
}

func generateExpensesFromRecurring(userID string, recExp RecurringExpense, fromToday bool) []Expense {
	var expenses []Expense
	currentDate := recExp.StartDate
	today := time.Now()
	occurrencesToGenerate := recExp.Occurrences
	if fromToday {
		for currentDate.Before(today) && (recExp.Occurrences == 0 || occurrencesToGenerate > 0) {
			switch recExp.Interval {
			case "daily":
				currentDate = currentDate.AddDate(0, 0, 1)
			case "weekly":
				currentDate = currentDate.AddDate(0, 0, 7)
			case "monthly":
				currentDate = currentDate.AddDate(0, 1, 0)
			case "yearly":
				currentDate = currentDate.AddDate(1, 0, 0)
			default:
				return expenses // Stop if interval is invalid
			}
			if recExp.Occurrences > 0 {
				occurrencesToGenerate--
			}
		}
	}
	limit := occurrencesToGenerate
	// if recExp.Occurrences == 0 {
	// 	limit = 2000 // Heuristic for "indefinite"
	// }

	for range limit {
		expense := Expense{
			UserID:      userID,
			ID:          uuid.New().String(),
			RecurringID: recExp.ID,
			Name:        recExp.Name,
			Category:    recExp.Category,
			Amount:      recExp.Amount,
			Currency:    recExp.Currency,
			Date:        currentDate,
			Tags:        recExp.Tags,
		}
		expenses = append(expenses, expense)
		switch recExp.Interval {
		case "daily":
			currentDate = currentDate.AddDate(0, 0, 1)
		case "weekly":
			currentDate = currentDate.AddDate(0, 0, 7)
		case "monthly":
			currentDate = currentDate.AddDate(0, 1, 0)
		case "yearly":
			currentDate = currentDate.AddDate(1, 0, 0)
		default:
			return expenses
		}
	}
	return expenses
}
