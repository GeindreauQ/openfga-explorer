package ratelimit

import (
	"testing"
	"time"
)

func TestRateLimiterAllow(t *testing.T) {
	rl := New(5, 10*time.Minute)
	rl.Stop()

	for i := 0; i < 5; i++ {
		if !rl.Allow("1.2.3.4") {
			t.Fatalf("Allow #%d should succeed (within burst)", i+1)
		}
	}

	if rl.Allow("1.2.3.4") {
		t.Error("6th request should be blocked (burst exhausted)")
	}

	if !rl.Allow("5.6.7.8") {
		t.Error("Allow for a different IP should succeed")
	}
}

func TestRateLimiterRefill(t *testing.T) {
	rl := New(60, 10*time.Minute)
	rl.Stop()

	for i := 0; i < 60; i++ {
		rl.Allow("9.9.9.9")
	}
	if rl.Allow("9.9.9.9") {
		t.Fatal("burst should be exhausted after 60 requests")
	}

	time.Sleep(1100 * time.Millisecond)

	if !rl.Allow("9.9.9.9") {
		t.Error("Allow should succeed after refill (~1 token / sec)")
	}
}
