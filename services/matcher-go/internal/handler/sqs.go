package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/store"
)

var ErrPoisonMessage = errors.New("poison SQS message")

type Processor interface {
	Process(context.Context, contracts.MatchRequestedV1) (store.ProcessResult, error)
}

type SQS struct {
	processor       Processor
	allowedTopicARN map[string]struct{}
}

func NewSQS(processor Processor, allowedTopicARNs ...string) *SQS {
	allowed := make(map[string]struct{}, len(allowedTopicARNs))
	for _, topicARN := range allowedTopicARNs {
		if normalized := strings.TrimSpace(topicARN); normalized != "" {
			allowed[normalized] = struct{}{}
		}
	}
	return &SQS{processor: processor, allowedTopicARN: allowed}
}

func (handler *SQS) HandleMessage(ctx context.Context, body string) (store.ProcessResult, error) {
	if len(body) > 256*1024 {
		return store.ProcessResult{}, fmt.Errorf("%w: body too large", ErrPoisonMessage)
	}
	event, err := contracts.DecodeMatchRequested(strings.NewReader(body))
	if err != nil {
		var envelope struct {
			Type     string `json:"Type"`
			TopicARN string `json:"TopicArn"`
			Message  string `json:"Message"`
		}
		if envelopeErr := json.Unmarshal([]byte(body), &envelope); envelopeErr == nil && envelope.Message != "" {
			if envelope.Type != "Notification" {
				return store.ProcessResult{}, fmt.Errorf("%w: invalid SNS envelope type", ErrPoisonMessage)
			}
			if _, allowed := handler.allowedTopicARN[envelope.TopicARN]; !allowed {
				return store.ProcessResult{}, fmt.Errorf("%w: SNS topic is not allowed", ErrPoisonMessage)
			}
			event, err = contracts.DecodeMatchRequested(strings.NewReader(envelope.Message))
		}
	}
	if err != nil {
		return store.ProcessResult{}, fmt.Errorf("%w: %v", ErrPoisonMessage, err)
	}
	result, err := handler.processor.Process(ctx, event)
	if err != nil {
		return store.ProcessResult{}, fmt.Errorf("process SQS match event: %w", err)
	}
	return result, nil
}
