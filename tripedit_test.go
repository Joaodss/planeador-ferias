package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestParseClockAndLabel(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]int{"00:00": 0, "9:05": 545, " 23:59 ": 1439} {
		if got, err := parseClock(in); err != nil || got != want {
			t.Errorf("parseClock(%q) = %d, %v; esperava %d", in, got, err, want)
		}
	}
	for _, in := range []string{"24:00", "12:60", "12", "12:5", "meio-dia", ""} {
		if _, err := parseClock(in); err == nil {
			t.Errorf("parseClock(%q) devia dar erro", in)
		}
	}
	for m, want := range map[int]string{0: "00:00", 570: "09:30", 1500: "01:00", -60: "23:00"} {
		if got := clockLabel(m); got != want {
			t.Errorf("clockLabel(%d) = %q, esperava %q", m, got, want)
		}
	}
}

func TestParseDateAndTripDates(t *testing.T) {
	t.Parallel()
	for _, bad := range []string{"2026-02-30", "2026-1-01", "", "amanhã"} {
		if _, ok := parseDate(bad); ok {
			t.Errorf("parseDate(%q) devia falhar", bad)
		}
	}
	got := tripDates(jsonObj{"start": "2026-02-27", "end": "2026-03-01"})
	if strings.Join(got, " ") != "2026-02-27 2026-02-28 2026-03-01" {
		t.Errorf("tripDates: %v", got)
	}
	if got := tripDates(jsonObj{"start": "x", "end": "2026-03-01"}); len(got) != 0 {
		t.Errorf("tripDates com datas inválidas: %v", got)
	}
}

func TestValidTz(t *testing.T) {
	t.Parallel()
	for tz, want := range map[string]bool{"Europe/Lisbon": true, "Asia/Tokyo": true, "UTC": true, "": false, "Local": false, "/etc/passwd": false, "Lua/Base": false} {
		if validTz(tz) != want {
			t.Errorf("validTz(%q) = %v", tz, !want)
		}
	}
}

func TestNewID(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := s.newID("a")
		if !tripIDRe.MatchString(id) || !strings.HasPrefix(id, "a") || seen[id] {
			t.Fatalf("id %q inválido ou repetido", id)
		}
		seen[id] = true
	}
	for i := 0; i < 100; i++ {
		if n := randomID4(); n < 0 || n >= idRandRange {
			t.Fatalf("randomID4 = %d", n)
		}
	}
	// com o relógio e a parte aleatória fixos, o contador separa os ids
	s.idRand = func() int64 { return 0 }
	withClock(s, time.Unix(0, 0))
	used := map[string]bool{s.newID("p"): true}
	if id := s.freshID("p", used); used[id] && len(used) != 2 {
		t.Errorf("freshID repetiu um id: %q", id)
	}
}

func TestAddPlaceColours(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	trip := jsonObj{"places": []any{}}
	for i := 0; i < 9; i++ {
		if _, err := s.addPlace(trip, "sítio "+string(rune('a'+i))); err != nil {
			t.Fatal(err)
		}
	}
	var cs []float64
	for _, p := range objs(trip, "places") {
		cs = append(cs, num(p, "c"))
	}
	// as 8 cores primeiro, depois volta ao início como addPlace em trip.js
	if want := []float64{1, 2, 3, 4, 5, 6, 7, 8, 1}; fmt.Sprint(cs) != fmt.Sprint(want) {
		t.Errorf("cores: %v, esperava %v", cs, want)
	}
	// um id que já existe é o próprio sítio; um nome novo cria-o
	id := str(objs(trip, "places")[0], "id")
	if got, _ := s.placeRef(trip, id); got != id {
		t.Errorf("placeRef pelo id: %q", got)
	}
	if _, err := s.placeRef(trip, strings.Repeat("x", maxTitleLen+1)); err == nil {
		t.Error("placeRef com um nome enorme devia dar erro")
	}
}

func TestCostCategories(t *testing.T) {
	t.Parallel()
	if got := costCatIDs(jsonObj{}); len(got) != len(defaultCostCat) {
		t.Errorf("sem costCats usam-se as por omissão: %v", got)
	}
	own := jsonObj{"costCats": []any{jsonObj{"id": "k1", "name": "Mergulho"}}}
	if got := costCatIDs(own); len(got) != 1 || got[0] != "k1" {
		t.Errorf("costCats próprias: %v", got)
	}
	s := newTestServer(t)
	b := jsonObj{}
	cat := "alojamento"
	if err := s.applyActivity(own, b, activityIn{CostCategory: &cat}); err == nil {
		t.Error("uma categoria que a viagem já não tem devia dar erro")
	}
	cat = "k1"
	if err := s.applyActivity(own, b, activityIn{CostCategory: &cat}); err != nil || b["ccat"] != "k1" {
		t.Errorf("categoria própria: %v %v", err, b)
	}
	empty := ""
	if err := s.applyActivity(own, b, activityIn{CostCategory: &empty, TZ: &empty, Place: &empty}); err != nil || b["ccat"] != nil {
		t.Errorf("categoria vazia tira o campo: %v %v", err, b)
	}
}

func TestBlockViewAfterMidnight(t *testing.T) {
	t.Parallel()
	// a página guarda start acima de 1440 quando o quadro passa da meia-noite
	v := blockView(jsonObj{}, jsonObj{"id": "a", "title": "Festa", "date": "2026-11-01", "start": float64(1500), "len": float64(120), "cat": "party", "place": "p0"})
	if v["start"] != "01:00" || v["start_date"] != "2026-11-02" || v["end_date"] != "2026-11-02" || v["end"] != "03:00" {
		t.Errorf("blockView depois da meia-noite: %v", v)
	}
	if p := v["place"].(jsonObj); p["name"] != "" {
		t.Errorf("um sítio que não existe fica sem nome: %v", p)
	}
}
