package main

// Regras das alterações feitas pela IA (ferramentas em mcptools.go).
//
// O servidor continua a não conhecer o esquema da viagem para o resto: guarda o JSON da página tal e qual.
// Aqui fica só o que é preciso para a IA editar sem escrever nada que a página tenha de reparar: cada regra
// diz a função de clean.js, trip.js ou tripform.js que espelha. Se uma delas mudar, esta tem de mudar também
// (tests/mcp.test.mjs passa as viagens escritas pelos testes daqui pelo cleanTrip da página).
//
// A viagem é um map[string]any, para os campos que este código não conhece passarem intactos.
// Os números do JSON chegam como float64.

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // a imagem FROM scratch não tem a base de dados dos fusos: validar o tz das atividades e das viagens
)

type jsonObj = map[string]any

// Limites dos campos escritos pela IA. A página aceita mais (só o tamanho total da viagem conta), mas um texto
// enorme vindo de um modelo é quase sempre um engano, e assim uma viagem não chega a maxTripBytes por acidente.
const (
	maxTitleLen   = 200          // título de uma atividade, nome de uma viagem, de um sítio ou de um custo
	maxTextLen    = 4000         // notas, morada, link e referência
	maxActivities = 200          // atividades num só add_activities
	maxTripDays   = 60           // MAX_DAYS (tripform.js)
	maxDayPlaces  = 12           // MAX_DAY_PLACES (clean.js)
	minBlockLen   = 15           // cleanBlock: uma atividade dura pelo menos 15 minutos
	maxBlockLen   = 14 * 24 * 60 // duas semanas: mais do que isso é um engano (a página não tem limite)
	maxPlaceColor = 8            // as cores dos sítios vão de 1 a 8 (--p1 … --p8)
	maxPeople     = 1000
)

var (
	kinds          = []string{"tour", "party", "transport", "food", "rest", "sleep"} // KINDS (clean.js)
	statuses       = []string{"ideia", "reservar", "reservado", "pago"}              // STATUSES (clean.js)
	defaultCostCat = []string{"alojamento", "transporte", "alimentacao", "atividades", "festas", "compras", "outros"}
	isoDateRe      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	clockRe        = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)
	badCurrencyRe  = regexp.MustCompile("[<>&\"'`]")      // os mesmos caracteres que cleanTrip recusa na moeda
	linkRe         = regexp.MustCompile(`(?i)^https?://`) // o editor só abre links destes (editor.js)
)

/* ---------- valores ---------- */

func str(m jsonObj, k string) string { v, _ := m[k].(string); return v }

func num(m jsonObj, k string) float64 { v, _ := m[k].(float64); return v }

// objs devolve os objetos da lista m[k], como list() em clean.js (o que não é objeto fica de fora).
func objs(m jsonObj, k string) []jsonObj {
	a, _ := m[k].([]any)
	out := make([]jsonObj, 0, len(a))
	for _, v := range a {
		if o, ok := v.(jsonObj); ok {
			out = append(out, o)
		}
	}
	return out
}

func setObjs(m jsonObj, k string, list []jsonObj) {
	a := make([]any, len(list))
	for i, o := range list {
		a[i] = o
	}
	m[k] = a
}

// parseDate lê "AAAA-MM-DD" (ISO em clean.js) e confirma que é uma data que existe.
func parseDate(s string) (time.Time, bool) {
	if !isoDateRe.MatchString(s) {
		return time.Time{}, false
	}
	d, err := time.Parse(time.DateOnly, s)
	return d, err == nil
}

// tripDates: os dias da viagem, de start a end (tripDates em span.js).
func tripDates(t jsonObj) []string {
	a, ok1 := parseDate(str(t, "start"))
	b, ok2 := parseDate(str(t, "end"))
	var out []string
	for d := a; ok1 && ok2 && !d.After(b) && len(out) < maxTripDays*2; d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format(time.DateOnly))
	}
	return out
}

// parseClock lê "HH:MM" e devolve os minutos desde a meia-noite (0 a 1439).
func parseClock(s string) (int, error) {
	m := clockRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, &toolError{fmt.Sprintf("hora %q inválida: usa HH:MM", s)}
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	if h > 23 || mi > 59 {
		return 0, &toolError{fmt.Sprintf("hora %q inválida: de 00:00 a 23:59", s)}
	}
	return h*60 + mi, nil
}

// clockLabel escreve minutos como "HH:MM" (clockLabel em util.js): 1500 é "01:00" do dia seguinte.
func clockLabel(min int) string {
	m := ((min % 1440) + 1440) % 1440
	return fmt.Sprintf("%02d:%02d", m/60, m%60)
}

// validTz diz se tz é um fuso IANA que o Go conhece (TZ.valid em tz.js usa o do browser).
func validTz(tz string) bool {
	if tz == "" || tz == "Local" || strings.HasPrefix(tz, "/") {
		return false
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

// text confirma um texto livre: sem caracteres de controlo (exceto mudança de linha e tabulação) e até limit caracteres.
func text(field, v string, limit int) (string, error) {
	if len([]rune(v)) > limit {
		return "", &toolError{fmt.Sprintf("%s demasiado longo (máximo %d caracteres)", field, limit)}
	}
	if strings.ContainsFunc(v, func(r rune) bool { return r < 0x20 && r != '\n' && r != '\t' }) {
		return "", &toolError{field + " tem caracteres de controlo"}
	}
	return v, nil
}

/* ---------- identificadores ---------- */

// idRandRange: a parte aleatória de um id tem 4 caracteres em base 36.
const idRandRange = 36 * 36 * 36 * 36

// randomID4 é o s.idRand de newServer: um número aleatório de 0 a idRandRange-1.
func randomID4() int64 {
	n, _ := rand.Int(rand.Reader, big.NewInt(idRandRange))
	return n.Int64()
}

// newID cria um id no formato de newId (util.js): prefixo, data, contador e 4 caracteres aleatórios.
// O contador separa os ids criados no mesmo milissegundo. Cumpre tripIDRe, por isso também serve para viagens.
func (s *server) newID(prefix string) string {
	r := strconv.FormatInt(s.idRand()+idRandRange, 36)[1:] // sempre 4 caracteres
	return prefix + strconv.FormatInt(s.now().UnixMilli(), 36) + strconv.FormatUint(s.idSeq.Add(1)-1, 36) + r
}

/* ---------- o que a IA não pode mudar ---------- */

// checkWritable recusa as viagens só de leitura e as arquivadas: aí só o utilizador, na página, muda alguma coisa.
func checkWritable(t jsonObj) error {
	if t["archived"] == true {
		return &toolError{"a viagem está arquivada: só o utilizador a pode desarquivar e mudar, na página"}
	}
	if t["readOnly"] == true {
		return &toolError{"a viagem está só de leitura: só o utilizador a pode desbloquear, na página"}
	}
	return nil
}

// blockProtected: uma atividade fixa (locked), reservada ou paga já é um compromisso do utilizador.
func blockProtected(b jsonObj) string {
	switch {
	case b["locked"] == true:
		return "está fixa (locked)"
	case str(b, "status") == "reservado":
		return "já está reservada"
	case str(b, "status") == "pago":
		return "já está paga"
	}
	return ""
}

func checkBlockEditable(b jsonObj) error {
	if why := blockProtected(b); why != "" {
		return &toolError{fmt.Sprintf("a atividade %s (%q) %s: só o utilizador a pode mudar", str(b, "id"), str(b, "title"), why)}
	}
	return nil
}

func checkCostEditable(c jsonObj) error {
	if c["paid"] == true {
		return &toolError{fmt.Sprintf("o custo %s (%q) já está pago: só o utilizador o pode mudar", str(c, "id"), str(c, "label"))}
	}
	return nil
}

/* ---------- atividades ---------- */

// findBlock procura a atividade id no quadro (blocks) e em "por agendar" (tray), como findBlock em trip.js.
func findBlock(t jsonObj, id string) (b jsonObj, inTray bool) {
	for _, k := range []string{"blocks", "tray"} {
		for _, o := range objs(t, k) {
			if str(o, "id") == id {
				return o, k == "tray"
			}
		}
	}
	return nil, false
}

func mustBlock(t jsonObj, id string) (jsonObj, bool, error) {
	b, inTray := findBlock(t, id)
	if b == nil {
		return nil, false, &toolError{fmt.Sprintf("a atividade %s não existe nesta viagem", id)}
	}
	return b, inTray, nil
}

// usedIDs: todos os ids de uma lista da viagem, para um id novo não repetir nenhum (uid em clean.js).
func usedIDs(t jsonObj, keys ...string) map[string]bool {
	u := map[string]bool{}
	for _, k := range keys {
		for _, o := range objs(t, k) {
			u[str(o, "id")] = true
		}
	}
	return u
}

func (s *server) freshID(prefix string, used map[string]bool) string {
	id := s.newID(prefix)
	for used[id] {
		id = s.newID(prefix)
	}
	used[id] = true
	return id
}

// activityIn: os campos de uma atividade que a IA pode escrever. Um campo que não vem fica como está;
// texto vazio ou 0 tiram o campo (sem custo, sem sítio, sem nota…).
type activityIn struct {
	Title        *string  `json:"title"`
	Date         *string  `json:"date"`
	Start        *string  `json:"start"`
	Duration     *int     `json:"duration"`
	Kind         *string  `json:"kind"`
	Status       *string  `json:"status"`
	Place        *string  `json:"place"`
	CostPP       *float64 `json:"cost_pp"`
	CostTotal    *float64 `json:"cost_total"`
	CostCategory *string  `json:"cost_category"`
	TZ           *string  `json:"tz"`
	Address      *string  `json:"address"`
	Link         *string  `json:"link"`
	Ref          *string  `json:"ref"`
	Note         *string  `json:"note"`
	Weekdays     *[]int   `json:"weekdays"`
}

// costCatIDs: as categorias de custo da viagem, ou as por omissão quando ainda não tem as suas (costCats em costs.js).
func costCatIDs(t jsonObj) []string {
	if _, ok := t["costCats"]; !ok {
		return defaultCostCat
	}
	var ids []string
	for _, c := range objs(t, "costCats") {
		ids = append(ids, str(c, "id"))
	}
	return ids
}

// placeRef devolve o id do sítio ref (um id ou um nome). Um nome que ainda não existe cria o sítio, como addPlace.
func (s *server) placeRef(t jsonObj, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	for _, p := range objs(t, "places") {
		if str(p, "id") == ref {
			return ref, nil
		}
	}
	p, err := s.addPlace(t, ref)
	if err != nil {
		return "", err
	}
	return str(p, "id"), nil
}

// addPlace junta o sítio name (ou devolve o que já tem esse nome, sem olhar a maiúsculas) com a primeira cor livre.
// Espelha addPlace (trip.js).
func (s *server) addPlace(t jsonObj, name string) (jsonObj, error) {
	name, err := text("o nome do sítio", strings.TrimSpace(name), maxTitleLen)
	if err != nil {
		return nil, err
	}
	if name == "" {
		return nil, &toolError{"o nome do sítio está vazio"}
	}
	places := objs(t, "places")
	for _, p := range places {
		if strings.EqualFold(str(p, "name"), name) {
			return p, nil
		}
	}
	used := map[int]bool{}
	for _, p := range places {
		used[int(num(p, "c"))] = true
	}
	c := 1
	for used[c] && c < maxPlaceColor {
		c++
	}
	if used[c] {
		c = len(places)%maxPlaceColor + 1
	}
	p := jsonObj{"id": s.freshID("p", usedIDs(t, "places")), "name": name, "c": float64(c)}
	setObjs(t, "places", append(places, p))
	t["ai"] = s.aiStamp()
	return p, nil
}

// aiStamp: a marca das alterações da IA (o campo ai), a data e hora da alteração. A página mostra-a até o
// utilizador a dar como vista.
func (s *server) aiStamp() string { return s.now().UTC().Format(time.RFC3339) }

// applyActivity escreve em b os campos de in, com as regras de cleanBlock (clean.js). Não mexe em date e start:
// isso é com placeBlock, porque decide entre o quadro e "por agendar".
func (s *server) applyActivity(t, b jsonObj, in activityIn) error {
	setText := func(k, field string, v *string, max int) error {
		if v == nil {
			return nil
		}
		x, err := text(field, strings.TrimSpace(*v), max)
		if err != nil {
			return err
		}
		if x == "" {
			delete(b, k)
		} else {
			b[k] = x
		}
		return nil
	}
	if in.Title != nil {
		x, err := text("o título", strings.TrimSpace(*in.Title), maxTitleLen)
		if err != nil {
			return err
		}
		if x == "" {
			return &toolError{"o título da atividade está vazio"}
		}
		b["title"] = x
	}
	if in.Duration != nil {
		if *in.Duration < minBlockLen || *in.Duration > maxBlockLen {
			return &toolError{fmt.Sprintf("duração de %d minutos: tem de ser de %d a %d", *in.Duration, minBlockLen, maxBlockLen)}
		}
		b["len"] = float64(*in.Duration)
	}
	if in.Kind != nil {
		if !slices.Contains(kinds, *in.Kind) {
			return &toolError{fmt.Sprintf("kind %q desconhecido: usa %s", *in.Kind, strings.Join(kinds, ", "))}
		}
		b["cat"] = *in.Kind
	}
	if in.Status != nil {
		if !slices.Contains(statuses, *in.Status) {
			return &toolError{fmt.Sprintf("status %q desconhecido: usa %s", *in.Status, strings.Join(statuses, ", "))}
		}
		b["status"] = *in.Status
	}
	if in.Place != nil {
		if strings.TrimSpace(*in.Place) == "" {
			delete(b, "place")
		} else {
			id, err := s.placeRef(t, *in.Place)
			if err != nil {
				return err
			}
			b["place"] = id
		}
	}
	for _, c := range []struct {
		k string
		v *float64
	}{{"pp", in.CostPP}, {"total", in.CostTotal}} {
		switch {
		case c.v == nil:
		case *c.v < 0:
			return &toolError{"um custo não pode ser negativo"}
		case *c.v == 0:
			delete(b, c.k)
		default:
			b[c.k] = *c.v
		}
	}
	if in.CostCategory != nil {
		switch cat := strings.TrimSpace(*in.CostCategory); {
		case cat == "":
			delete(b, "ccat")
		case slices.Contains(costCatIDs(t), cat):
			b["ccat"] = cat
		default:
			return &toolError{fmt.Sprintf("categoria de custo %q desconhecida: usa %s", cat, strings.Join(costCatIDs(t), ", "))}
		}
	}
	if in.TZ != nil {
		switch tz := strings.TrimSpace(*in.TZ); {
		case tz == "":
			delete(b, "tz")
		case validTz(tz):
			b["tz"] = tz
		default:
			return &toolError{fmt.Sprintf("fuso %q desconhecido: usa um nome IANA, como Europe/Lisbon", tz)}
		}
	}
	if err := setText("address", "a morada", in.Address, maxTextLen); err != nil {
		return err
	}
	if in.Link != nil && strings.TrimSpace(*in.Link) != "" && !linkRe.MatchString(strings.TrimSpace(*in.Link)) {
		return &toolError{"o link tem de começar por http:// ou https://"}
	}
	for _, f := range []struct {
		k, field string
		v        *string
	}{{"link", "o link", in.Link}, {"ref", "a referência", in.Ref}, {"note", "a nota", in.Note}} {
		if err := setText(f.k, f.field, f.v, maxTextLen); err != nil {
			return err
		}
	}
	if in.Weekdays != nil {
		ws := []any{}
		seen := map[int]bool{}
		for _, w := range *in.Weekdays {
			if w < 0 || w > 6 {
				return &toolError{"weekdays vão de 0 (domingo) a 6 (sábado)"}
			}
			if !seen[w] {
				seen[w] = true
				ws = append(ws, float64(w))
			}
		}
		// todos os dias da semana é o mesmo que nenhum (cleanBlock)
		if len(ws) == 0 || len(ws) == 7 {
			delete(b, "weekdays")
		} else {
			b["weekdays"] = ws
		}
	}
	b["ai"] = s.aiStamp()
	return nil
}

// placeBlock põe a atividade b no quadro em date, start minutos depois da meia-noite, ou em "por agendar" se toTray.
// O dia tem de ser da viagem: a página aceita atividades fora dela (com um aviso), a IA não.
func (s *server) placeBlock(t, b jsonObj, date string, start int, toTray bool) error {
	blocks := slices.DeleteFunc(objs(t, "blocks"), func(o jsonObj) bool { return str(o, "id") == str(b, "id") })
	tray := slices.DeleteFunc(objs(t, "tray"), func(o jsonObj) bool { return str(o, "id") == str(b, "id") })
	if toTray {
		delete(b, "date")
		delete(b, "start")
		tray = append(tray, b)
	} else {
		if !slices.Contains(tripDates(t), date) {
			return &toolError{fmt.Sprintf("o dia %q não é da viagem (%s a %s)", date, str(t, "start"), str(t, "end"))}
		}
		b["date"], b["start"] = date, float64(start)
		blocks = append(blocks, b)
	}
	setObjs(t, "blocks", blocks)
	setObjs(t, "tray", tray)
	b["ai"] = s.aiStamp()
	return nil
}

// newActivity cria uma atividade com os valores por omissão de newBlock (trip.js): 60 minutos, passeio, ideia.
func (s *server) newActivity(t jsonObj, in activityIn) (jsonObj, error) {
	if in.Title == nil {
		return nil, &toolError{"cada atividade precisa de um title"}
	}
	if (in.Date == nil) != (in.Start == nil) {
		return nil, &toolError{fmt.Sprintf("%q: date e start vêm juntos (sem nenhum dos dois fica em \"por agendar\")", *in.Title)}
	}
	b := jsonObj{"id": s.freshID("a", usedIDs(t, "blocks", "tray")), "len": float64(60), "cat": "tour", "status": "ideia"}
	if err := s.applyActivity(t, b, in); err != nil {
		return nil, err
	}
	if in.Date == nil {
		return b, s.placeBlock(t, b, "", 0, true)
	}
	m, err := parseClock(*in.Start)
	if err != nil {
		return nil, err
	}
	return b, s.placeBlock(t, b, *in.Date, m, false)
}

/* ---------- viagem ---------- */

// tripIn: os campos da viagem que a IA pode escrever (os mesmos do painel da viagem, tripFields em tripform.js).
// Não inclui archived nem readOnly: isso é só com o utilizador.
type tripIn struct {
	Name     *string  `json:"name"`
	Start    *string  `json:"start"`
	End      *string  `json:"end"`
	TZ       *string  `json:"tz"`
	People   *int     `json:"people"`
	Currency *string  `json:"currency"`
	Budget   *float64 `json:"budget"`
	DayStart *int     `json:"day_start"`
	DayEnd   *int     `json:"day_end"`
}

// applyTrip escreve os campos de in em t, com as validações de validateTrip (tripform.js), e devolve as
// atividades que ficaram fora das novas datas e foram para "por agendar" (applyTripEdit).
func (s *server) applyTrip(t jsonObj, in tripIn) ([]string, error) {
	if in.Name != nil {
		x, err := text("o nome", strings.TrimSpace(*in.Name), maxTitleLen)
		if err != nil {
			return nil, err
		}
		if x == "" {
			return nil, &toolError{"o nome da viagem está vazio"}
		}
		t["name"] = x
	}
	start, end := str(t, "start"), str(t, "end")
	if in.Start != nil {
		start = *in.Start
	}
	if in.End != nil {
		end = *in.End
	}
	a, ok1 := parseDate(start)
	b, ok2 := parseDate(end)
	switch {
	case !ok1 || !ok2:
		return nil, &toolError{"start e end são datas AAAA-MM-DD"}
	case b.Before(a):
		return nil, &toolError{"a viagem acaba antes de começar"}
	case int(b.Sub(a).Hours()/24)+1 > maxTripDays:
		return nil, &toolError{fmt.Sprintf("a viagem tem %d dias: o máximo é %d", int(b.Sub(a).Hours()/24)+1, maxTripDays)}
	}
	if in.TZ != nil {
		switch tz := strings.TrimSpace(*in.TZ); {
		case tz == "":
			delete(t, "tz")
		case validTz(tz):
			t["tz"] = tz
		default:
			return nil, &toolError{fmt.Sprintf("fuso %q desconhecido: usa um nome IANA, como Europe/Lisbon", tz)}
		}
	}
	if in.People != nil {
		if *in.People < 1 || *in.People > maxPeople {
			return nil, &toolError{fmt.Sprintf("people vai de 1 a %d", maxPeople)}
		}
		t["people"] = float64(*in.People)
	}
	if in.Currency != nil {
		c := strings.TrimSpace(*in.Currency)
		if c == "" || len([]rune(c)) > 5 || badCurrencyRe.MatchString(c) {
			return nil, &toolError{"a moeda é um símbolo até 5 caracteres, sem < > & \" ' `"}
		}
		t["currency"] = c
	}
	if in.Budget != nil {
		switch {
		case *in.Budget < 0:
			return nil, &toolError{"o orçamento não pode ser negativo"}
		case *in.Budget == 0:
			delete(t, "budget")
		default:
			t["budget"] = *in.Budget
		}
	}
	for _, h := range []struct {
		k string
		v *int
	}{{"dayStart", in.DayStart}, {"dayEnd", in.DayEnd}} {
		if h.v == nil {
			continue
		}
		if *h.v < 0 || *h.v > 23 {
			return nil, &toolError{"day_start e day_end são horas de 0 a 23"}
		}
		t[h.k] = float64(*h.v)
	}

	// novas datas: o que fica de fora não se perde (applyTripEdit), mas uma atividade protegida não sai do quadro
	inTrip := map[string]bool{}
	for d := a; !d.After(b); d = d.AddDate(0, 0, 1) {
		inTrip[d.Format(time.DateOnly)] = true
	}
	var moved []string
	var keep, out []jsonObj
	for _, x := range objs(t, "blocks") {
		if inTrip[str(x, "date")] {
			keep = append(keep, x)
			continue
		}
		if why := blockProtected(x); why != "" {
			return nil, &toolError{fmt.Sprintf("com estas datas a atividade %s (%q) saía do quadro, mas %s: só o utilizador a pode mudar", str(x, "id"), str(x, "title"), why)}
		}
		out = append(out, x)
	}
	t["start"], t["end"] = start, end
	for _, x := range out {
		delete(x, "date")
		delete(x, "start")
		x["ai"] = s.aiStamp()
		moved = append(moved, str(x, "id"))
	}
	setObjs(t, "blocks", keep)
	setObjs(t, "tray", append(objs(t, "tray"), out...))
	for _, c := range objs(t, "costs") {
		if d := str(c, "date"); d != "" && !inTrip[d] {
			delete(c, "date")
			c["ai"] = s.aiStamp()
		}
	}
	if dp, ok := t["dayPlaces"].(jsonObj); ok {
		for d := range dp {
			if !inTrip[d] {
				delete(dp, d)
			}
		}
	}
	t["ai"] = s.aiStamp()
	return moved, nil
}

// newTripFrom cria uma viagem vazia com os campos de in (newTrip em tripform.js). Sem horário, o quadro vai das
// 7:00 à 1:00, como no painel da viagem; sem pessoas são 2 e sem moeda é o euro.
func (s *server) newTripFrom(in tripIn) (jsonObj, error) {
	if in.Name == nil || in.Start == nil || in.End == nil {
		return nil, &toolError{"uma viagem nova precisa de name, start e end"}
	}
	t := jsonObj{"id": s.newID("t"), "dayStart": float64(7), "dayEnd": float64(1), "people": float64(2), "currency": "€",
		"places": []any{}, "dayPlaces": jsonObj{}, "blocks": []any{}, "tray": []any{}, "costs": []any{}}
	if _, err := s.applyTrip(t, in); err != nil {
		return nil, err
	}
	return t, nil
}

// setDayPlaces põe os sítios do dia date: [onde começam, …paragens, onde acabam] (setDayPlaces e noRepeats em trip.js).
// refs são ids ou nomes; um nome novo cria o sítio. Uma lista vazia limpa o dia.
func (s *server) setDayPlaces(t jsonObj, date string, refs []string) ([]string, error) {
	if !slices.Contains(tripDates(t), date) {
		return nil, &toolError{fmt.Sprintf("o dia %q não é da viagem (%s a %s)", date, str(t, "start"), str(t, "end"))}
	}
	ids := []string{}
	for _, r := range refs {
		id, err := s.placeRef(t, r)
		if err != nil {
			return nil, err
		}
		if len(ids) == 0 || ids[len(ids)-1] != id { // o mesmo sítio duas vezes seguidas é um só
			ids = append(ids, id)
		}
	}
	if len(ids) > maxDayPlaces {
		return nil, &toolError{fmt.Sprintf("um dia tem no máximo %d sítios", maxDayPlaces)}
	}
	dp, ok := t["dayPlaces"].(jsonObj)
	if !ok {
		dp = jsonObj{}
		t["dayPlaces"] = dp
	}
	if len(ids) == 0 {
		delete(dp, date)
	} else {
		a := make([]any, len(ids))
		for i, id := range ids {
			a[i] = id
		}
		dp[date] = a
	}
	t["ai"] = s.aiStamp()
	return ids, nil
}

/* ---------- custos ---------- */

// costIn: os campos de um custo que não é de uma atividade (Cost em clean.js). Sem date é um custo geral.
type costIn struct {
	Label    *string  `json:"label"`
	Amount   *float64 `json:"amount"`
	Per      *string  `json:"per"`
	Category *string  `json:"category"`
	Date     *string  `json:"date"`
	Paid     *bool    `json:"paid"`
}

func (s *server) applyCost(t, c jsonObj, in costIn) error {
	if in.Label != nil {
		x, err := text("a descrição", strings.TrimSpace(*in.Label), maxTitleLen)
		if err != nil {
			return err
		}
		if x == "" {
			return &toolError{"a descrição do custo está vazia"}
		}
		c["label"] = x
	}
	if in.Amount != nil {
		if *in.Amount < 0 {
			return &toolError{"o valor não pode ser negativo"}
		}
		c["amount"] = *in.Amount
	}
	if in.Per != nil {
		if *in.Per != "total" && *in.Per != "pp" {
			return &toolError{`per é "total" (para o grupo) ou "pp" (por pessoa)`}
		}
		c["per"] = *in.Per
	}
	if in.Category != nil {
		switch cat := strings.TrimSpace(*in.Category); {
		case cat == "":
			delete(c, "cat")
		case slices.Contains(costCatIDs(t), cat):
			c["cat"] = cat
		default:
			return &toolError{fmt.Sprintf("categoria de custo %q desconhecida: usa %s", cat, strings.Join(costCatIDs(t), ", "))}
		}
	}
	if in.Date != nil {
		switch d := strings.TrimSpace(*in.Date); {
		case d == "":
			delete(c, "date")
		case slices.Contains(tripDates(t), d):
			c["date"] = d
		default:
			return &toolError{fmt.Sprintf("o dia %q não é da viagem (%s a %s)", d, str(t, "start"), str(t, "end"))}
		}
	}
	if in.Paid != nil {
		if *in.Paid {
			c["paid"] = true
		} else {
			delete(c, "paid")
		}
	}
	c["ai"] = s.aiStamp()
	return nil
}

func findCost(t jsonObj, id string) (jsonObj, error) {
	for _, c := range objs(t, "costs") {
		if str(c, "id") == id {
			return c, nil
		}
	}
	return nil, &toolError{fmt.Sprintf("o custo %s não existe nesta viagem", id)}
}
