package main

import (
	"context"
	"log"
	"os"
	"strings"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/handler"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/store"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/jackc/pgx/v5/pgxpool"
)

type messageHandler interface {
	HandleMessage(context.Context, string) (store.ProcessResult, error)
}

func handleBatch(ctx context.Context, event events.SQSEvent, sqsHandler messageHandler) events.SQSEventResponse {
	response := events.SQSEventResponse{}
	for _, message := range event.Records {
		if _, err := sqsHandler.HandleMessage(ctx, message.Body); err != nil {
			log.Printf("matcher message %q failed: %v", message.MessageId, err)
			response.BatchItemFailures = append(response.BatchItemFailures, events.SQSBatchItemFailure{ItemIdentifier: message.MessageId})
		}
	}
	return response
}

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		log.Fatalf("configure PostgreSQL pool: %v", err)
	}
	defer pool.Close()

	topicARNs := strings.Split(os.Getenv("MATCHER_SNS_TOPIC_ARNS"), ",")
	sqsHandler := handler.NewSQS(store.NewPostgres(pool, store.DefaultRecallLimit), topicARNs...)
	lambda.Start(func(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
		return handleBatch(ctx, event, sqsHandler), nil
	})
}
