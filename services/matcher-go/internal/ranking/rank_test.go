package ranking

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestSelectReturnsTwoTopAndOneNewcomer(t *testing.T) {
	candidates := []Candidate{
		{ID: "a", RuleScore: 0.9, CTRScore: 0.8, Eligible: true},
		{ID: "b", RuleScore: 0.8, CTRScore: 0.7, Eligible: true},
		{ID: "c", RuleScore: 0.7, CTRScore: 0.6, Eligible: true, IsNewcomer: true},
		{ID: "d", RuleScore: 1.0, CTRScore: 1.0, Eligible: false},
	}

	got := Select(candidates, 2, 1)
	if diff := cmp.Diff([]string{"a", "b", "c"}, candidateIDs(got)); diff != "" {
		t.Fatalf("unexpected selected ids (-want +got):\n%s", diff)
	}
}

func candidateIDs(candidates []Candidate) []string {
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
	}
	return ids
}
