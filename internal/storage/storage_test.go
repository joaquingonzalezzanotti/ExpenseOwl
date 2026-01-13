package storage

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestJSONStoreCRUD(t *testing.T) {
	tmpDir := t.TempDir()
	baseConfig := SystemConfig{
		StorageURL:  filepath.Join(tmpDir, "data"),
		StorageType: BackendTypeJSON,
	}

	store, err := InitializeJsonStore(baseConfig)
	if err != nil {
		t.Fatalf("failed to init json store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	expense := Expense{
		Name:     "Prueba",
		Category: "Test",
		Amount:   -100.50,
		Currency: "ars",
		Date:     time.Now(),
	}

	if err := store.AddExpense(expense); err != nil {
		t.Fatalf("add expense: %v", err)
	}

	all, err := store.GetAllExpenses()
	if err != nil {
		t.Fatalf("get all: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("expected 1 expense, got %d", len(all))
	}

	saved := all[0]
	saved.Amount = -200
	if err := store.UpdateExpense(saved.ID, saved); err != nil {
		t.Fatalf("update expense: %v", err)
	}

	updated, err := store.GetExpense(saved.ID)
	if err != nil {
		t.Fatalf("get expense after update: %v", err)
	}
	if updated.Amount != -200 {
		t.Fatalf("expected updated amount -200, got %f", updated.Amount)
	}

	if err := store.RemoveExpense(saved.ID); err != nil {
		t.Fatalf("remove expense: %v", err)
	}
	finalList, err := store.GetAllExpenses()
	if err != nil {
		t.Fatalf("get all after delete: %v", err)
	}
	if len(finalList) != 0 {
		t.Fatalf("expected empty store after delete, got %d", len(finalList))
	}
}

func TestPostgresStoreCRUD(t *testing.T) {
	uri := os.Getenv("TEST_DATABASE_URL")
	if uri == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping postgres integration test")
	}

	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}

	host := parsed.Host
	if parsed.Path == "" || parsed.Path == "/" {
		t.Fatalf("TEST_DATABASE_URL missing database name")
	}
	dbName := parsed.Path[1:]

	user := ""
	pass := ""
	if parsed.User != nil {
		user = parsed.User.Username()
		pass, _ = parsed.User.Password()
	}

	sslMode := parsed.Query().Get("sslmode")
	if sslMode == "" {
		sslMode = "disable"
	}

	baseConfig := SystemConfig{
		StorageURL:  host + "/" + dbName,
		StorageType: BackendTypePostgres,
		StorageUser: user,
		StoragePass: pass,
		StorageSSL:  sslMode,
	}

	store, err := InitializePostgresStore(baseConfig)
	if err != nil {
		t.Fatalf("failed to init postgres store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	expense := Expense{
		Name:     "PG-Test",
		Category: "Test",
		Amount:   -50,
		Currency: "usd",
		Date:     time.Now(),
	}

	if err := store.AddExpense(expense); err != nil {
		t.Fatalf("add expense: %v", err)
	}
	all, err := store.GetAllExpenses()
	if err != nil {
		t.Fatalf("get all: %v", err)
	}
	if len(all) == 0 {
		t.Fatalf("expected expenses in postgres backend")
	}

	saved := all[0]
	saved.Amount = -75
	if err := store.UpdateExpense(saved.ID, saved); err != nil {
		t.Fatalf("update expense: %v", err)
	}

	if err := store.RemoveExpense(saved.ID); err != nil {
		t.Fatalf("remove expense: %v", err)
	}
}
