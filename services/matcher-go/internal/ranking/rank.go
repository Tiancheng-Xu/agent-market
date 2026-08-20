package ranking

import "sort"

type Candidate struct {
	ID         string
	RuleScore  float64
	CTRScore   float64
	IsNewcomer bool
	Eligible   bool
}

func Select(candidates []Candidate, topCount int, explorationCount int) []Candidate {
	eligible := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Eligible {
			eligible = append(eligible, candidate)
		}
	}

	sort.SliceStable(eligible, func(left, right int) bool {
		leftScore := score(eligible[left])
		rightScore := score(eligible[right])
		if leftScore == rightScore {
			return eligible[left].ID < eligible[right].ID
		}
		return leftScore > rightScore
	})

	if topCount < 0 {
		topCount = 0
	}
	if topCount > len(eligible) {
		topCount = len(eligible)
	}

	selected := append([]Candidate(nil), eligible[:topCount]...)
	selectedIDs := make(map[string]struct{}, len(selected))
	for _, candidate := range selected {
		selectedIDs[candidate.ID] = struct{}{}
	}

	for _, candidate := range eligible {
		if explorationCount <= 0 {
			break
		}
		if !candidate.IsNewcomer {
			continue
		}
		if _, exists := selectedIDs[candidate.ID]; exists {
			continue
		}
		selected = append(selected, candidate)
		selectedIDs[candidate.ID] = struct{}{}
		explorationCount--
	}

	return selected
}

func score(candidate Candidate) float64 {
	return candidate.RuleScore*0.7 + candidate.CTRScore*0.3
}
