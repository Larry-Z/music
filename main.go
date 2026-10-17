// Command music serves the guitar / ukulele practice site.
//
// The server has two jobs:
//   - serve the static single-page app embedded from ./web
//   - expose small read-only JSON APIs with the chord and rhythm libraries
//
// All audio work (pitch detection, click synthesis, strum playback) happens in
// the browser with the Web Audio API; Go never touches audio.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"music/internal/chord"
	"music/internal/rhythm"
)

//go:embed all:web
var webFS embed.FS

// version is reported by GET /api/health; overridable at build time with
// -ldflags "-X main.version=...".
var version = "dev"

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	webDir := flag.String("web", "", "serve the frontend from this directory instead of the embedded copy (dev mode)")
	flag.Parse()

	if err := run(*addr, *webDir); err != nil {
		log.Fatalf("music: %v", err)
	}
}

func run(addr, webDir string) error {
	handler, err := newHandler(webDir)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		displayAddr := addr
		if strings.HasPrefix(displayAddr, ":") {
			displayAddr = "localhost" + displayAddr
		}
		log.Printf("music: listening on http://%s (version %s)", displayAddr, version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Print("music: shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// newHandler wires the static file server and the JSON API.
// When webDir is empty the embedded copy of ./web is used.
func newHandler(webDir string) (http.Handler, error) {
	var static fs.FS
	if webDir != "" {
		info, err := os.Stat(webDir)
		if err != nil {
			return nil, fmt.Errorf("web directory %q: %w", webDir, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("web directory %q is not a directory", webDir)
		}
		static = os.DirFS(webDir)
	} else {
		sub, err := fs.Sub(webFS, "web")
		if err != nil {
			return nil, err
		}
		static = sub
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", handleHealth)
	mux.HandleFunc("GET /api/chords", handleChords)
	mux.HandleFunc("GET /api/rhythms", handleRhythms)
	mux.HandleFunc("/api/health", methodNotAllowed)
	mux.HandleFunc("/api/chords", methodNotAllowed)
	mux.HandleFunc("/api/rhythms", methodNotAllowed)
	mux.Handle("/", noCacheHTML(http.FileServer(http.FS(static))))

	return logRequests(mux), nil
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "GET, HEAD")
	http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": version,
	})
}

func handleChords(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, chord.NewLibrary())
}

func handleRhythms(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, rhythm.NewLibrary())
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("music: encode response: %v", err)
	}
}

// noCacheHTML keeps the HTML shell out of the browser cache so that a rebuilt
// binary is picked up on reload. Static assets may still be cached.
func noCacheHTML(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the response code for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("music: %s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}
