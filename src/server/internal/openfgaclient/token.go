package openfgaclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ClientCredentials obtient un jeton OAuth2 (grant client_credentials) et
// l'ajoute aux requêtes vers OpenFGA (authn.method: oidc).
//
// Avec Username, le secret est l'app password d'un compte de service
// Authentik (champs username/password) ; sans, un client_secret standard.
type ClientCredentials struct {
	TokenURL     string
	ClientID     string
	ClientSecret string
	Username     string
	Password     string
	Scope        string

	// Transport des requêtes vers OpenFGA et vers l'émetteur.
	Base http.RoundTripper

	mu      sync.Mutex
	token   string
	expires time.Time
}

// Marge avant expiration : le jeton est renouvelé avant d'être refusé.
const refreshMargin = time.Minute

func (c *ClientCredentials) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := c.Token(req.Context())
	if err != nil {
		return nil, err
	}
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+token)
	return c.base().RoundTrip(req)
}

// Token renvoie le jeton en cache, ou en demande un nouveau.
func (c *ClientCredentials) Token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Add(refreshMargin).Before(c.expires) {
		return c.token, nil
	}

	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.ClientID}}
	if c.Username != "" {
		form.Set("username", c.Username)
		form.Set("password", c.Password)
	} else {
		form.Set("client_secret", c.ClientSecret)
	}
	if c.Scope != "" {
		form.Set("scope", c.Scope)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Transport: c.base(), Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("token request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token request: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", fmt.Errorf("token response without access_token")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 300
	}
	c.token, c.expires = out.AccessToken, time.Now().Add(time.Duration(out.ExpiresIn)*time.Second)
	return c.token, nil
}

func (c *ClientCredentials) base() http.RoundTripper {
	if c.Base != nil {
		return c.Base
	}
	return http.DefaultTransport
}
