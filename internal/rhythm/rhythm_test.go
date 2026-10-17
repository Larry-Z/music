package rhythm

import "testing"

var validStrokes = map[Stroke]bool{Down: true, Up: true, Mute: true, Rest: true}

func TestPatternGridMatchesTimeSignature(t *testing.T) {
	for _, p := range All() {
		if p.Bars < 1 {
			t.Errorf("%s: bars = %d, want >= 1", p.ID, p.Bars)
		}
		if p.Subdivision < 1 || p.Subdivision > 4 {
			t.Errorf("%s: subdivision = %d, want 1..4", p.ID, p.Subdivision)
		}
		want := p.Beats * p.Subdivision * p.Bars
		if len(p.Steps) != want {
			t.Errorf("%s: %d steps, want %d (%d/%d sub=%d bars=%d)",
				p.ID, len(p.Steps), want, p.Beats, p.Unit, p.Subdivision, p.Bars)
		}
		if got := p.TotalSteps(); got != want {
			t.Errorf("%s: TotalSteps() = %d, want %d", p.ID, got, want)
		}
	}
}

func TestPatternStrokesAreKnown(t *testing.T) {
	for _, p := range All() {
		for i, s := range p.Steps {
			if !validStrokes[s] {
				t.Errorf("%s step %d: unknown stroke %q", p.ID, i, s)
			}
		}
	}
}

func TestAccentsAreValid(t *testing.T) {
	for _, p := range All() {
		if len(p.Accents) == 0 {
			t.Errorf("%s: no accents defined", p.ID)
			continue
		}
		if p.Accents[0] != 0 {
			t.Errorf("%s: first accent should be the downbeat, got %d", p.ID, p.Accents[0])
		}
		for _, a := range p.Accents {
			if a < 0 || a >= len(p.Steps) {
				t.Errorf("%s: accent %d out of range", p.ID, a)
			}
		}
	}
}

func TestPatternsHaveCopy(t *testing.T) {
	for _, p := range All() {
		if p.Name == "" || p.Description == "" || p.Difficulty == "" {
			t.Errorf("%s: missing name, description or difficulty", p.ID)
		}
		if p.Instrument != "guitar" && p.Instrument != "ukulele" && p.Instrument != "both" {
			t.Errorf("%s: unknown instrument %q", p.ID, p.Instrument)
		}
	}
}

func TestIDsAreUniqueAndLookupWorks(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range All() {
		if seen[p.ID] {
			t.Errorf("duplicate pattern id %q", p.ID)
		}
		seen[p.ID] = true
		if got, ok := ByID(p.ID); !ok || got.ID != p.ID {
			t.Errorf("ByID(%q) failed", p.ID)
		}
	}
	if _, ok := ByID("does-not-exist"); ok {
		t.Error("ByID returned ok for an unknown id")
	}
}

func TestCellsParsing(t *testing.T) {
	cases := []struct {
		in   string
		want []Stroke
	}{
		{"D- DU", []Stroke{Down, Rest, Down, Up}},
		{"Dx", []Stroke{Down, Mute}},
		{"D.U", []Stroke{Down, Rest, Up}},
	}
	for _, tc := range cases {
		got := cells(tc.in)
		if len(got) != len(tc.want) {
			t.Fatalf("cells(%q) = %v, want %v", tc.in, got, tc.want)
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Errorf("cells(%q)[%d] = %q, want %q", tc.in, i, got[i], tc.want[i])
			}
		}
	}
}

func TestNewLibrary(t *testing.T) {
	lib := NewLibrary()
	if len(lib.Patterns) != len(All()) {
		t.Errorf("library has %d patterns, want %d", len(lib.Patterns), len(All()))
	}
	if len(lib.StrokeLegend) != 4 {
		t.Errorf("legend has %d entries, want 4", len(lib.StrokeLegend))
	}
}

func TestPatternCopyMatchesPlaybackData(t *testing.T) {
	mute, ok := ByID("mute-chunk")
	if !ok {
		t.Fatal("mute-chunk pattern is missing")
	}
	for i, step := range mute.Steps {
		wantMute := i == 2 || i == 6
		if (step == Mute) != wantMute {
			t.Errorf("mute-chunk step %d = %q, want mutes on beats 2 and 4", i, step)
		}
	}

	pop, ok := ByID("pop-16th-exercise")
	if !ok {
		t.Fatal("pop-16th-exercise pattern is missing")
	}
	wantAccents := []int{0, 4, 8, 12}
	if len(pop.Accents) != len(wantAccents) {
		t.Fatalf("pop accents = %v, want %v", pop.Accents, wantAccents)
	}
	for i := range wantAccents {
		if pop.Accents[i] != wantAccents[i] {
			t.Errorf("pop accent %d = %d, want %d", i, pop.Accents[i], wantAccents[i])
		}
	}
}
