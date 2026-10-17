package chord

import (
	"strings"
	"testing"
)

// formulas 是各和弦类型相对根音的音程（半音），用于校验指法是否真的构成该和弦。
var formulas = map[string][]int{
	"major": {0, 4, 7},
	"minor": {0, 3, 7},
	"7":     {0, 4, 7, 10},
	"maj7":  {0, 4, 7, 11},
	"m7":    {0, 3, 7, 10},
	"sus4":  {0, 5, 7},
	"6":     {0, 4, 7, 9},
	"dim":   {0, 3, 6, 9},
	"aug":   {0, 4, 8},
}

// required 是每个类型必须出现的音程：根音 + 决定和弦性质的音。
// 五音可以被省略（吉他指法常见），所以不强制。
var required = map[string][]int{
	"major": {0, 4},
	"minor": {0, 3},
	"7":     {0, 4, 10},
	"maj7":  {0, 4, 11},
	"m7":    {0, 3, 10},
	"sus4":  {0, 5},
	"6":     {0, 4, 9},
	"dim":   {0, 3, 6},
	"aug":   {0, 4, 8},
}

var pitchIndex = map[string]int{
	"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
	"F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
}

// pitchClassesOf 返回指法实际发出的音（去重，跳过不弹的弦）。
func pitchClassesOf(t *testing.T, c Chord) map[int]bool {
	t.Helper()
	open := openPitchFor(c.Instrument)
	if open == nil {
		t.Fatalf("%s: unknown instrument %q", c.Name, c.Instrument)
	}
	got := map[int]bool{}
	for i, fret := range c.Frets {
		if fret < 0 {
			continue
		}
		got[(open[i]+fret)%12] = true
	}
	return got
}

// TestVoicingsMatchChordTones 是这个库最重要的一致性检查：
// 指法发出的每个音都必须属于该和弦类型的音程集合，且必须包含根音和决定性质的音。
// 这一条能抓出「指法写错、和弦名标错」的问题（例如把 E6 标成 E）。
func TestVoicingsMatchChordTones(t *testing.T) {
	for _, c := range All() {
		allowed := formulas[c.Quality]
		if allowed == nil {
			t.Errorf("%s: unknown quality %q", c.Name, c.Quality)
			continue
		}
		root, ok := pitchIndex[c.Root]
		if !ok {
			t.Errorf("%s: unknown root %q", c.Name, c.Root)
			continue
		}

		want := map[int]bool{}
		for _, iv := range allowed {
			want[(root+iv)%12] = true
		}
		got := pitchClassesOf(t, c)

		for pc := range got {
			if !want[pc] {
				t.Errorf("%s (%s %s): sounding note %s is not in the chord (%v)",
					c.Name, c.Root, c.Quality, pitchClasses[pc], c.Notes)
			}
		}
		for _, iv := range required[c.Quality] {
			if !got[(root+iv)%12] {
				t.Errorf("%s (%s %s): missing required note %s, voicing = %v",
					c.Name, c.Root, c.Quality, pitchClasses[(root+iv)%12], c.Frets)
			}
		}
	}
}

func TestFretsAndFingersAreConsistent(t *testing.T) {
	for _, c := range All() {
		in := instrumentByKey(c.Instrument)
		if in == nil {
			t.Fatalf("%s: unknown instrument %q", c.Name, c.Instrument)
		}
		if len(c.Frets) != in.Strings || len(c.Fingers) != in.Strings {
			t.Errorf("%s: %d frets / %d fingers, want %d",
				c.Name, len(c.Frets), len(c.Fingers), in.Strings)
			continue
		}
		for i, fret := range c.Frets {
			if fret < -1 || fret > 7 {
				t.Errorf("%s string %d: fret %d out of range [-1,7]", c.Name, i, fret)
			}
			if fret > 0 && c.Fingers[i] == 0 {
				t.Errorf("%s string %d: fretted but no finger assigned", c.Name, i)
			}
			if fret <= 0 && c.Fingers[i] != 0 {
				t.Errorf("%s string %d: open/muted string must not have a finger", c.Name, i)
			}
			if c.Fingers[i] < 0 || c.Fingers[i] > 4 {
				t.Errorf("%s string %d: finger %d out of range [0,4]", c.Name, i, c.Fingers[i])
			}
		}
		if len(c.Notes) < 3 {
			t.Errorf("%s: only %d distinct notes, want at least 3", c.Name, len(c.Notes))
		}
	}
}

func instrumentByKey(key string) *Instrument {
	for i := range instruments {
		if instruments[i].Key == key {
			return &instruments[i]
		}
	}
	return nil
}

func TestBarreIsConsistent(t *testing.T) {
	for _, c := range All() {
		if c.Barre == 0 {
			continue
		}
		count := 0
		for _, fret := range c.Frets {
			if fret == c.Barre {
				count++
			}
		}
		if count < 2 {
			t.Errorf("%s: barre on fret %d but only %d string(s) use it", c.Name, c.Barre, count)
		}
	}
}

func TestBaseFret(t *testing.T) {
	cases := []struct {
		frets []int
		want  int
	}{
		{[]int{0, 0, 0, 3}, 1},        // 全部在前 5 品
		{[]int{3, 5, 5, 4, 3}, 1},     // 最高第 5 品，仍显示 1-5 品
		{[]int{-1, 4, 6, 6, 5, 4}, 4}, // 最高第 6 品，从第 4 品起显示
		{[]int{-1, -1, 0, 2, 3, 2}, 1},
	}
	for _, tc := range cases {
		if got := baseFret(tc.frets); got != tc.want {
			t.Errorf("baseFret(%v) = %d, want %d", tc.frets, got, tc.want)
		}
	}
	for _, c := range All() {
		if c.BaseFret < 1 {
			t.Errorf("%s: baseFret = %d, want >= 1", c.Name, c.BaseFret)
		}
		highest := 0
		for _, f := range c.Frets {
			if f > highest {
				highest = f
			}
		}
		if highest > 0 && highest > c.BaseFret+displayFrets-1 {
			t.Errorf("%s: highest fret %d does not fit in the window starting at %d",
				c.Name, highest, c.BaseFret)
		}
	}
}

func TestNotesStartWithRoot(t *testing.T) {
	cases := []struct {
		instrument string
		root       string
		frets      []int
		want       []string
	}{
		// 音名按弦序排列（尤克里里 G C E A，吉他 E A D G B E）。
		{InstrumentUkulele, "C", []int{0, 0, 0, 3}, []string{"C", "G", "E"}},
		{InstrumentUkulele, "A#", []int{3, 2, 1, 1}, []string{"A#", "D", "F"}},
		{InstrumentGuitar, "C", []int{-1, 3, 2, 0, 1, 0}, []string{"C", "E", "G"}},
		{InstrumentGuitar, "E", []int{0, 2, 2, 1, 0, 0}, []string{"E", "B", "G#"}},
	}
	for _, tc := range cases {
		got := Notes(tc.instrument, tc.root, tc.frets)
		if len(got) != len(tc.want) {
			t.Fatalf("Notes(%s, %s) = %v, want %v", tc.instrument, tc.root, got, tc.want)
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Errorf("Notes(%s, %s)[%d] = %q, want %q",
					tc.instrument, tc.root, i, got[i], tc.want[i])
			}
		}
	}
}

func TestChordNamesAreUniquePerInstrument(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range All() {
		key := c.Instrument + "/" + c.Name
		if seen[key] {
			t.Errorf("duplicate chord %q", key)
		}
		seen[key] = true
		if !strings.HasPrefix(c.Name, c.Root) && !strings.HasPrefix(c.Name, "Bb") {
			t.Errorf("%s: name does not start with root %s", c.Name, c.Root)
		}
	}
}

func TestBothInstrumentsAreCovered(t *testing.T) {
	counts := map[string]int{}
	for _, c := range All() {
		counts[c.Instrument]++
	}
	for _, in := range Instruments() {
		if counts[in.Key] < 20 {
			t.Errorf("%s: only %d chords, want a usable library (>= 20)", in.Key, counts[in.Key])
		}
		if len(in.Tuning) != in.Strings {
			t.Errorf("%s: tuning has %d entries, want %d", in.Key, len(in.Tuning), in.Strings)
		}
	}
	if counts[InstrumentUkulele] != len(ForInstrument(InstrumentUkulele)) {
		t.Error("ForInstrument(ukulele) disagrees with All()")
	}
	if counts[InstrumentGuitar] != len(ForInstrument(InstrumentGuitar)) {
		t.Error("ForInstrument(guitar) disagrees with All()")
	}
	if len(ForInstrument("banjo")) != 0 {
		t.Error("ForInstrument should return nothing for an unknown instrument")
	}
}

func TestNewLibrary(t *testing.T) {
	lib := NewLibrary()
	if len(lib.Chords) != len(All()) {
		t.Errorf("library has %d chords, want %d", len(lib.Chords), len(All()))
	}
	if len(lib.Instruments) != 2 {
		t.Errorf("library has %d instruments, want 2", len(lib.Instruments))
	}
	for _, q := range lib.Qualities {
		if q.Label == "" || q.Label == q.Key {
			t.Errorf("quality %q has no Chinese label", q.Key)
		}
	}
	for _, in := range lib.Instruments {
		if in.Label == "" || in.Strings == 0 {
			t.Errorf("instrument %q is missing a label or string count", in.Key)
		}
	}
	if got := InstrumentLabel(InstrumentGuitar); got != "吉他" {
		t.Errorf("InstrumentLabel(guitar) = %q", got)
	}
}
