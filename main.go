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
	"bytes"
	"context"
	"crypto/sha256"
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

	chords, err := newJSONHandler(chord.NewLibrary())
	if err != nil {
		return nil, fmt.Errorf("chord library: %w", err)
	}
	rhythms, err := newJSONHandler(rhythm.NewLibrary())
	if err != nil {
		return nil, fmt.Errorf("rhythm library: %w", err)
	}
	assets, err := cacheAssets(http.FileServer(http.FS(static)), static, webDir != "")
	if err != nil {
		return nil, fmt.Errorf("static assets: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", handleHealth)
	mux.Handle("GET /api/chords", chords)
	mux.Handle("GET /api/rhythms", rhythms)
	mux.HandleFunc("/api/health", methodNotAllowed)
	mux.HandleFunc("/api/chords", methodNotAllowed)
	mux.HandleFunc("/api/rhythms", methodNotAllowed)
	mux.Handle("/", assets)

	return logRequests(mux), nil
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "GET, HEAD")
	http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": version,
	})
}

// newJSONHandler serializes immutable library data once per server instance.
func newJSONHandler(payload any) (http.Handler, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	body = append(body, '\n')
	etag := contentETag(body)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("ETag", etag)
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
	}), nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("music: encode response: %v", err)
	}
}

func contentETag(body []byte) string {
	return fmt.Sprintf(`"%x"`, sha256.Sum256(body))
}

// cacheAssets validates embedded assets by content, while disk mode always
// fetches fresh files so edits within a filesystem timestamp tick are visible.
func cacheAssets(next http.Handler, static fs.FS, dev bool) (http.Handler, error) {
	etags := map[string]string{}
	if !dev {
		if err := fs.WalkDir(static, ".", func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || (!strings.HasPrefix(path, "js/") && !strings.HasPrefix(path, "css/")) {
				return nil
			}
			body, err := fs.ReadFile(static, path)
			if err != nil {
				return err
			}
			etags["/"+path] = contentETag(body)
			return nil
		}); err != nil {
			return nil, err
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if dev || r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Cache-Control", "no-store")
		} else if etag := etags[r.URL.Path]; etag != "" {
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("ETag", etag)
		}
		next.ServeHTTP(w, r)
	}), nil
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
