// Package chord holds the chord library served by the music site.
//
// 支持尤克里里（标准 re-entrant 调弦 G4-C4-E4-A4）与吉他（标准调弦
// E2-A2-D3-G3-B3-E4）。Frets 与 Fingers 按「最粗的弦在前」排列：
// 尤克里里是 4→1 弦，吉他是 6→1 弦。品位取值 -1 表示不弹该弦，
// 0 表示空弦，n 表示按第 n 品（绝对品位，BaseFret 用于高把位指法图）。
package chord

// Instrument keys.
const (
	InstrumentUkulele = "ukulele"
	InstrumentGuitar  = "guitar"
)

// displayFrets 是指法图一次显示的品位格数。
const displayFrets = 5

// pitchClasses is the chromatic scale starting from C.
var pitchClasses = [12]string{"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"}

// Instrument describes a fretted instrument's tuning.
type Instrument struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Tuning  []string `json:"tuning"`
	Strings int      `json:"strings"`
	// OpenMIDI contains open-string MIDI pitches in physical string order.
	OpenMIDI []int `json:"openMidi"`
}

var instruments = []Instrument{
	{
		Key: InstrumentUkulele, Label: "尤克里里",
		Tuning: []string{"G4", "C4", "E4", "A4"}, Strings: 4,
		OpenMIDI: []int{67, 60, 64, 69},
	},
	{
		Key: InstrumentGuitar, Label: "吉他",
		Tuning: []string{"E2", "A2", "D3", "G3", "B3", "E4"}, Strings: 6,
		OpenMIDI: []int{40, 45, 50, 55, 59, 64},
	},
}

// Chord is a named chord together with its default voicing.
type Chord struct {
	Name       string   `json:"name"`
	Instrument string   `json:"instrument"`
	Root       string   `json:"root"`
	Quality    string   `json:"quality"`
	Frets      []int    `json:"frets"`
	Fingers    []int    `json:"fingers"`
	Barre      int      `json:"barre"`
	BaseFret   int      `json:"baseFret"`
	Notes      []string `json:"notes"`
}

// definition is the hand-authored part of a chord; Notes and BaseFret are derived.
type definition struct {
	name    string
	root    string
	quality string
	frets   []int
	fingers []int
	barre   int
}

// qualities lists the chord qualities in the order used by the UI filter.
var qualities = []string{"major", "minor", "7", "maj7", "m7", "sus4", "6", "dim", "aug"}

// QualityLabel returns the Chinese label for a chord quality.
func QualityLabel(q string) string {
	switch q {
	case "major":
		return "大三和弦"
	case "minor":
		return "小三和弦"
	case "7":
		return "属七和弦"
	case "maj7":
		return "大七和弦"
	case "m7":
		return "小七和弦"
	case "sus4":
		return "挂四和弦"
	case "6":
		return "六和弦"
	case "dim":
		return "减和弦"
	case "aug":
		return "增和弦"
	default:
		return q
	}
}

// InstrumentLabel returns the Chinese label for an instrument key.
func InstrumentLabel(key string) string {
	for _, in := range instruments {
		if in.Key == key {
			return in.Label
		}
	}
	return key
}

// openPitchFor returns the open-string pitch classes for an instrument key.
func openPitchFor(key string) []int {
	for _, in := range instruments {
		if in.Key == key {
			out := make([]int, len(in.OpenMIDI))
			for i, midi := range in.OpenMIDI {
				out[i] = midi % 12
			}
			return out
		}
	}
	return nil
}

// Notes returns the distinct pitch classes produced by the frets, root first.
func Notes(instrument, root string, frets []int) []string {
	open := openPitchFor(instrument)
	seen := map[string]bool{}
	var others []string
	var rootNote string
	for i, f := range frets {
		if f < 0 || i >= len(open) {
			continue
		}
		name := pitchClasses[(open[i]+f)%12]
		if seen[name] {
			continue
		}
		seen[name] = true
		if name == root {
			rootNote = name
			continue
		}
		others = append(others, name)
	}
	if rootNote == "" {
		rootNote = root
	}
	return append([]string{rootNote}, others...)
}

// baseFret returns 1 when the voicing fits inside the first displayFrets frets,
// otherwise the lowest fretted fret so the diagram can be shifted up the neck.
func baseFret(frets []int) int {
	lowest, highest := 0, 0
	for _, f := range frets {
		if f <= 0 {
			continue
		}
		if lowest == 0 || f < lowest {
			lowest = f
		}
		if f > highest {
			highest = f
		}
	}
	if highest <= displayFrets {
		return 1
	}
	return lowest
}

func build(instrument string, defs []definition) []Chord {
	out := make([]Chord, 0, len(defs))
	for _, d := range defs {
		out = append(out, Chord{
			Name:       d.name,
			Instrument: instrument,
			Root:       d.root,
			Quality:    d.quality,
			Frets:      d.frets,
			Fingers:    d.fingers,
			Barre:      d.barre,
			BaseFret:   baseFret(d.frets),
			Notes:      Notes(instrument, d.root, d.frets),
		})
	}
	return out
}

// All returns the whole chord library: ukulele first, then guitar, each
// grouped by root as declared in the tables.
func All() []Chord {
	out := build(InstrumentUkulele, ukuleleChords)
	return append(out, build(InstrumentGuitar, guitarChords)...)
}

// ForInstrument returns the chords of a single instrument.
func ForInstrument(key string) []Chord {
	switch key {
	case InstrumentGuitar:
		return build(InstrumentGuitar, guitarChords)
	case InstrumentUkulele:
		return build(InstrumentUkulele, ukuleleChords)
	default:
		return nil
	}
}

// Instruments returns the instrument list in UI display order.
func Instruments() []Instrument {
	return append([]Instrument{}, instruments...)
}

// Qualities returns the chord qualities in UI display order.
func Qualities() []string {
	return append([]string{}, qualities...)
}

// Library is the payload returned by GET /api/chords.
type Library struct {
	Instruments []Instrument  `json:"instruments"`
	Qualities   []QualityInfo `json:"qualities"`
	Chords      []Chord       `json:"chords"`
}

// QualityInfo pairs a quality key with its Chinese label.
type QualityInfo struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// NewLibrary builds the full chord payload.
func NewLibrary() Library {
	qs := make([]QualityInfo, 0, len(qualities))
	for _, q := range qualities {
		qs = append(qs, QualityInfo{Key: q, Label: QualityLabel(q)})
	}
	return Library{
		Instruments: Instruments(),
		Qualities:   qs,
		Chords:      All(),
	}
}
