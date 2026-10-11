package occdev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"syscall"
	"time"
)

// routingManifestRetry bounds the retries of a routing controller manifest
// download from GitHub releases.
type routingManifestRetry struct {
	attempts       int
	firstDelay     time.Duration
	maxDelay       time.Duration
	budget         time.Duration
	attemptTimeout time.Duration
}

// The same rule as scripts/ci/routing.mjs (fetchPinnedBytes) and
// scripts/ci/download-pinned.sh: eight attempts, backoff doubling from 2 s to a
// 20 s cap, and no retry starts more than 120 s after the first attempt.
var developmentRoutingManifestRetry = routingManifestRetry{
	attempts:       8,
	firstDelay:     2 * time.Second,
	maxDelay:       20 * time.Second,
	budget:         120 * time.Second,
	attemptTimeout: 60 * time.Second,
}

const developmentRoutingManifestLimit = 32 * 1024 * 1024

// downloadDevelopmentRoutingManifest fetches a pinned manifest and verifies its
// checksum. Transient failures (a timed-out, reset or refused connection, a cut
// transfer, HTTP 408, 429 or 5xx) are retried; any other status, an oversized
// body and a checksum mismatch fail at once.
func downloadDevelopmentRoutingManifest(
	ctx context.Context,
	log io.Writer,
	url, expected string,
	policy routingManifestRetry,
) ([]byte, error) {
	client := &http.Client{}
	started := time.Now()
	delay := min(policy.firstDelay, policy.maxDelay)
	for attempt := 1; ; attempt++ {
		data, transient, err := fetchDevelopmentRoutingManifest(ctx, client, url, policy.attemptTimeout)
		if err == nil {
			digest := sha256.Sum256(data)
			if hex.EncodeToString(digest[:]) != expected {
				return nil, fmt.Errorf("routing controller manifest checksum does not match the pinned version")
			}
			return data, nil
		}
		if !transient || attempt >= policy.attempts || time.Since(started)+delay > policy.budget {
			return nil, fmt.Errorf("%w (after %d attempt(s))", err, attempt)
		}
		fmt.Fprintf(log, "%v; retrying in %s (attempt %d/%d)\n", err, delay, attempt+1, policy.attempts)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("download routing controller manifest: %w (after %d attempt(s), last error: %v)", context.Cause(ctx), attempt, err)
		case <-timer.C:
		}
		delay = min(delay*2, policy.maxDelay)
	}
}

func fetchDevelopmentRoutingManifest(
	ctx context.Context,
	client *http.Client,
	url string,
	timeout time.Duration,
) (data []byte, transient bool, err error) {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, transientRoutingManifestError(ctx, err), fmt.Errorf("download routing controller manifest: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		status := response.StatusCode
		transient := status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500 && status <= 599
		return nil, transient, fmt.Errorf("download routing controller manifest: HTTP %d", status)
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, developmentRoutingManifestLimit+1))
	if err != nil {
		return nil, transientRoutingManifestError(ctx, err), fmt.Errorf("read routing controller manifest: %w", err)
	}
	if len(data) > developmentRoutingManifestLimit {
		return nil, false, fmt.Errorf("routing controller manifest exceeds its size limit")
	}
	return data, false, nil
}

// A failure of one attempt that another attempt may not repeat: its own
// timeout, a network timeout, a DNS failure, a refused or reset connection, or
// a transfer cut short. The caller's cancellation or deadline is never retried,
// nor are TLS certificate errors or malformed URLs.
func transientRoutingManifestError(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	for _, errno := range []syscall.Errno{
		syscall.ECONNREFUSED,
		syscall.ECONNRESET,
		syscall.EPIPE,
		syscall.ETIMEDOUT,
		syscall.ENETUNREACH,
		syscall.EHOSTUNREACH,
	} {
		if errors.Is(err, errno) {
			return true
		}
	}
	return false
}
