package main

import (
	"context"
	"errors"
	"testing"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/handler"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/store"
	"github.com/aws/aws-lambda-go/events"
)

type batchHandler struct{ failures map[string]bool }

func (handler batchHandler) HandleMessage(_ context.Context, body string) (store.ProcessResult, error) {
	if handler.failures[body] {
		return store.ProcessResult{}, errors.New("failed")
	}
	return store.ProcessResult{}, nil
}

type countingProcessor struct{ calls int }

func (processor *countingProcessor) Process(context.Context, contracts.MatchRequestedV1) (store.ProcessResult, error) {
	processor.calls++
	return store.ProcessResult{}, nil
}

func TestHandleBatchReportsInvalidUUIDWithoutRetryingSuccessfulRawMessage(t *testing.T) {
	valid := `{"eventId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a211","type":"match.requested.v1","occurredAt":"2026-08-20T12:00:00Z","requestId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a212","matchJobId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a213","taskId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a214","modelVersion":"baseline-v1"}`
	invalid := `{"eventId":"not-a-uuid","type":"match.requested.v1","occurredAt":"2026-08-20T12:00:00Z","requestId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a212","matchJobId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a213","taskId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a214","modelVersion":"baseline-v1"}`
	processor := &countingProcessor{}
	response := handleBatch(context.Background(), events.SQSEvent{Records: []events.SQSMessage{
		{MessageId: "valid", Body: valid},
		{MessageId: "poison", Body: invalid},
	}}, handler.NewSQS(processor))
	if processor.calls != 1 || len(response.BatchItemFailures) != 1 || response.BatchItemFailures[0].ItemIdentifier != "poison" {
		t.Fatalf("processor calls=%d response=%#v", processor.calls, response)
	}
}

func TestHandleBatchReportsOnlyFailedMessages(t *testing.T) {
	event := events.SQSEvent{Records: []events.SQSMessage{
		{MessageId: "ok-1", Body: "ok"},
		{MessageId: "bad-1", Body: "bad"},
		{MessageId: "ok-2", Body: "ok"},
	}}
	response := handleBatch(context.Background(), event, batchHandler{failures: map[string]bool{"bad": true}})
	if len(response.BatchItemFailures) != 1 || response.BatchItemFailures[0].ItemIdentifier != "bad-1" {
		t.Fatalf("unexpected partial batch response: %#v", response)
	}
}
