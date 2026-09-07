package ranking

import (
	"math"
	"reflect"
	"strings"
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

func TestSelectReturnsTwoTopHistoryCandidatesAndOneDistinctNewcomer(t *testing.T) {
	candidates := []Candidate{
		{ID: "top-old", ModelTag: "old-a", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, Eligible: true},
		{ID: "second-old", ModelTag: "old-b", Semantic: .9, Quality: .9, Reliability: .9, Price: .9, Freshness: .9, Eligible: true},
		{ID: "explore", Semantic: .5, Quality: .5, Reliability: .5, Price: .5, Freshness: .5, IsNewcomer: true, Eligible: true},
		{ID: "ineligible", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, IsNewcomer: true, Eligible: false},
	}
	got := Select(candidates, "request-a", "model-v1")
	want := []string{"top-old", "second-old", "explore"}
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

func TestSelectWithPolicyProducesAuditableDeterministicColdStartSelection(t *testing.T) {
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	candidates := []Candidate{
		{ID: "history-a", ModelTag: "model-a", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, Eligible: true},
		{ID: "history-b", ModelTag: "model-b", Semantic: .9, Quality: .9, Reliability: .9, Price: .9, Freshness: .9, Eligible: true},
		{ID: "history-c", ModelTag: "model-c", Semantic: .8, Quality: .8, Reliability: .8, Price: .8, Freshness: .8, Eligible: true},
		{ID: "cold-a", ModelTag: "model-new-a", IsNewcomer: true, Eligible: true},
		{ID: "cold-b", ModelTag: "model-new-b", IsNewcomer: true, Eligible: true},
		{ID: "blocked", ModelTag: "model-blocked", IsNewcomer: true, Eligible: false},
	}
	policy := SelectionPolicy{TaskID: "task-private-value", MatchingRound: 7, PolicyVersion: "cold-start-v1"}

	first, err := SelectWithPolicyAt(candidates, policy, "score-v1", now)
	if err != nil {
		t.Fatalf("SelectWithPolicyAt() error = %v", err)
	}
	second, err := SelectWithPolicyAt(candidates, policy, "score-v1", now)
	if err != nil {
		t.Fatalf("SelectWithPolicyAt() second error = %v", err)
	}
	if first.Status != SelectionStatusSelected {
		t.Fatalf("status = %q, want %q", first.Status, SelectionStatusSelected)
	}
	if !reflect.DeepEqual(candidateIDs(first.Candidates), candidateIDs(second.Candidates)) {
		t.Fatalf("seeded selection changed: first=%v second=%v", candidateIDs(first.Candidates), candidateIDs(second.Candidates))
	}
	if got := candidateIDs(first.Candidates[:2]); !reflect.DeepEqual(got, []string{"history-a", "history-b"}) {
		t.Fatalf("history seats = %v, want [history-a history-b]", got)
	}
	if !first.Candidates[2].IsNewcomer || !first.Candidates[2].Exploration {
		t.Fatalf("third seat is not cold-start exploration: %#v", first.Candidates[2])
	}
	if first.Audit.PolicyVersion != policy.PolicyVersion || first.Audit.EligibleCount != 5 || first.Audit.HistoryCount != 3 || first.Audit.ColdStartCount != 2 {
		t.Fatalf("unexpected audit counts: %#v", first.Audit)
	}
	if !reflect.DeepEqual(first.Audit.SelectedIDs, candidateIDs(first.Candidates)) {
		t.Fatalf("audit selected ids = %v, candidates = %v", first.Audit.SelectedIDs, candidateIDs(first.Candidates))
	}
	if want := []string{SelectionReasonHistoryRank, SelectionReasonHistoryRank, SelectionReasonColdStartExploration}; !reflect.DeepEqual(first.Audit.SelectionReason, want) {
		t.Fatalf("selection reasons = %v, want %v", first.Audit.SelectionReason, want)
	}
	if len(first.Audit.SeedHash) != 64 || strings.Contains(first.Audit.SeedHash, policy.TaskID) {
		t.Fatalf("seed hash is not a redacted SHA-256 digest: %q", first.Audit.SeedHash)
	}
}

func TestSelectWithPolicyMatchesSharedSeededFisherYatesVectors(t *testing.T) {
	vectors := []struct {
		name          string
		taskID        string
		matchingRound int
		policyVersion string
		agentIDs      []string
		seedHash      string
		selectedIDs   []string
	}{
		{
			name:          "ASCII",
			taskID:        "task-cold",
			matchingRound: 1,
			policyVersion: "fair-v1",
			agentIDs:      []string{"new-d", "new-b", "new-a", "new-c"},
			seedHash:      "aa366ba1cb7874f091fec6e0fed3b293766ec340a53a89171f54b45568bb255a",
			selectedIDs:   []string{"new-d", "new-b", "new-a"},
		},
		{
			name:          "UTF-8 seed fields",
			taskID:        "任务-42",
			matchingRound: 12,
			policyVersion: "公平-v2",
			agentIDs:      []string{"agent-𐀀", "agent-", "agent-a", "agent-Z"},
			seedHash:      "efb6c5da19c3e9a2e64c8af2d8d4ff3902d874df74e17a8facd6996e1f6805f7",
			selectedIDs:   []string{"agent-", "agent-Z", "agent-a"},
		},
	}

	for _, vector := range vectors {
		t.Run(vector.name, func(t *testing.T) {
			candidates := make([]Candidate, 0, len(vector.agentIDs))
			for _, agentID := range vector.agentIDs {
				candidates = append(candidates, Candidate{ID: agentID, ModelTag: agentID, IsNewcomer: true, Eligible: true})
			}
			result, err := SelectWithPolicy(candidates, SelectionPolicy{
				TaskID:        vector.taskID,
				MatchingRound: vector.matchingRound,
				PolicyVersion: vector.policyVersion,
			}, "score-v1")
			if err != nil {
				t.Fatalf("SelectWithPolicy() error = %v", err)
			}
			if result.Audit.SeedHash != vector.seedHash {
				t.Fatalf("seed hash = %q, want %q", result.Audit.SeedHash, vector.seedHash)
			}
			if got := candidateIDs(result.Candidates); !reflect.DeepEqual(got, vector.selectedIDs) {
				t.Fatalf("selected ids = %v, want %v", got, vector.selectedIDs)
			}
		})
	}
}

func TestSelectWithPolicyFallsBackToHistoryWhenNoColdStartCandidateExists(t *testing.T) {
	candidates := []Candidate{
		{ID: "a", ModelTag: "a", Semantic: 1, Eligible: true},
		{ID: "b", ModelTag: "b", Semantic: .9, Eligible: true},
		{ID: "c", ModelTag: "c", Semantic: .8, Eligible: true},
	}
	result, err := SelectWithPolicy(candidates, SelectionPolicy{TaskID: "task-a", PolicyVersion: "policy-v1"}, "score-v1")
	if err != nil {
		t.Fatalf("SelectWithPolicy() error = %v", err)
	}
	if got := candidateIDs(result.Candidates); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("ids = %v, want history fallback", got)
	}
	if want := []string{SelectionReasonHistoryRank, SelectionReasonHistoryRank, SelectionReasonHistoryFallback}; !reflect.DeepEqual(result.Audit.SelectionReason, want) {
		t.Fatalf("selection reasons = %v, want %v", result.Audit.SelectionReason, want)
	}
}

func TestSelectWithPolicyFillsAllSeatsFromColdStartDuringPureColdBoot(t *testing.T) {
	candidates := []Candidate{
		{ID: "cold-a", ModelTag: "a", IsNewcomer: true, Eligible: true},
		{ID: "cold-b", ModelTag: "b", IsNewcomer: true, Eligible: true},
		{ID: "cold-c", ModelTag: "c", IsNewcomer: true, Eligible: true},
		{ID: "cold-d", ModelTag: "d", IsNewcomer: true, Eligible: true},
	}
	policy := SelectionPolicy{TaskID: "task-cold-boot", MatchingRound: 1, PolicyVersion: "policy-v1"}
	first, err := SelectWithPolicy(candidates, policy, "score-v1")
	if err != nil {
		t.Fatalf("SelectWithPolicy() error = %v", err)
	}
	second, err := SelectWithPolicy(candidates, policy, "score-v1")
	if err != nil {
		t.Fatalf("SelectWithPolicy() repeat error = %v", err)
	}
	if len(first.Candidates) != SelectedAgentCount {
		t.Fatalf("selected count = %d, want %d", len(first.Candidates), SelectedAgentCount)
	}
	if !reflect.DeepEqual(candidateIDs(first.Candidates), candidateIDs(second.Candidates)) {
		t.Fatalf("cold boot selection is not reproducible: first=%v second=%v", candidateIDs(first.Candidates), candidateIDs(second.Candidates))
	}
	for _, reason := range first.Audit.SelectionReason {
		if reason != SelectionReasonColdStartExploration {
			t.Fatalf("selection reason = %q, want %q", reason, SelectionReasonColdStartExploration)
		}
	}
}

func TestSelectWithPolicyCanDisableColdStartForHighRiskTask(t *testing.T) {
	candidates := []Candidate{
		{ID: "history-a", ModelTag: "a", Semantic: 1, Eligible: true},
		{ID: "history-b", ModelTag: "b", Semantic: .9, Eligible: true},
		{ID: "history-c", ModelTag: "c", Semantic: .8, Eligible: true},
		{ID: "cold", ModelTag: "new", Semantic: 1, IsNewcomer: true, Eligible: true},
	}
	result, err := SelectWithPolicy(candidates, SelectionPolicy{TaskID: "task-risk", PolicyVersion: "policy-v1", DisableColdStart: true}, "score-v1")
	if err != nil {
		t.Fatalf("SelectWithPolicy() error = %v", err)
	}
	if got := candidateIDs(result.Candidates); !reflect.DeepEqual(got, []string{"history-a", "history-b", "history-c"}) {
		t.Fatalf("ids = %v, want history-only selection", got)
	}
}

func TestSelectWithPolicyPreservesModelDiversityAcrossHistoryAndExploration(t *testing.T) {
	candidates := []Candidate{
		{ID: "history-a", ModelTag: "shared", Semantic: 1, Eligible: true},
		{ID: "history-duplicate", ModelTag: "shared", Semantic: .99, Eligible: true},
		{ID: "history-b", ModelTag: "history-b", Semantic: .9, Eligible: true},
		{ID: "cold-collision", ModelTag: "shared", IsNewcomer: true, Eligible: true},
		{ID: "cold-distinct", ModelTag: "cold-distinct", IsNewcomer: true, Eligible: true},
	}
	result, err := SelectWithPolicy(candidates, SelectionPolicy{TaskID: "task-diverse", PolicyVersion: "policy-v1"}, "score-v1")
	if err != nil {
		t.Fatalf("SelectWithPolicy() error = %v", err)
	}
	if got := candidateIDs(result.Candidates); !reflect.DeepEqual(got, []string{"history-a", "history-b", "cold-distinct"}) {
		t.Fatalf("ids = %v, want cross-pool model diversity", got)
	}
}

func TestSelectWithPolicyReturnsBusinessStatusesWithoutSystemErrors(t *testing.T) {
	noEligible, err := SelectWithPolicy([]Candidate{{ID: "blocked", Eligible: false}}, SelectionPolicy{TaskID: "task-empty", PolicyVersion: "policy-v1"}, "score-v1")
	if err != nil || noEligible.Status != SelectionStatusNoEligibleAgent {
		t.Fatalf("no eligible result = %#v, err=%v", noEligible, err)
	}

	manual, err := SelectWithPolicy([]Candidate{{ID: "eligible", Eligible: true}}, SelectionPolicy{TaskID: "task-review", PolicyVersion: "policy-v1", ManualReviewRequired: true}, "score-v1")
	if err != nil || manual.Status != SelectionStatusManualReviewRequired || len(manual.Candidates) != 0 {
		t.Fatalf("manual review result = %#v, err=%v", manual, err)
	}

	failed, err := SelectWithPolicy(nil, SelectionPolicy{PolicyVersion: "policy-v1"}, "score-v1")
	if err == nil || failed.Status != SelectionStatusMatchingError {
		t.Fatalf("matching error result = %#v, err=%v", failed, err)
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

func TestSelectReturnsThreeDistinctCandidates(t *testing.T) {
	candidates := []Candidate{
		{ID: "stable-a", ModelTag: "model-a", Semantic: 1, Quality: 1, Reliability: 1, Price: 1, Freshness: 1, Eligible: true},
		{ID: "stable-b", ModelTag: "model-b", Semantic: .9, Quality: .9, Reliability: .9, Price: .9, Freshness: .9, Eligible: true},
		{ID: "stable-c", ModelTag: "model-c", Semantic: .8, Quality: .8, Reliability: .8, Price: .8, Freshness: .8, Eligible: true},
		{ID: "explore", ModelTag: "model-new", Semantic: .7, Quality: .7, Reliability: .7, Price: .7, Freshness: .7, IsNewcomer: true, Eligible: true},
		{ID: "outside-pool", ModelTag: "model-outside", Semantic: .6, Quality: .6, Reliability: .6, Price: .6, Freshness: .6, IsNewcomer: true, Eligible: true},
	}

	got := Select(candidates, "request-four", "model-v1")
	ids := candidateIDs(got)
	if len(ids) != 3 || !reflect.DeepEqual(ids[:2], []string{"stable-a", "stable-b"}) || (ids[2] != "explore" && ids[2] != "outside-pool") {
		t.Fatalf("ids = %v, want two ranked history candidates plus one cold-start candidate", ids)
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
