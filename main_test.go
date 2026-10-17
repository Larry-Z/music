package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	h, err := newHandler("")
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}
	return h
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestHealth(t *testing.T) {
	rec := get(t, newTestHandler(t), "/api/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status field = %q, want ok", body["status"])
	}
}

func TestChordsAPI(t *testing.T) {
	rec := get(t, newTestHandler(t), "/api/chords")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Instruments []struct {
			Key     string   `json:"key"`
			Label   string   `json:"label"`
			Tuning  []string `json:"tuning"`
			Strings int      `json:"strings"`
		} `json:"instruments"`
		Chords []struct {
			Name       string   `json:"name"`
			Instrument string   `json:"instrument"`
			Frets      []int    `json:"frets"`
			BaseFret   int      `json:"baseFret"`
			Notes      []string `json:"notes"`
		} `json:"chords"`
		Qualities []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
		} `json:"qualities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Chords) == 0 {
		t.Fatal("no chords returned")
	}
	if len(body.Qualities) == 0 {
		t.Fatal("no qualities returned")
	}
	if len(body.Instruments) != 2 {
		t.Fatalf("got %d instruments, want ukulele + guitar", len(body.Instruments))
	}
	perInstrument := map[string]int{}
	for _, c := range body.Chords {
		if c.Name == "" || len(c.Notes) == 0 || c.BaseFret < 1 {
			t.Errorf("chord %q missing name, notes or baseFret", c.Name)
		}
		perInstrument[c.Instrument]++
	}
	for _, in := range body.Instruments {
		if perInstrument[in.Key] == 0 {
			t.Errorf("instrument %q has no chords", in.Key)
		}
		if len(in.Tuning) != in.Strings {
			t.Errorf("instrument %q: %d tuning entries for %d strings", in.Key, len(in.Tuning), in.Strings)
		}
		for _, c := range body.Chords {
			if c.Instrument == in.Key && len(c.Frets) != in.Strings {
				t.Errorf("%s: %d frets for a %d-string instrument", c.Name, len(c.Frets), in.Strings)
			}
		}
	}
}

func TestRhythmsAPI(t *testing.T) {
	rec := get(t, newTestHandler(t), "/api/rhythms")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Patterns []struct {
			ID    string   `json:"id"`
			Beats int      `json:"beats"`
			Unit  int      `json:"unit"`
			Steps []string `json:"steps"`
		} `json:"patterns"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Patterns) == 0 {
		t.Fatal("no patterns returned")
	}
	for _, p := range body.Patterns {
		if p.ID == "" || p.Beats == 0 || p.Unit == 0 || len(p.Steps) == 0 {
			t.Errorf("incomplete pattern %+v", p)
		}
	}
}

func TestStaticIndexIsServed(t *testing.T) {
	rec := get(t, newTestHandler(t), "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<title>") {
		t.Error("index.html body does not look like the app shell")
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store for the HTML shell", cc)
	}
}

func TestStaticAssetsAreServed(t *testing.T) {
	for _, path := range []string{"/css/style.css", "/js/main.js", "/js/tuner.js", "/js/audio.js"} {
		rec := get(t, newTestHandler(t), path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
	}
}

func TestUnknownPathIsNotFound(t *testing.T) {
	rec := get(t, newTestHandler(t), "/does-not-exist.js")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestHandlerFromDisk(t *testing.T) {
	h, err := newHandler("web")
	if err != nil {
		t.Fatalf("newHandler(web): %v", err)
	}
	if rec := get(t, h, "/"); rec.Code != http.StatusOK {
		t.Errorf("disk mode GET / = %d, want 200", rec.Code)
	}
	if rec := get(t, h, "/js/chords.js"); rec.Code != http.StatusOK {
		t.Errorf("disk mode GET /js/chords.js = %d, want 200", rec.Code)
	}
}

func TestHandlerRejectsInvalidWebDirectory(t *testing.T) {
	if _, err := newHandler(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("newHandler accepted a missing web directory")
	}

	file := filepath.Join(t.TempDir(), "web.txt")
	if err := os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	if _, err := newHandler(file); err == nil {
		t.Fatal("newHandler accepted a file as the web directory")
	}
}

func TestAPIsRejectNonGETMethods(t *testing.T) {
	h := newTestHandler(t)
	for _, path := range []string{"/api/health", "/api/chords", "/api/rhythms"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}")))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s = %d, want 405", path, rec.Code)
		}
		if allow := rec.Header().Get("Allow"); allow != "GET, HEAD" {
			t.Errorf("POST %s Allow = %q, want GET, HEAD", path, allow)
		}
	}
}
