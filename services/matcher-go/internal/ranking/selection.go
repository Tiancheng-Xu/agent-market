package ranking

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

type SelectionStatus string

const (
	SelectionStatusSelected             SelectionStatus = "SELECTED"
	SelectionStatusNoEligibleAgent      SelectionStatus = "NO_ELIGIBLE_AGENT"
	SelectionStatusManualReviewRequired SelectionStatus = "MANUAL_REVIEW_REQUIRED"
	SelectionStatusMatchingError        SelectionStatus = "MATCHING_ERROR"

	SelectionReasonHistoryRank          = "HISTORY_RANK"
	SelectionReasonHistoryFallback      = "HISTORY_FALLBACK"
	SelectionReasonColdStartExploration = "COLD_START_EXPLORATION"

	LegacySelectionPolicyVersion = "legacy-compatible-v1"
)

// SelectionPolicy contains the public, reproducible inputs to candidate
// selection. DisableColdStart is intended for high-risk task policy. A caller
// sets ManualReviewRequired when deterministic risk gates prohibit automated
// matching altogether.
type SelectionPolicy struct {
	TaskID               string
	MatchingRound        int
	PolicyVersion        string
	DisableColdStart     bool
	ManualReviewRequired bool
}

// SelectionAudit is safe to persist or publish after the caller has approved
// candidate IDs for its evidence boundary. SeedHash proves the selection seed
// contract without exposing TaskID or the other raw seed inputs.
type SelectionAudit struct {
	PolicyVersion   string   `json:"policyVersion"`
	EligibleCount   int      `json:"eligibleCount"`
	HistoryCount    int      `json:"historyCount"`
	ColdStartCount  int      `json:"coldStartCount"`
	SelectedIDs     []string `json:"selectedIds"`
	SelectionReason []string `json:"selectionReason"`
	SeedHash        string   `json:"seedHash"`
}

type SelectionResult struct {
	Status     SelectionStatus `json:"status"`
	Candidates []Candidate     `json:"candidates"`
	Audit      SelectionAudit  `json:"audit"`
}

func SelectWithPolicy(candidates []Candidate, policy SelectionPolicy, modelVersion string) (SelectionResult, error) {
	return SelectWithPolicyAt(candidates, policy, modelVersion, time.Now().UTC())
}

func SelectWithPolicyAt(candidates []Candidate, policy SelectionPolicy, modelVersion string, now time.Time) (SelectionResult, error) {
	seed, validationErr := selectionSeed(policy)
	result := SelectionResult{
		Status: SelectionStatusMatchingError,
		Audit: SelectionAudit{
			PolicyVersion:   policy.PolicyVersion,
			SelectedIDs:     []string{},
			SelectionReason: []string{},
		},
		Candidates: []Candidate{},
	}
	if validationErr != nil {
		return result, validationErr
	}
	result.Audit.SeedHash = hex.EncodeToString(seed[:])

	history := make([]Candidate, 0, len(candidates))
	coldStart := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		if !candidate.Eligible {
			continue
		}
		candidate = scored(candidate, modelVersion, now)
		result.Audit.EligibleCount++
		if candidate.IsNewcomer {
			coldStart = append(coldStart, candidate)
			result.Audit.ColdStartCount++
			continue
		}
		history = append(history, candidate)
		result.Audit.HistoryCount++
	}

	if policy.ManualReviewRequired {
		result.Status = SelectionStatusManualReviewRequired
		return result, nil
	}
	if result.Audit.EligibleCount == 0 {
		result.Status = SelectionStatusNoEligibleAgent
		return result, nil
	}

	sortRanked(history, policy.TaskID)
	selected := make([]Candidate, 0, SelectedAgentCount)
	reasons := make([]string, 0, SelectedAgentCount)
	seenModels := make(map[string]struct{}, SelectedAgentCount)
	historySeats := 2
	if policy.DisableColdStart {
		historySeats = SelectedAgentCount
	}
	selected, reasons = appendHistory(selected, reasons, history, seenModels, historySeats, SelectionReasonHistoryRank)

	if !policy.DisableColdStart && len(coldStart) > 0 && len(selected) < SelectedAgentCount {
		shuffleColdStart(coldStart, seed)
		for _, candidate := range coldStart {
			if len(selected) == SelectedAgentCount {
				break
			}
			modelKey := candidateModelKey(candidate)
			if _, duplicate := seenModels[modelKey]; duplicate {
				continue
			}
			candidate.Exploration = true
			selected = append(selected, candidate)
			reasons = append(reasons, SelectionReasonColdStartExploration)
			seenModels[modelKey] = struct{}{}
		}
	}

	if len(selected) < SelectedAgentCount {
		selected, reasons = appendHistory(selected, reasons, history, seenModels, SelectedAgentCount-len(selected), SelectionReasonHistoryFallback)
	}
	if len(selected) == 0 && len(coldStart) > 0 && policy.DisableColdStart {
		result.Status = SelectionStatusManualReviewRequired
		return result, nil
	}

	result.Status = SelectionStatusSelected
	result.Candidates = selected
	result.Audit.SelectedIDs = candidateIDsForAudit(selected)
	result.Audit.SelectionReason = reasons
	return result, nil
}

func selectionSeed(policy SelectionPolicy) ([32]byte, error) {
	if strings.TrimSpace(policy.TaskID) == "" {
		return [32]byte{}, fmt.Errorf("matching policy task ID is required")
	}
	if policy.MatchingRound < 0 {
		return [32]byte{}, fmt.Errorf("matching round must be non-negative")
	}
	if strings.TrimSpace(policy.PolicyVersion) == "" {
		return [32]byte{}, fmt.Errorf("matching policy version is required")
	}
	contract := policy.TaskID + "\x00" + strconv.Itoa(policy.MatchingRound) + "\x00" + policy.PolicyVersion
	return sha256.Sum256([]byte(contract)), nil
}

func sortRanked(candidates []Candidate, taskID string) {
	sort.Slice(candidates, func(left, right int) bool {
		if candidates[left].TotalScore != candidates[right].TotalScore {
			return candidates[left].TotalScore > candidates[right].TotalScore
		}
		leftHash := stableHash(taskID, candidates[left].ID)
		rightHash := stableHash(taskID, candidates[right].ID)
		if comparison := strings.Compare(hex.EncodeToString(leftHash[:]), hex.EncodeToString(rightHash[:])); comparison != 0 {
			return comparison < 0
		}
		return candidates[left].ID < candidates[right].ID
	})
}

func appendHistory(selected []Candidate, reasons []string, history []Candidate, seenModels map[string]struct{}, limit int, reason string) ([]Candidate, []string) {
	for _, candidate := range history {
		if limit == 0 || len(selected) == SelectedAgentCount {
			break
		}
		modelKey := candidateModelKey(candidate)
		if _, duplicate := seenModels[modelKey]; duplicate {
			continue
		}
		alreadySelected := false
		for _, existing := range selected {
			if existing.ID == candidate.ID {
				alreadySelected = true
				break
			}
		}
		if alreadySelected {
			continue
		}
		selected = append(selected, candidate)
		reasons = append(reasons, reason)
		seenModels[modelKey] = struct{}{}
		limit--
	}
	return selected, reasons
}

func shuffleColdStart(candidates []Candidate, seed [32]byte) {
	// Canonicalize by UTF-8 bytes first so replay does not depend on database
	// row order or runtime-specific locale collation.
	sort.Slice(candidates, func(left, right int) bool {
		return candidates[left].ID < candidates[right].ID
	})
	state := binary.BigEndian.Uint32(seed[:4])
	if state == 0 {
		state = 1
	}
	for index := len(candidates) - 1; index > 0; index-- {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		other := int((uint64(state) * uint64(index+1)) >> 32)
		candidates[index], candidates[other] = candidates[other], candidates[index]
	}
}

func candidateModelKey(candidate Candidate) string {
	modelKey := strings.TrimSpace(candidate.ModelTag)
	if modelKey == "" {
		return candidate.ID
	}
	return modelKey
}

func candidateIDsForAudit(candidates []Candidate) []string {
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
	}
	return ids
}

// Future semantic retrieval and learned ranking must remain downstream of hard
// eligibility gates. They may reorder eligible history candidates, but cannot
// bypass policy filters or remove the deterministic cold-start audit contract.
