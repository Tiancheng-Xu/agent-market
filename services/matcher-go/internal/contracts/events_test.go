package contracts

import (
	"os"
	"path/filepath"
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
