package contracts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecodeMatchRequestedAcceptsCanonicalFixture(t *testing.T) {
	path := filepath.Join("..", "..", "testdata", "match-requested.v1.json")
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	event, err := DecodeMatchRequested(file)
	if err != nil {
		t.Fatal(err)
	}
	if event.Type != MatchRequestedV1Type {
		t.Fatalf("type = %q, want %q", event.Type, MatchRequestedV1Type)
	}
	if event.RequestID == "" || event.MatchJobID == "" || event.TaskID == "" {
		t.Fatal("canonical identifiers must be present")
	}
}

func TestDecodeMatchRequestedRejectsInvalidIdentifierUUIDs(t *testing.T) {
	valid := `{"eventId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a211","type":"match.requested.v1","occurredAt":"2026-08-20T12:00:00Z","requestId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a212","matchJobId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a213","taskId":"018f3f50-7b2d-7cc1-98f5-9ab68e75a214","modelVersion":"baseline-v1"}`
	for _, field := range []string{"eventId", "requestId", "matchJobId", "taskId"} {
		invalid := strings.Replace(valid, `"`+field+`":"018f3f50-7b2d-7cc1-98f5-9ab68e75a21`, `"`+field+`":"not-a-uuid`, 1)
		if _, err := DecodeMatchRequested(strings.NewReader(invalid)); err == nil {
			t.Fatalf("expected invalid %s UUID to be rejected", field)
		}
	}
}

func TestDecodeMatchRequestedRejectsUnknownFields(t *testing.T) {
	path := filepath.Join("..", "..", "testdata", "match-requested-unknown.json")
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	if _, err := DecodeMatchRequested(file); err == nil {
		t.Fatal("expected unknown field to be rejected")
	}
}
