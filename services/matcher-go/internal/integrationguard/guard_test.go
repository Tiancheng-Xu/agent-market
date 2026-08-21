package integrationguard

import "testing"

func TestValidDatabaseNameRequiresRandomHexSuffix(t *testing.T) {
	valid := DatabasePrefix + "0123456789abcdef0123456789abcdef"
	if !ValidDatabaseName(valid) {
		t.Fatalf("expected %q to be valid", valid)
	}
	for _, invalid := range []string{
		DatabasePrefix,
		DatabasePrefix + "production",
		DatabasePrefix + "0123456789abcdef",
		"other_0123456789abcdef0123456789abcdef",
	} {
		if ValidDatabaseName(invalid) {
			t.Fatalf("expected %q to be invalid", invalid)
		}
	}
}
