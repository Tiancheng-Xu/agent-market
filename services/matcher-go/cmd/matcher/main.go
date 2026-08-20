package main

import (
	"encoding/json"
	"log"
	"os"

	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
)

func main() {
	event, err := contracts.DecodeMatchRequested(os.Stdin)
	if err != nil {
		log.Fatal(err)
	}

	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{
		"requestId":  event.RequestID,
		"matchJobId": event.MatchJobID,
		"status":     "accepted",
	}); err != nil {
		log.Fatal(err)
	}
}
