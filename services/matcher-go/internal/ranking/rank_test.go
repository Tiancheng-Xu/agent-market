package ranking

import (
	"math"
	"reflect"
	"testing"
	"time"
)

func TestSelectUsesFixedWeightsAndClampsScores(t *testing.T) {
	selected := Select([]Candidate{{ID: "agent-a", Semantic: 2, Quality: 0.8, Reliability: 0.6, Price: 0.4, Freshness: -1, Eligible: true}}, "request-a", "model-v1")
	if len(selected) != 1 {
		t.Fatalf("selected count = %d, want 1", len(selected))
	}
	want := 1*0.30 + 0.8*0.25 + 0.6*0.15 + 0.4*0.15
	if math.Abs(selected[0].TotalScore-want) > 1e-12 {
		t.Fatalf("total score = %f, want %f", selected[0].TotalScore, want)
	}
	if selected[0].Components.Semantic != 1 || selected[0].Components.Freshness != 0 {
		t.Fatalf("component scores were not clamped: %#v", selected[0].Components)
	}
	if selected[0].ModelVersion != "model-v1" || selected[0].Explanation.Summary == "" {
		t.Fatalf("missing output metadata: %#v", selected[0])
	}
}

func TestSelectReturnsTwoTopAndOneDistinctNewcomer(t *testing.T) {
	candidates := []Candidate{
		{ID: "top-new", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, IsNewcomer: true, Eligible: true},
		{ID: "top-old", Semantic: .9, Quality: .9, Reliability: .9, Price: .9, Freshness: .9, Eligible: true},
		{ID: "explore", Semantic: .5, Quality: .5, Reliability: .5, Price: .5, Freshness: .5, IsNewcomer: true, Eligible: true},
		{ID: "ineligible", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, IsNewcomer: true, Eligible: false},
	}
	got := Select(candidates, "request-a", "model-v1")
	want := []string{"top-new", "top-old", "explore"}
	if !reflect.DeepEqual(candidateIDs(got), want) {
		t.Fatalf("ids = %v, want %v", candidateIDs(got), want)
	}
	if got[0].Exploration || got[1].Exploration || !got[2].Exploration {
		t.Fatalf("unexpected exploration flags: %#v", got)
	}
}

func TestSelectIsDeterministicForTies(t *testing.T) {
	candidates := []Candidate{
		{ID: "a", Semantic: .5, Quality: .5, Reliability: .5, Price: .5, Freshness: .5, Eligible: true},
		{ID: "b", Semantic: .5, Quality: .5, Reliability: .5, Price: .5, Freshness: .5, Eligible: true},
		{ID: "c", Semantic: .5, Quality: .5, Reliability: .5, Price: .5, Freshness: .5, IsNewcomer: true, Eligible: true},
	}
	first := candidateIDs(Select(candidates, "request-stable", "model-v1"))
	for range 10 {
		if got := candidateIDs(Select(candidates, "request-stable", "model-v1")); !reflect.DeepEqual(got, first) {
			t.Fatalf("non-deterministic order: first %v, got %v", first, got)
		}
	}
}

func TestSelectReturnsActualCountWithoutPadding(t *testing.T) {
	got := Select([]Candidate{{ID: "only", Semantic: .5, Eligible: true}}, "request-a", "model-v1")
	want := []string{"only"}
	if !reflect.DeepEqual(candidateIDs(got), want) {
		t.Fatalf("ids = %v, want %v", candidateIDs(got), want)
	}
}

func TestDecayedQualityUsesRecentBoundedWindow(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	score := DecayedQualityScore([]ScoreEvent{
		{Score: 1, OccurredAt: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)},
		{Score: .8, OccurredAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
		{Score: .2, OccurredAt: time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC)},
	}, now)
	if score <= .2 || score >= .5 {
		t.Fatalf("decayed score = %f, want recent-weighted score between .2 and .5", score)
	}
	if initial := DecayedQualityScore([]ScoreEvent{}, now); initial != .3 {
		t.Fatalf("initial score = %f, want .3", initial)
	}
}

func TestSelectUsesOnlyFourCandidatePoolAndReturnsThree(t *testing.T) {
	candidates := []Candidate{
		{ID: "stable-a", ModelTag: "model-a", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, Eligible: true},
		{ID: "stable-b", ModelTag: "model-b", Semantic: .9, Quality: .9, Reliability: .9, Price: .9, Freshness: .9, Eligible: true},
		{ID: "stable-c", ModelTag: "model-c", Semantic: .8, Quality: .8, Reliability: .8, Price: .8, Freshness: .8, Eligible: true},
		{ID: "explore", ModelTag: "model-new", Semantic: .7, Quality: .7, Reliability: .7, Price: .7, Freshness: .7, IsNewcomer: true, Eligible: true},
		{ID: "outside-pool", ModelTag: "model-outside", Semantic: .6, Quality: .6, Reliability: .6, Price: .6, Freshness: .6, IsNewcomer: true, Eligible: true},
	}

	got := Select(candidates, "request-four", "model-v1")
	want := []string{"stable-a", "stable-b", "explore"}
	if !reflect.DeepEqual(candidateIDs(got), want) {
		t.Fatalf("ids = %v, want %v", candidateIDs(got), want)
	}
}

func TestSelectDeduplicatesCandidatesBackedByTheSameModel(t *testing.T) {
	candidates := []Candidate{
		{ID: "same-a", ModelTag: "shared-model", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, Eligible: true},
		{ID: "same-b", ModelTag: "shared-model", Semantic: .9, Quality: .9, Reliability: .9, Price: .9, Freshness: .9, Eligible: true},
		{ID: "other", ModelTag: "other-model", Semantic: .8, Quality: .8, Reliability: .8, Price: .8, Freshness: .8, Eligible: true},
	}

	got := Select(candidates, "request-model", "model-v1")
	if !reflect.DeepEqual(candidateIDs(got), []string{"same-a", "other"}) {
		t.Fatalf("ids = %v, want distinct models", candidateIDs(got))
	}
}

func candidateIDs(candidates []Candidate) []string {
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
	}
	return ids
}
