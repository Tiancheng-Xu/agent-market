package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/integrationguard"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresPgvectorIntegration(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is required")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("TEST_DATABASE_DESTRUCTIVE") != "agent-market-ephemeral-only" ||
		os.Getenv("TEST_DATABASE_HARNESS") != integrationguard.HarnessVersion ||
		(parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1") ||
		!integrationguard.ValidDatabaseName(strings.TrimPrefix(parsed.Path, "/")) {
		t.Fatal("UNSAFE_TEST_DATABASE")
	}
	ownershipToken := os.Getenv("TEST_DATABASE_OWNERSHIP_TOKEN")
	if len(ownershipToken) < 24 {
		t.Fatal("TEST_DATABASE_OWNERSHIP_TOKEN must contain at least 24 characters")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	verifyHarnessDatabase(t, ctx, pool, ownershipToken)
	for _, name := range []string{"0001_agent_market_core.sql", "0003_phase2_lifecycle.sql", "0005_matcher_profile.sql"} {
		content, readErr := os.ReadFile(filepath.Join("..", "..", "..", "..", "database", "migrations", name))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if _, err = pool.Exec(ctx, string(content)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	var postgresVersion string
	var pgvectorVersion string
	if err = pool.QueryRow(ctx, "SHOW server_version").Scan(&postgresVersion); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, "SELECT extversion FROM pg_extension WHERE extname = 'vector'").Scan(&pgvectorVersion); err != nil {
		t.Fatal(err)
	}
	t.Logf("postgres_version=%s pgvector_version=%s", postgresVersion, pgvectorVersion)
	vector := func(first, second float64) string {
		values := make([]string, 384)
		values[0], values[1] = fmt.Sprint(first), fmt.Sprint(second)
		for index := 2; index < len(values); index++ {
			values[index] = "0"
		}
		return "[" + strings.Join(values, ",") + "]"
	}
	taskID := "018f3f50-7b2d-7cc1-98f5-9ab68e75a214"
	requestID := "018f3f50-7b2d-7cc1-98f5-9ab68e75a212"
	_, err = pool.Exec(ctx, `INSERT INTO agent_market.tasks
			(id,publisher_wallet,title,description,requirements,budget_atomic,status,request_id,embedding)
			VALUES ($1,'0x1111111111111111111111111111111111111111','task','task',ARRAY['research'],100,'matching',$2,$3::vector)`, taskID, requestID, vector(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	agents := []struct {
		id, status, capability, embedding string
		available                         bool
		minimum                           int
		completed                         int
	}{
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a301", "active", "research", vector(1, 0), true, 50, 2},
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a302", "active", "research", vector(.9, .1), true, 50, 2},
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a303", "active", "research", vector(.8, .2), true, 50, 0},
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a304", "active", "other", vector(1, 0), true, 50, 0},
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a305", "suspended", "research", vector(1, 0), true, 50, 0},
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a306", "active", "research", vector(1, 0), true, 101, 0},
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a307", "active", "research", vector(1, 0), false, 50, 0},
		{"018f3f50-7b2d-7cc1-98f5-9ab68e75a308", "active", "research", "", true, 50, 0},
	}
	for _, agent := range agents {
		_, err = pool.Exec(ctx, `INSERT INTO agent_market.agents
			(id,owner_wallet,name,description,capabilities,status,embedding,available,minimum_budget_atomic,completed_tasks)
				VALUES ($1,'0x2222222222222222222222222222222222222222',$2,$2,ARRAY[$3],$4,NULLIF($5, '')::vector,$6,$7,$8)`,
			agent.id, agent.id, agent.capability, agent.status, agent.embedding, agent.available, agent.minimum, agent.completed)
		if err != nil {
			t.Fatal(err)
		}
	}
	assertZeroVectorsRejected(t, ctx, pool, vector(0, 0))
	event := contracts.MatchRequestedV1{
		EventID: "018f3f50-7b2d-7cc1-98f5-9ab68e75a211", Type: contracts.MatchRequestedV1Type,
		OccurredAt: "2026-08-20T12:00:00Z", RequestID: requestID,
		MatchJobID: "018f3f50-7b2d-7cc1-98f5-9ab68e75a213", TaskID: taskID, ModelVersion: "baseline-v1",
	}
	repository := NewPostgres(pool, DefaultRecallLimit)
	result, err := repository.Process(ctx, event)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Candidates) != 3 {
		t.Fatalf("candidate count = %d, want 3", len(result.Candidates))
	}
	for _, candidate := range result.Candidates {
		if strings.HasSuffix(candidate.ID, "304") || strings.HasSuffix(candidate.ID, "305") || strings.HasSuffix(candidate.ID, "306") || strings.HasSuffix(candidate.ID, "307") || strings.HasSuffix(candidate.ID, "308") {
			t.Fatalf("ineligible candidate returned: %s", candidate.ID)
		}
	}
	assertPersistedCandidates(t, ctx, pool, event.MatchJobID)
	duplicate, err := repository.Process(ctx, event)
	if err != nil || !duplicate.Duplicate {
		t.Fatalf("duplicate result = %#v, err = %v", duplicate, err)
	}
	mismatch := event
	mismatch.EventID = "018f3f50-7b2d-7cc1-98f5-9ab68e75a299"
	mismatch.RequestID = "018f3f50-7b2d-7cc1-98f5-9ab68e75a298"
	_, err = repository.Process(ctx, mismatch)
	if !errors.Is(err, ErrTaskRequestMismatch) {
		t.Fatalf("mismatch error = %v", err)
	}
	assertEventNotConsumed(t, ctx, pool, mismatch.EventID)
	if _, err = pool.Exec(ctx, "UPDATE agent_market.tasks SET status = 'cancelled' WHERE id = $1", taskID); err != nil {
		t.Fatal(err)
	}
	stale := event
	stale.EventID = "018f3f50-7b2d-7cc1-98f5-9ab68e75a409"
	stale.MatchJobID = "018f3f50-7b2d-7cc1-98f5-9ab68e75a410"
	if _, err = repository.Process(ctx, stale); !errors.Is(err, ErrTaskRequestMismatch) {
		t.Fatalf("non-matching task error = %v", err)
	}
	assertEventNotConsumed(t, ctx, pool, stale.EventID)
	if _, err = pool.Exec(ctx, "UPDATE agent_market.tasks SET status = 'matching' WHERE id = $1", taskID); err != nil {
		t.Fatal(err)
	}
	assertTaskLockBlocksConcurrentUpdate(t, ctx, pool, repository, event)
}

func verifyHarnessDatabase(t *testing.T, ctx context.Context, pool *pgxpool.Pool, token string) {
	t.Helper()
	var schemaExists bool
	if err := pool.QueryRow(ctx, "SELECT to_regnamespace('agent_market') IS NOT NULL").Scan(&schemaExists); err != nil {
		t.Fatal(err)
	}
	if schemaExists {
		t.Fatal("UNSAFE_TEST_DATABASE_ALREADY_INITIALIZED")
	}
	var markerMatches bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM public.agent_market_test_ownership
		WHERE ownership_token = $1 AND database_name = current_database()
	)`, token).Scan(&markerMatches); err != nil {
		t.Fatal(err)
	}
	if !markerMatches {
		t.Fatal("UNSAFE_TEST_DATABASE_OWNERSHIP_MISMATCH")
	}
	var unexpectedTables int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
		WHERE table_schema != 'information_schema' AND table_schema NOT LIKE 'pg_%'
		AND NOT (table_schema = 'public' AND table_name = 'agent_market_test_ownership')`).Scan(&unexpectedTables); err != nil {
		t.Fatal(err)
	}
	if unexpectedTables != 0 {
		t.Fatalf("UNSAFE_TEST_DATABASE_NOT_EMPTY: tables=%d", unexpectedTables)
	}
	var acquired bool
	if err := pool.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", integrationguard.AdvisoryLockKey).Scan(&acquired); err != nil {
		t.Fatal(err)
	}
	if acquired {
		_, _ = pool.Exec(ctx, "SELECT pg_advisory_unlock($1)", integrationguard.AdvisoryLockKey)
		t.Fatal("UNSAFE_TEST_DATABASE_HARNESS_LOCK_MISSING")
	}
}

func assertZeroVectorsRejected(t *testing.T, ctx context.Context, pool *pgxpool.Pool, zeroVector string) {
	t.Helper()
	_, agentErr := pool.Exec(ctx, `INSERT INTO agent_market.agents
		(id,owner_wallet,name,description,capabilities,status,embedding)
		VALUES ('018f3f50-7b2d-7cc1-98f5-9ab68e75a309','0x2222222222222222222222222222222222222222','zero','zero',ARRAY['research'],'active',$1::vector)`, zeroVector)
	var agentPgErr *pgconn.PgError
	if !errors.As(agentErr, &agentPgErr) || agentPgErr.ConstraintName != "agents_embedding_nonzero" {
		t.Fatalf("agent zero vector error = %v, want agents_embedding_nonzero", agentErr)
	}
	_, taskErr := pool.Exec(ctx, `INSERT INTO agent_market.tasks
		(id,publisher_wallet,title,description,requirements,budget_atomic,request_id,embedding)
		VALUES ('018f3f50-7b2d-7cc1-98f5-9ab68e75a399','0x1111111111111111111111111111111111111111','zero','zero',ARRAY['research'],100,$1,$2::vector)`,
		"018f3f50-7b2d-7cc1-98f5-9ab68e75a398", zeroVector)
	var taskPgErr *pgconn.PgError
	if !errors.As(taskErr, &taskPgErr) || taskPgErr.ConstraintName != "tasks_embedding_nonzero" {
		t.Fatalf("task zero vector error = %v, want tasks_embedding_nonzero", taskErr)
	}
}

func assertPersistedCandidates(t *testing.T, ctx context.Context, pool *pgxpool.Pool, matchJobID string) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT rank, total_score::double precision, model_version, exploration
		FROM agent_market.match_candidates WHERE match_job_id = $1 ORDER BY rank`, matchJobID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	wantExploration := []bool{false, false, true}
	previousScore := 2.0
	index := 0
	for rows.Next() {
		var rank int
		var score float64
		var modelVersion string
		var exploration bool
		if err = rows.Scan(&rank, &score, &modelVersion, &exploration); err != nil {
			t.Fatal(err)
		}
		if rank != index+1 || score <= 0 || score > 1 || score > previousScore || modelVersion != "baseline-v1" || exploration != wantExploration[index] {
			t.Fatalf("persisted candidate %d: rank=%d score=%f model=%q exploration=%v", index, rank, score, modelVersion, exploration)
		}
		previousScore = score
		index++
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if index != 3 {
		t.Fatalf("persisted candidate count = %d, want 3", index)
	}
}

func assertEventNotConsumed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eventID string) {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM agent_market.consumed_events WHERE consumer = $1 AND event_id = $2", ConsumerName, eventID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rolled back event persisted: %s", eventID)
	}
}

func assertTaskLockBlocksConcurrentUpdate(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repository *Postgres, event contracts.MatchRequestedV1) {
	t.Helper()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err = blocker.Exec(ctx, "UPDATE agent_market.tasks SET status = 'cancelled' WHERE id = $1", event.TaskID); err != nil {
		t.Fatal(err)
	}
	blockedEvent := event
	blockedEvent.EventID = "018f3f50-7b2d-7cc1-98f5-9ab68e75a401"
	blockedEvent.MatchJobID = "018f3f50-7b2d-7cc1-98f5-9ab68e75a402"
	blockedCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	_, err = repository.Process(blockedCtx, blockedEvent)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("process during concurrent task update error = %v, want deadline exceeded", err)
	}
	if err = blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertEventNotConsumed(t, ctx, pool, blockedEvent.EventID)
}
