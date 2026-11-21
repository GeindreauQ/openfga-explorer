package openfgaclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientCredentials(t *testing.T) {
	var issued int
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "openfga" ||
			r.Form.Get("username") != "openfga-explorer" || r.Form.Get("password") != "app-password" {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		issued++
		_, _ = w.Write([]byte(`{"access_token":"jwt","expires_in":1800}`))
	}))
	defer issuer.Close()

	var got string
	api := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
	}))
	defer api.Close()

	creds := &ClientCredentials{TokenURL: issuer.URL, ClientID: "openfga", Username: "openfga-explorer", Password: "app-password"}
	client := &http.Client{Transport: creds}
	for range 3 {
		resp, err := client.Get(api.URL)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	if got != "Bearer jwt" || issued != 1 {
		t.Fatalf("header %q, %d tokens issued", got, issued)
	}

	creds = &ClientCredentials{TokenURL: issuer.URL, ClientID: "openfga", Username: "openfga-explorer", Password: "wrong"}
	if _, err := creds.Token(context.Background()); err == nil {
		t.Fatal("expected an error")
	}
}
