package handler

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/store"
)

const validBody = `{"eventId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a211","type":"match.requested.v1","occurredAt":"2026-08-20T12:00:00Z","requestId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a212","matchJobId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a213","taskId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a214","modelVersion":"baseline-v1"}`

func TestHandleMessageRejectsPoisonBodyWithRecognizableError(t *testing.T) {
	handler := NewSQS(&fakeProcessor{})
	_, err := handler.HandleMessage(context.Background(), `{"type":"match.requested.v1","unexpected":true}`)
	if !errors.Is(err, ErrPoisonMessage) {
		t.Fatalf("error = %v, want ErrPoisonMessage", err)
	}
}

func TestHandleMessagePreservesDuplicateResult(t *testing.T) {
	processor := &fakeProcessor{result: store.ProcessResult{Duplicate: true}}
	result, err := NewSQS(processor).HandleMessage(context.Background(), validBody)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Duplicate || processor.calls != 1 {
		t.Fatalf("result = %#v, processor calls = %d", result, processor.calls)
	}
}

func TestHandleMessageAcceptsStandardSNSEnvelope(t *testing.T) {
	topicARN := "arn:aws:sns:us-east-1:123456789012:agent-market-events"
	body, _ := json.Marshal(map[string]any{"Type": "Notification", "TopicArn": topicARN, "Message": validBody})
	processor := &fakeProcessor{}
	if _, err := NewSQS(processor, topicARN).HandleMessage(context.Background(), string(body)); err != nil {
		t.Fatal(err)
	}
	if processor.calls != 1 {
		t.Fatalf("processor calls = %d", processor.calls)
	}
}

func TestHandleMessageRejectsSNSWrongTypeOrTopicAsPoison(t *testing.T) {
	allowed := "arn:aws:sns:us-east-1:123456789012:allowed"
	for _, envelope := range []map[string]any{
		{"Type": "SubscriptionConfirmation", "TopicArn": allowed, "Message": validBody},
		{"Type": "Notification", "TopicArn": "arn:aws:sns:us-east-1:123456789012:other", "Message": validBody},
		{"Type": "Notification", "Message": validBody},
	} {
		body, _ := json.Marshal(envelope)
		_, err := NewSQS(&fakeProcessor{}, allowed).HandleMessage(context.Background(), string(body))
		if !errors.Is(err, ErrPoisonMessage) {
			t.Fatalf("error = %v, want ErrPoisonMessage", err)
		}
	}
}

func TestHandleMessageTreatsInvalidIdentifierAsPoison(t *testing.T) {
	invalid := strings.Replace(validBody, "018f3f50-7b2d-7cc1-98f5-9ab68e75a211", "not-a-uuid", 1)
	_, err := NewSQS(&fakeProcessor{}).HandleMessage(context.Background(), invalid)
	if !errors.Is(err, ErrPoisonMessage) {
		t.Fatalf("error = %v, want ErrPoisonMessage", err)
	}
}

func TestHandleMessageDoesNotClassifyDatabaseFailureAsPoison(t *testing.T) {
	_, err := NewSQS(&fakeProcessor{err: errors.New("database unavailable")}).HandleMessage(context.Background(), validBody)
	if err == nil || errors.Is(err, ErrPoisonMessage) {
		t.Fatalf("error = %v, want retryable processing error", err)
	}
}

type fakeProcessor struct {
	result store.ProcessResult
	err    error
	calls  int
}

func (processor *fakeProcessor) Process(context.Context, contracts.MatchRequestedV1) (store.ProcessResult, error) {
	processor.calls++
	return processor.result, processor.err
}
