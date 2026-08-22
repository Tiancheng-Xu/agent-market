package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/integrationguard"
	"github.com/jackc/pgx/v5"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "matcher PostgreSQL integration harness failed: %v\n", err)
		os.Exit(1)
	}
}

func run() (resultErr error) {
	adminURL := os.Getenv("TEST_POSTGRES_ADMIN_URL")
	parsed, err := url.Parse(adminURL)
	if err != nil || adminURL == "" {
		return errors.New("TEST_POSTGRES_ADMIN_URL is required")
	}
	if parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1" {
		return errors.New("TEST_POSTGRES_ADMIN_URL must use a loopback host")
	}

	databaseName, err := randomDatabaseName()
	if err != nil {
		return err
	}
	ownershipToken, err := randomHex(32)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return fmt.Errorf("connect PostgreSQL admin database: %w", err)
	}
	defer admin.Close(context.Background())

	created := false
	var owner *pgx.Conn
	defer func() {
		if owner != nil {
			_ = owner.Close(context.Background())
		}
		if !created {
			return
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx,
			"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
			databaseName,
		)
		_, cleanupErr := admin.Exec(cleanupCtx, "DROP DATABASE "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)")
		if resultErr == nil && cleanupErr != nil {
			resultErr = fmt.Errorf("drop harness-owned database: %w", cleanupErr)
		}
	}()

	if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize()); err != nil {
		return fmt.Errorf("create dedicated integration database: %w", err)
	}
	created = true
	target := *parsed
	target.Path = "/" + databaseName
	target.RawPath = ""
	owner, err = pgx.Connect(ctx, target.String())
	if err != nil {
		return fmt.Errorf("connect dedicated integration database: %w", err)
	}
	if _, err = owner.Exec(ctx, "SELECT pg_advisory_lock($1)", integrationguard.AdvisoryLockKey); err != nil {
		return fmt.Errorf("hold integration ownership lock: %w", err)
	}
	var existingTables int
	if err = owner.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
		WHERE table_schema != 'information_schema' AND table_schema NOT LIKE 'pg_%'`).Scan(&existingTables); err != nil {
		return fmt.Errorf("verify dedicated database is empty: %w", err)
	}
	if existingTables != 0 {
		return fmt.Errorf("dedicated database is not empty: tables=%d", existingTables)
	}
	if _, err = owner.Exec(ctx, `CREATE TABLE public.agent_market_test_ownership (
		ownership_token text PRIMARY KEY,
		database_name name NOT NULL CHECK (database_name = current_database()),
		created_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create integration ownership marker: %w", err)
	}
	if _, err = owner.Exec(ctx,
		"INSERT INTO public.agent_market_test_ownership (ownership_token, database_name) VALUES ($1, current_database())",
		ownershipToken,
	); err != nil {
		return fmt.Errorf("write integration ownership marker: %w", err)
	}

	command := exec.CommandContext(ctx, "go", "test", "./internal/store", "-run", "^TestPostgresPgvectorIntegration$", "-v", "-count=1")
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = replaceEnvironment(os.Environ(), map[string]string{
		"TEST_DATABASE_URL":             target.String(),
		"TEST_DATABASE_DESTRUCTIVE":     "agent-market-ephemeral-only",
		"TEST_DATABASE_OWNERSHIP_TOKEN": ownershipToken,
		"TEST_DATABASE_HARNESS":         integrationguard.HarnessVersion,
	})
	if err = command.Run(); err != nil {
		return fmt.Errorf("run PostgreSQL integration test: %w", err)
	}
	return nil
}

func randomDatabaseName() (string, error) {
	suffix, err := randomHex(16)
	if err != nil {
		return "", err
	}
	return integrationguard.DatabasePrefix + suffix, nil
}

func randomHex(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate integration ownership material: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

func replaceEnvironment(current []string, replacements map[string]string) []string {
	result := make([]string, 0, len(current)+len(replacements))
	for _, entry := range current {
		key, _, found := strings.Cut(entry, "=")
		if _, replace := replacements[key]; !found || replace {
			continue
		}
		result = append(result, entry)
	}
	for key, value := range replacements {
		result = append(result, key+"="+value)
	}
	return result
}
