package contracts

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const MatchRequestedV1Type = "match.requested.v1"

type MatchRequestedV1 struct {
	EventID      string `json:"eventId"`
	Type         string `json:"type"`
	OccurredAt   string `json:"occurredAt"`
	RequestID    string `json:"requestId"`
	MatchJobID   string `json:"matchJobId"`
	TaskID       string `json:"taskId"`
	ModelVersion string `json:"modelVersion"`
}

func DecodeMatchRequested(reader io.Reader) (MatchRequestedV1, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()

	var event MatchRequestedV1
	if err := decoder.Decode(&event); err != nil {
		return MatchRequestedV1{}, fmt.Errorf("decode match requested event: %w", err)
	}

	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return MatchRequestedV1{}, errors.New("decode match requested event: trailing JSON value")
	}

	if event.Type != MatchRequestedV1Type {
		return MatchRequestedV1{}, fmt.Errorf("unsupported event type %q", event.Type)
	}
	if event.EventID == "" || event.RequestID == "" || event.MatchJobID == "" || event.TaskID == "" || event.ModelVersion == "" {
		return MatchRequestedV1{}, errors.New("match requested event has an empty required field")
	}
	if _, err := time.Parse(time.RFC3339Nano, event.OccurredAt); err != nil {
		return MatchRequestedV1{}, fmt.Errorf("invalid occurredAt: %w", err)
	}

	return event, nil
}
