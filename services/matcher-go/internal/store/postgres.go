package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/ranking"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	ConsumerName       = "matcher-go"
	DefaultRecallLimit = 50
	MaxRecallLimit     = 100
)

const matchableTaskStatus = "matching"

const claimEventSQL = `
INSERT INTO agent_market.consumed_events (event_id, request_id, consumer)
VALUES ($1, $2, $3)
ON CONFLICT (consumer, event_id) DO NOTHING`

const lockTaskSQL = `
SELECT TRUE
FROM agent_market.tasks
WHERE id = $1 AND request_id = $2
  AND status = 'matching'
  AND embedding IS NOT NULL AND vector_norm(embedding) > 0
FOR SHARE`

const recallSQL = `
WITH target AS MATERIALIZED (
  SELECT embedding, requirements, budget_atomic
  FROM agent_market.tasks
  WHERE id = $1 AND request_id = $2
    AND status = 'matching'
    AND embedding IS NOT NULL AND vector_norm(embedding) > 0
), eligible AS MATERIALIZED (
  SELECT a.*, t.embedding AS task_embedding
  FROM target AS t
  JOIN agent_market.agents AS a ON TRUE
  WHERE a.status = 'active'
    AND a.available = TRUE
    AND a.embedding IS NOT NULL
    AND vector_norm(a.embedding) > 0
    AND a.capabilities @> t.requirements
    AND t.budget_atomic >= a.minimum_budget_atomic
)
SELECT
  id::text,
  (1 - (embedding <=> task_embedding))::double precision AS semantic_score,
  quality_score::double precision,
  reliability_score::double precision,
  price_score::double precision,
  freshness_score::double precision,
  (completed_tasks = 0) AS is_newcomer
FROM eligible
ORDER BY embedding <=> task_embedding, id
LIMIT $3`

const persistCandidateSQL = `
INSERT INTO agent_market.match_candidates (
  match_job_id, agent_id, request_id, rank, total_score,
  component_scores, explanation, model_version, exploration
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

type ProcessResult struct {
	Duplicate  bool
	Candidates []ranking.Candidate
}

type rowIterator interface {
	Close()
	Err() error
	Next() bool
	Scan(dest ...any) error
}

type transaction interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (rowIterator, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Commit(context.Context) error
	Rollback(context.Context) error
}

type pgxTransaction struct{ pgx.Tx }

func (transaction pgxTransaction) Query(ctx context.Context, sql string, arguments ...any) (rowIterator, error) {
	return transaction.Tx.Query(ctx, sql, arguments...)
}

func (transaction pgxTransaction) QueryRow(ctx context.Context, sql string, arguments ...any) pgx.Row {
	return transaction.Tx.QueryRow(ctx, sql, arguments...)
}

var ErrTaskRequestMismatch = errors.New("task and request do not match or task embedding is invalid")

type Postgres struct {
	begin       func(context.Context) (transaction, error)
	recallLimit int
}

func NewPostgres(pool *pgxpool.Pool, recallLimit int) *Postgres {
	if recallLimit <= 0 {
		recallLimit = DefaultRecallLimit
	}
	if recallLimit > MaxRecallLimit {
		recallLimit = MaxRecallLimit
	}
	return &Postgres{
		begin: func(ctx context.Context) (transaction, error) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				return nil, err
			}
			return pgxTransaction{Tx: tx}, nil
		},
		recallLimit: recallLimit,
	}
}

func (postgres *Postgres) Process(ctx context.Context, event contracts.MatchRequestedV1) (result ProcessResult, err error) {
	tx, err := postgres.begin(ctx)
	if err != nil {
		return ProcessResult{}, fmt.Errorf("begin matcher transaction: %w", err)
	}
	defer func() {
		if err != nil {
			rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		}
	}()

	claim, err := tx.Exec(ctx, claimEventSQL, event.EventID, event.RequestID, ConsumerName)
	if err != nil {
		return ProcessResult{}, fmt.Errorf("claim match event: %w", err)
	}
	if claim.RowsAffected() == 0 {
		if err = tx.Commit(ctx); err != nil {
			return ProcessResult{}, fmt.Errorf("commit duplicate match event: %w", err)
		}
		return ProcessResult{Duplicate: true}, nil
	}
	var taskValid bool
	if err = tx.QueryRow(ctx, lockTaskSQL, event.TaskID, event.RequestID).Scan(&taskValid); errors.Is(err, pgx.ErrNoRows) {
		return ProcessResult{}, ErrTaskRequestMismatch
	} else if err != nil {
		return ProcessResult{}, fmt.Errorf("validate match task: %w", err)
	}
	if !taskValid {
		return ProcessResult{}, ErrTaskRequestMismatch
	}

	rows, err := tx.Query(ctx, recallSQL, event.TaskID, event.RequestID, postgres.recallLimit)
	if err != nil {
		return ProcessResult{}, fmt.Errorf("recall match candidates: %w", err)
	}
	candidates, err := scanCandidates(rows)
	if err != nil {
		return ProcessResult{}, err
	}
	selected := ranking.Select(candidates, event.RequestID, event.ModelVersion)

	for index, candidate := range selected {
		componentScores, marshalErr := json.Marshal(candidate.Components)
		if marshalErr != nil {
			return ProcessResult{}, fmt.Errorf("marshal component scores: %w", marshalErr)
		}
		explanation, marshalErr := json.Marshal(candidate.Explanation)
		if marshalErr != nil {
			return ProcessResult{}, fmt.Errorf("marshal explanation: %w", marshalErr)
		}
		if _, err = tx.Exec(ctx, persistCandidateSQL, event.MatchJobID, candidate.ID, event.RequestID, index+1, candidate.TotalScore, componentScores, explanation, candidate.ModelVersion, candidate.Exploration); err != nil {
			return ProcessResult{}, fmt.Errorf("persist match candidate: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return ProcessResult{}, fmt.Errorf("commit matcher transaction: %w", err)
	}
	return ProcessResult{Candidates: selected}, nil
}

func scanCandidates(rows rowIterator) ([]ranking.Candidate, error) {
	defer rows.Close()
	candidates := make([]ranking.Candidate, 0)
	for rows.Next() {
		candidate := ranking.Candidate{Eligible: true}
		if err := rows.Scan(&candidate.ID, &candidate.Semantic, &candidate.Quality, &candidate.Reliability, &candidate.Price, &candidate.Freshness, &candidate.IsNewcomer); err != nil {
			return nil, fmt.Errorf("scan match candidate: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return nil, fmt.Errorf("iterate match candidates: %w", err)
	} else if err != nil {
		return nil, err
	}
	return candidates, nil
}
