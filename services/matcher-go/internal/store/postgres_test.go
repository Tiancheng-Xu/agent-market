package store

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestRecallSQLAppliesHardFiltersBeforeBoundedVectorRecall(t *testing.T) {
	required := []string{"MATERIALIZED", "request_id = $2", "status = 'matching'", "publisher_wallet", "a.status = 'active'", "a.available = TRUE", "a.embedding IS NOT NULL", "vector_norm(a.embedding) > 0", "a.capabilities @> t.requirements", "t.category = ANY(a.categories)", "a.tags @> t.tags", "t.budget_atomic >= a.minimum_budget_atomic", "a.selection_access = 'public-market'", "lower(a.owner_wallet) = lower(t.publisher_wallet)", "agent_score_events", "INTERVAL '90 days'", "LIMIT 20", "embedding <=> task_embedding", "LIMIT $3"}
	for _, fragment := range required {
		if !strings.Contains(recallSQL, fragment) {
			t.Errorf("recall SQL missing %q", fragment)
		}
	}
	lower := strings.ToLower(recallSQL)
	if strings.Contains(lower, "ctr") || strings.Contains(lower, "model_score") {
		t.Fatal("model score must not bypass hard filters")
	}
}

func TestTaskLockAndRecallUseTheSameStrictLifecyclePredicate(t *testing.T) {
	predicate := "status = '" + matchableTaskStatus + "'"
	if !strings.Contains(lockTaskSQL, predicate) || !strings.Contains(recallSQL, predicate) {
		t.Fatalf("lock and recall must both require %q", predicate)
	}
	for _, forbidden := range []string{"status = 'open'", "status = 'funded'", "status = 'cancelled'"} {
		if strings.Contains(lockTaskSQL, forbidden) || strings.Contains(recallSQL, forbidden) {
			t.Fatalf("matcher lifecycle predicate must not include %q", forbidden)
		}
	}
}

func TestProcessClaimsRecallsPersistsAndCommitsInOneTransaction(t *testing.T) {
	tx := &fakeTransaction{
		execTags: []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 1"), pgconn.NewCommandTag("INSERT 0 1")},
		rows:     &fakeRows{values: [][]any{{"agent-a", "model-a", 0.9, 0.8, 0.7, 0.6, 0.5, true, "[]"}}},
	}
	postgres := &Postgres{begin: func(context.Context) (transaction, error) { return tx, nil }, recallLimit: MaxRecallLimit}
	result, err := postgres.Process(context.Background(), testEvent())
	if err != nil {
		t.Fatal(err)
	}
	if result.Duplicate || len(result.Candidates) != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if !tx.committed || tx.rolledBack {
		t.Fatalf("transaction state: committed=%v rolledBack=%v", tx.committed, tx.rolledBack)
	}
	want := []string{claimEventSQL, persistCandidateSQL}
	if !reflect.DeepEqual(tx.execSQL, want) {
		t.Fatalf("exec SQL = %v, want claim then persist", tx.execSQL)
	}
	if tx.querySQL != recallSQL {
		t.Fatal("recall query was not executed")
	}
	if !strings.Contains(tx.queryRowSQL, "FOR SHARE") {
		t.Fatalf("task validation did not lock the target row: %q", tx.queryRowSQL)
	}
}

func TestProcessDuplicateEventDoesNotRecallOrPersistAgain(t *testing.T) {
	tx := &fakeTransaction{execTags: []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 0")}}
	postgres := &Postgres{begin: func(context.Context) (transaction, error) { return tx, nil }, recallLimit: DefaultRecallLimit}
	result, err := postgres.Process(context.Background(), testEvent())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Duplicate || len(result.Candidates) != 0 {
		t.Fatalf("unexpected duplicate result: %#v", result)
	}
	if tx.querySQL != "" || len(tx.execSQL) != 1 || !tx.committed {
		t.Fatalf("duplicate performed extra work: %#v", tx)
	}
}

func TestProcessRollsBackWithoutConsumingEventOnFailure(t *testing.T) {
	tx := &fakeTransaction{execTags: []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 1")}, queryErr: errors.New("database unavailable")}
	postgres := &Postgres{begin: func(context.Context) (transaction, error) { return tx, nil }, recallLimit: DefaultRecallLimit}
	if _, err := postgres.Process(context.Background(), testEvent()); err == nil {
		t.Fatal("expected recall failure")
	}
	if !tx.rolledBack || tx.committed {
		t.Fatalf("transaction state: committed=%v rolledBack=%v", tx.committed, tx.rolledBack)
	}
}

func TestProcessRollsBackTaskRequestMismatch(t *testing.T) {
	tx := &fakeTransaction{execTags: []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 1")}}
	postgres := &Postgres{begin: func(context.Context) (transaction, error) { return tx, nil }, recallLimit: DefaultRecallLimit}
	_, err := postgres.Process(context.Background(), testEvent())
	if !errors.Is(err, ErrTaskRequestMismatch) {
		t.Fatalf("error = %v, want ErrTaskRequestMismatch", err)
	}
	if !tx.rolledBack || tx.committed || tx.querySQL != "" {
		t.Fatalf("mismatch transaction state: %#v", tx)
	}
}

func TestProcessRollsBackWhenTaskIsNotMatching(t *testing.T) {
	tx := &fakeTransaction{execTags: []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 1")}}
	postgres := &Postgres{begin: func(context.Context) (transaction, error) { return tx, nil }, recallLimit: DefaultRecallLimit}
	_, err := postgres.Process(context.Background(), testEvent())
	if !errors.Is(err, ErrTaskRequestMismatch) {
		t.Fatalf("error = %v, want lifecycle mismatch", err)
	}
	if !tx.rolledBack || tx.committed || tx.querySQL != "" || !strings.Contains(tx.queryRowSQL, "status = 'matching'") {
		t.Fatalf("lifecycle mismatch transaction state: %#v", tx)
	}
}

func TestProcessRollsBackPersistFailure(t *testing.T) {
	tx := &fakeTransaction{
		execTags: []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 1")},
		rows:     &fakeRows{values: [][]any{{"agent-a", "model-a", 0.9, 0.8, 0.7, 0.6, 0.5, false, "[]"}}},
	}
	postgres := &Postgres{begin: func(context.Context) (transaction, error) { return tx, nil }, recallLimit: DefaultRecallLimit}
	if _, err := postgres.Process(context.Background(), testEvent()); err == nil {
		t.Fatal("expected persist failure")
	}
	if !tx.rolledBack || tx.committed {
		t.Fatalf("persist failure transaction state: %#v", tx)
	}
}

func TestProcessRollsBackWithUsableContextAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tx := &fakeTransaction{
		execTags:    []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 1")},
		queryRowErr: context.Canceled,
	}
	postgres := &Postgres{begin: func(context.Context) (transaction, error) { return tx, nil }, recallLimit: DefaultRecallLimit}
	if _, err := postgres.Process(ctx, testEvent()); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if !tx.rolledBack || tx.rollbackContextErr != nil {
		t.Fatalf("rollback state: rolledBack=%v contextErr=%v", tx.rolledBack, tx.rollbackContextErr)
	}
}

type fakeTransaction struct {
	execTags           []pgconn.CommandTag
	execSQL            []string
	querySQL           string
	queryRowSQL        string
	queryErr           error
	queryRowErr        error
	rows               rowIterator
	committed          bool
	rolledBack         bool
	rollbackContextErr error
	taskValid          bool
}

func (tx *fakeTransaction) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	tx.execSQL = append(tx.execSQL, sql)
	if len(tx.execTags) == 0 {
		return pgconn.CommandTag{}, errors.New("unexpected exec")
	}
	tag := tx.execTags[0]
	tx.execTags = tx.execTags[1:]
	return tag, nil
}
func (tx *fakeTransaction) Query(_ context.Context, sql string, _ ...any) (rowIterator, error) {
	tx.querySQL = sql
	return tx.rows, tx.queryErr
}
func (tx *fakeTransaction) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if sql == selectionGateSQL {
		return fakeSelectionRow{}
	}
	tx.queryRowSQL = sql
	valid := tx.taskValid
	if !valid && tx.rows != nil {
		valid = true
	}
	if !valid && tx.queryRowErr == nil {
		return fakeRow{err: pgx.ErrNoRows}
	}
	return fakeRow{valid: valid, err: tx.queryRowErr}
}
func (tx *fakeTransaction) Commit(context.Context) error { tx.committed = true; return nil }
func (tx *fakeTransaction) Rollback(ctx context.Context) error {
	tx.rolledBack = true
	tx.rollbackContextErr = ctx.Err()
	return nil
}

type fakeRow struct {
	valid bool
	err   error
}

type fakeSelectionRow struct{}

func (fakeSelectionRow) Scan(dest ...any) error { *(dest[0].(*string)) = "ranked"; return nil }

func (row fakeRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	*(dest[0].(*bool)) = row.valid
	return nil
}

type fakeRows struct {
	values  [][]any
	current int
}

func (rows *fakeRows) Close()     {}
func (rows *fakeRows) Err() error { return nil }
func (rows *fakeRows) Next() bool {
	if rows.current >= len(rows.values) {
		return false
	}
	rows.current++
	return true
}
func (rows *fakeRows) Scan(dest ...any) error {
	for index, value := range rows.values[rows.current-1] {
		switch target := dest[index].(type) {
		case *string:
			*target = value.(string)
		case *float64:
			*target = value.(float64)
		case *bool:
			*target = value.(bool)
		default:
			return errors.New("unsupported scan target")
		}
	}
	return nil
}

func testEvent() contracts.MatchRequestedV1 {
	return contracts.MatchRequestedV1{
		EventID: "018f3f50-7b2d-7cc1-98f5-9ab68e75a211", Type: contracts.MatchRequestedV1Type, OccurredAt: "2026-08-20T12:00:00Z",
		RequestID: "018f3f50-7b2d-7cc1-98f5-9ab68e75a212", MatchJobID: "018f3f50-7b2d-7cc1-98f5-9ab68e75a213",
		TaskID: "018f3f50-7b2d-7cc1-98f5-9ab68e75a214", ModelVersion: "baseline-v1",
	}
}
