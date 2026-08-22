package integrationguard

import "regexp"

const (
	DatabasePrefix  = "agent_market_matcher_test_"
	HarnessVersion  = "matcher-go-postgres-harness-v1"
	AdvisoryLockKey = int64(0x4d415443484552)
)

var databaseNamePattern = regexp.MustCompile(`^agent_market_matcher_test_[0-9a-f]{32}$`)

func ValidDatabaseName(name string) bool {
	return databaseNamePattern.MatchString(name)
}
