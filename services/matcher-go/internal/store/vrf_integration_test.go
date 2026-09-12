package store

import (
	"context"
	"encoding/json"
	"github.com/Tiancheng-Xu/agent-market/services/matcher-go/internal/contracts"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/url"
	"os"
	"testing"
)

// Invoked by the TE integration test against its uniquely owned local database.
// Runs the real Go entrypoint and emits the real decision for assertions by TE.
func TestVrfCrossProcess(t *testing.T) {
	raw := os.Getenv("VRF_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("VRF_TEST_DATABASE_URL required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() != "127.0.0.1" || u.Port() != "55439" || u.Path != "/am_vrf_w6_test" {
		t.Fatal("UNSAFE_TEST_DATABASE")
	}
	pool, err := pgxpool.New(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var event contracts.MatchRequestedV1
	if err = json.Unmarshal([]byte(os.Getenv("VRF_TEST_EVENT")), &event); err != nil {
		t.Fatal(err)
	}
	result, err := NewPostgres(pool, DefaultRecallLimit).Process(context.Background(), event)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	t.Log("VRF_RESULT=" + string(data))
}
