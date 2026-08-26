package ranking

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	SemanticWeight    = 0.30
	QualityWeight     = 0.25
	ReliabilityWeight = 0.15
	PriceWeight       = 0.15
	FreshnessWeight   = 0.15

	InitialAgentScore  = 0.30
	ScoreWindowEvents  = 20
	ScoreWindowDays    = 90
	ScoreHalfLifeDays  = 30
	CandidatePoolSize  = 4
	SelectedAgentCount = 3
)

type ComponentScores struct {
	Semantic    float64 `json:"semantic"`
	Quality     float64 `json:"quality"`
	Reliability float64 `json:"reliability"`
	Price       float64 `json:"price"`
	Freshness   float64 `json:"freshness"`
}

type Explanation struct {
	Summary       string          `json:"summary"`
	Components    ComponentScores `json:"components"`
	Newcomer      bool            `json:"newcomer"`
	QualitySource string          `json:"quality_source"`
	WindowEvents  int             `json:"window_events"`
}

type ScoreEvent struct {
	Score      float64
	OccurredAt time.Time
}

type Candidate struct {
	ID           string
	ModelTag     string
	Semantic     float64
	Quality      float64
	Reliability  float64
	Price        float64
	Freshness    float64
	IsNewcomer   bool
	Eligible     bool
	TotalScore   float64
	Components   ComponentScores
	Explanation  Explanation
	ModelVersion string
	Exploration  bool
	ScoreEvents  []ScoreEvent
}

// Select ranks a maximum four-candidate draw and returns three candidates
// backed by distinct models. The third slot protects newcomer exploration.
func Select(candidates []Candidate, requestID string, modelVersion string) []Candidate {
	return SelectAt(candidates, requestID, modelVersion, time.Now().UTC())
}

func SelectAt(candidates []Candidate, requestID string, modelVersion string, now time.Time) []Candidate {
	eligible := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		if !candidate.Eligible {
			continue
		}
		eligible = append(eligible, scored(candidate, modelVersion, now))
	}
	sort.Slice(eligible, func(left, right int) bool {
		if eligible[left].TotalScore != eligible[right].TotalScore {
			return eligible[left].TotalScore > eligible[right].TotalScore
		}
		leftHash := stableHash(requestID, eligible[left].ID)
		rightHash := stableHash(requestID, eligible[right].ID)
		if comparison := bytes.Compare(leftHash[:], rightHash[:]); comparison != 0 {
			return comparison < 0
		}
		return eligible[left].ID < eligible[right].ID
	})

	distinct := make([]Candidate, 0, CandidatePoolSize)
	seenModels := make(map[string]struct{}, CandidatePoolSize)
	for _, candidate := range eligible {
		modelKey := strings.TrimSpace(candidate.ModelTag)
		if modelKey == "" {
			modelKey = candidate.ID
		}
		if _, exists := seenModels[modelKey]; exists {
			continue
		}
		seenModels[modelKey] = struct{}{}
		distinct = append(distinct, candidate)
		if len(distinct) == CandidatePoolSize {
			break
		}
	}
	if len(distinct) <= 2 {
		return distinct
	}

	selected := append([]Candidate(nil), distinct[:2]...)
	third := distinct[2]
	for _, candidate := range distinct[2:] {
		if candidate.IsNewcomer {
			third = candidate
			third.Exploration = true
			break
		}
	}
	selected = append(selected, third)
	return selected
}

// DecayedQualityScore applies a bounded 90-day/20-event sliding window and a
// 30-day half-life. Agents without history begin at the confirmed score of 30.
func DecayedQualityScore(events []ScoreEvent, now time.Time) float64 {
	windowStart := now.Add(-ScoreWindowDays * 24 * time.Hour)
	recent := make([]ScoreEvent, 0, len(events))
	for _, event := range events {
		if event.OccurredAt.After(now) || event.OccurredAt.Before(windowStart) {
			continue
		}
		recent = append(recent, event)
	}
	sort.Slice(recent, func(left, right int) bool {
		return recent[left].OccurredAt.After(recent[right].OccurredAt)
	})
	if len(recent) > ScoreWindowEvents {
		recent = recent[:ScoreWindowEvents]
	}
	if len(recent) == 0 {
		return InitialAgentScore
	}

	weightedTotal := 0.0
	weightTotal := 0.0
	for _, event := range recent {
		ageDays := now.Sub(event.OccurredAt).Hours() / 24
		weight := math.Pow(0.5, ageDays/ScoreHalfLifeDays)
		weightedTotal += clamp(event.Score) * weight
		weightTotal += weight
	}
	return clamp(weightedTotal / weightTotal)
}

func scored(candidate Candidate, modelVersion string, now time.Time) Candidate {
	quality := candidate.Quality
	qualitySource := "legacy"
	windowEvents := 0
	if candidate.ScoreEvents != nil {
		quality = DecayedQualityScore(candidate.ScoreEvents, now)
		qualitySource = "decayed-window"
		windowEvents = countWindowEvents(candidate.ScoreEvents, now)
	}
	candidate.Components = ComponentScores{
		Semantic: clamp(candidate.Semantic), Quality: clamp(quality),
		Reliability: clamp(candidate.Reliability), Price: clamp(candidate.Price), Freshness: clamp(candidate.Freshness),
	}
	candidate.TotalScore = clamp(candidate.Components.Semantic*SemanticWeight + candidate.Components.Quality*QualityWeight + candidate.Components.Reliability*ReliabilityWeight + candidate.Components.Price*PriceWeight + candidate.Components.Freshness*FreshnessWeight)
	candidate.ModelVersion = modelVersion
	candidate.Explanation = Explanation{
		Summary:    fmt.Sprintf("weighted score %.6f from semantic, decayed quality, reliability, price, and freshness", candidate.TotalScore),
		Components: candidate.Components, Newcomer: candidate.IsNewcomer,
		QualitySource: qualitySource, WindowEvents: windowEvents,
	}
	return candidate
}

func countWindowEvents(events []ScoreEvent, now time.Time) int {
	windowStart := now.Add(-ScoreWindowDays * 24 * time.Hour)
	count := 0
	for _, event := range events {
		if !event.OccurredAt.After(now) && !event.OccurredAt.Before(windowStart) {
			count++
		}
	}
	return min(count, ScoreWindowEvents)
}

func clamp(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func stableHash(requestID string, agentID string) [32]byte {
	return sha256.Sum256([]byte(requestID + "\x00" + agentID))
}
