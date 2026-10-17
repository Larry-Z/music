// Package rhythm holds the strumming / rhythm patterns served by the music site.
//
// A pattern is a step grid: Beats*Subdivision*Bars cells, one cell per
// subdivision unit. The browser plays the grid back at the requested BPM,
// so the Go side only needs to describe the grid, not schedule audio.
package rhythm

// Stroke is one cell of the step grid.
type Stroke string

const (
	// Down is a downstroke.
	Down Stroke = "D"
	// Up is an upstroke.
	Up Stroke = "U"
	// Mute is a percussive mute ("chuck"): strings are hit but choked.
	Mute Stroke = "x"
	// Rest means the hand keeps moving but does not touch the strings.
	Rest Stroke = "-"
)

// Pattern is a strumming or rhythm exercise.
type Pattern struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	NameEn     string `json:"nameEn"`
	Instrument string `json:"instrument"` // guitar | ukulele | both
	// Beats/Unit describe the time signature, e.g. 4/4 -> Beats 4, Unit 4.
	Beats int `json:"beats"`
	Unit  int `json:"unit"`
	// Subdivision is the number of grid cells per beat: 1 quarter, 2 eighth,
	// 3 triplet, 4 sixteenth.
	Subdivision int `json:"subdivision"`
	// Bars is how many bars the grid covers.
	Bars int `json:"bars"`
	// Accents marks the grid cells that should be played with an accent.
	// It always contains cell 0 (the downbeat of the first bar).
	Accents     []int    `json:"accents"`
	Difficulty  string   `json:"difficulty"`
	Description string   `json:"description"`
	Steps       []Stroke `json:"steps"`
}

// TotalSteps is the number of grid cells in the pattern.
func (p Pattern) TotalSteps() int { return p.Beats * p.Subdivision * p.Bars }

// TimeSignature renders the pattern's time signature, e.g. "4/4".
func (p Pattern) TimeSignature() string {
	return itoa(p.Beats) + "/" + itoa(p.Unit)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// cells expands the compact notation used in the table below into a grid.
//
// Each character is one cell: "D" down, "U" up, "x" mute, "-" rest.
// A space is ignored, so patterns can be grouped per beat for readability.
func cells(s string) []Stroke {
	out := make([]Stroke, 0, len(s))
	for _, r := range s {
		switch r {
		case 'D':
			out = append(out, Down)
		case 'U':
			out = append(out, Up)
		case 'x', 'X':
			out = append(out, Mute)
		case '-', '.':
			out = append(out, Rest)
		}
	}
	return out
}

var patterns = []Pattern{
	{
		ID: "quarter-down", Name: "四分音符下扫", NameEn: "Quarter Downstrokes",
		Instrument: "both", Beats: 4, Unit: 4, Subdivision: 1, Bars: 1,
		Accents: []int{0}, Difficulty: "入门",
		Description: "每拍一下下扫，先建立稳定的拍感。手腕放松，扫弦幅度均匀。",
		Steps:       cells("D D D D"),
	},
	{
		ID: "eighth-down", Name: "八分音符下扫", NameEn: "Eighth Downstrokes",
		Instrument: "both", Beats: 4, Unit: 4, Subdivision: 2, Bars: 1,
		Accents: []int{0}, Difficulty: "入门",
		Description: "八分音符全部下扫，练习手腕持续摆动不停顿。",
		Steps:       cells("DD DD DD DD"),
	},
	{
		ID: "folk-ddu-udu", Name: "民谣扫弦 下 下上 上下上", NameEn: "Folk D-DU-UDU",
		Instrument: "both", Beats: 4, Unit: 4, Subdivision: 2, Bars: 1,
		Accents: []int{0, 4}, Difficulty: "入门",
		Description: "最常用的 4/4 扫弦。空拍时手继续摆动但不触弦，第 2、4 拍为弱拍。",
		Steps:       cells("D- DU -U DU"),
	},
	{
		ID: "island-strum", Name: "尤克里里海岛扫弦", NameEn: "Island Strum",
		Instrument: "ukulele", Beats: 4, Unit: 4, Subdivision: 2, Bars: 1,
		Accents: []int{0, 4}, Difficulty: "入门",
		Description: "尤克里里经典伴奏型，节奏轻快，适合配合和弦切换练习。",
		Steps:       cells("D- DU -U DU"),
	},
	{
		ID: "sixteenth-alternate", Name: "十六分音符交替扫弦", NameEn: "Sixteenth Alternating",
		Instrument: "both", Beats: 4, Unit: 4, Subdivision: 4, Bars: 1,
		Accents: []int{0}, Difficulty: "进阶",
		Description: "十六分音符下上下上交替，先放慢到 60 BPM 练均匀，再逐步提速。",
		Steps:       cells("DUDU DUDU DUDU DUDU"),
	},
	{
		ID: "triplet-strum", Name: "三连音扫弦", NameEn: "Triplet Strum",
		Instrument: "both", Beats: 4, Unit: 4, Subdivision: 3, Bars: 1,
		Accents: []int{0}, Difficulty: "进阶",
		Description: "每拍三等分，练三连音的均匀度，常用于蓝调和民谣的律动。",
		Steps:       cells("DUD UDU DUD UDU"),
	},
	{
		ID: "mute-chunk", Name: "闷音切分节奏", NameEn: "Mute / Chuck",
		Instrument: "ukulele", Beats: 4, Unit: 4, Subdivision: 2, Bars: 1,
		Accents: []int{0}, Difficulty: "进阶",
		Description: "第 2、4 拍用右手掌根闷住琴弦打出「恰」声，制造律动切分感。",
		Steps:       cells("D- xU D- xU"),
	},
	{
		ID: "waltz-34", Name: "三拍子华尔兹", NameEn: "Waltz 3/4",
		Instrument: "both", Beats: 3, Unit: 4, Subdivision: 2, Bars: 1,
		Accents: []int{0}, Difficulty: "入门",
		Description: "3/4 拍强-弱-弱，第一拍下扫重音，后两拍轻扫。",
		Steps:       cells("D- DU DU"),
	},
	{
		ID: "six-eight-folk", Name: "6/8 民谣摇荡", NameEn: "6/8 Folk",
		Instrument: "both", Beats: 6, Unit: 8, Subdivision: 1, Bars: 1,
		Accents: []int{0, 3}, Difficulty: "进阶",
		Description: "六个八分音符，重音落在第 1 和第 4 个音上，产生摇荡感。",
		Steps:       cells("D-- DUU"),
	},
	{
		ID: "pop-16th-exercise", Name: "十六分切分加花", NameEn: "Sixteenth Syncopation",
		Instrument: "both", Beats: 4, Unit: 4, Subdivision: 4, Bars: 1,
		Accents: []int{0, 4, 8, 12}, Difficulty: "挑战",
		Description: "十六分音符切分练习，注意空拍保持手腕摆动，重音落在每拍正拍。",
		Steps:       cells("D-UD -UDU D-UD -UDU"),
	},
}

// All returns every pattern.
func All() []Pattern {
	return append([]Pattern{}, patterns...)
}

// ByID finds a pattern by its identifier.
func ByID(id string) (Pattern, bool) {
	for _, p := range patterns {
		if p.ID == id {
			return p, true
		}
	}
	return Pattern{}, false
}

// Library is the payload returned by GET /api/rhythms.
type Library struct {
	StrokeLegend []Legend  `json:"strokeLegend"`
	Patterns     []Pattern `json:"patterns"`
}

// Legend explains one stroke symbol for the UI.
type Legend struct {
	Symbol string `json:"symbol"`
	Label  string `json:"label"`
}

// NewLibrary builds the full rhythm payload.
func NewLibrary() Library {
	return Library{
		StrokeLegend: []Legend{
			{Symbol: "D", Label: "下扫"},
			{Symbol: "U", Label: "上扫"},
			{Symbol: "x", Label: "闷音"},
			{Symbol: "-", Label: "空拍（手继续摆动）"},
		},
		Patterns: All(),
	}
}
