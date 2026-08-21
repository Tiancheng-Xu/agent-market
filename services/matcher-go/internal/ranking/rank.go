package ranking

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"sort"
)

const (
	SemanticWeight    = 0.30
	QualityWeight     = 0.25
	ReliabilityWeight = 0.15
	PriceWeight       = 0.15
	FreshnessWeight   = 0.15
)

type ComponentScores struct {
	Semantic    float64 `json:"semantic"`
	Quality     float64 `json:"quality"`
	Reliability float64 `json:"reliability"`
	Price       float64 `json:"price"`
	Freshness   float64 `json:"freshness"`
}

type Explanation struct {
	Summary    string          `json:"summary"`
	Components ComponentScores `json:"components"`
	Newcomer   bool            `json:"newcomer"`
}

type Candidate struct {
	ID           string
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
}

// Select returns at most two highest-scoring eligible candidates followed by
// one eligible newcomer not already present in the top set.
func Select(candidates []Candidate, requestID string, modelVersion string) []Candidate {
	eligible := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		if !candidate.Eligible {
			continue
		}
		eligible = append(eligible, scored(candidate, modelVersion))
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

	topCount := min(2, len(eligible))
	selected := append([]Candidate(nil), eligible[:topCount]...)
	selectedIDs := make(map[string]struct{}, len(selected))
	for _, candidate := range selected {
		selectedIDs[candidate.ID] = struct{}{}
	}
	for _, candidate := range eligible[topCount:] {
		if !candidate.IsNewcomer {
			continue
		}
		if _, exists := selectedIDs[candidate.ID]; exists {
			continue
		}
		candidate.Exploration = true
		selected = append(selected, candidate)
		break
	}
	return selected
}

func scored(candidate Candidate, modelVersion string) Candidate {
	candidate.Components = ComponentScores{
		Semantic: clamp(candidate.Semantic), Quality: clamp(candidate.Quality),
		Reliability: clamp(candidate.Reliability), Price: clamp(candidate.Price), Freshness: clamp(candidate.Freshness),
	}
	candidate.TotalScore = clamp(candidate.Components.Semantic*SemanticWeight + candidate.Components.Quality*QualityWeight + candidate.Components.Reliability*ReliabilityWeight + candidate.Components.Price*PriceWeight + candidate.Components.Freshness*FreshnessWeight)
	candidate.ModelVersion = modelVersion
	candidate.Explanation = Explanation{
		Summary:    fmt.Sprintf("weighted score %.6f from semantic, quality, reliability, price, and freshness", candidate.TotalScore),
		Components: candidate.Components, Newcomer: candidate.IsNewcomer,
	}
	return candidate
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
