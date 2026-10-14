package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// updateGolden: go test -run TestMCPGolden -update volta a escrever testdata/mcp-trip.json.
var updateGolden = flag.Bool("update", false, "volta a escrever testdata/mcp-trip.json")

// newMCPTrip cria uma viagem de 5 dias pelo MCP e devolve o id.
func newMCPTrip(t *testing.T, s *server) string {
	t.Helper()
	out := mustTool(t, s, "create_trip", `{"name":"Japão","start":"2026-11-01","end":"2026-11-05","tz":"Asia/Tokyo","people":3,"currency":"¥"}`)
	return out["id"].(string)
}

// addOne junta uma atividade e devolve o id.
func addOne(t *testing.T, s *server, trip, activity string) string {
	t.Helper()
	out := mustTool(t, s, "add_activities", fmt.Sprintf(`{"trip_id":%q,"activities":[%s]}`, trip, activity))
	return out["added"].([]any)[0].(map[string]any)["id"].(string)
}

func blocksByTitle(trip map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, k := range []string{"blocks", "tray"} {
		for _, b := range trip[k].([]any) {
			m := b.(map[string]any)
			m["_in"] = k
			out[m["title"].(string)] = m
		}
	}
	return out
}

func TestMCPTripLifecycle(t *testing.T) {
	t.Parallel()
	s, clk := newMCPServer(t)
	id := newMCPTrip(t, s)
	if !tripIDRe.MatchString(id) || !strings.HasPrefix(id, "t") {
		t.Fatalf("id da viagem: %q", id)
	}

	out := mustTool(t, s, "add_activities", fmt.Sprintf(`{"trip_id":%q,"activities":[
		{"title":"Voo para Osaka","date":"2026-11-01","start":"23:30","duration":120,"kind":"transport","status":"reservar","tz":"Asia/Seoul","place":"Tóquio · Hotel"},
		{"title":"Templo","date":"2026-11-02","start":"9:15","place":"Quioto","cost_pp":1500,"cost_category":"atividades","weekdays":[1,2,3],"link":"https://example.com","note":"levar\nsapatos"},
		{"title":"Karaoke","kind":"party","cost_total":9000}
	]}`, id))
	if out["rev"].(float64) != 2 || len(out["added"].([]any)) != 3 {
		t.Fatalf("add_activities: %v", out)
	}
	voo := out["added"].([]any)[0].(map[string]any)
	if voo["start"] != "23:30" || voo["end"] != "01:30" || voo["end_date"] != "2026-11-02" || voo["place"].(map[string]any)["name"] != "Tóquio · Hotel" {
		t.Errorf("vista do voo: %v", voo)
	}

	trip, rev := storedTrip(t, s, id)
	bs := blocksByTitle(trip)
	if rev != 2 || len(trip["places"].([]any)) != 2 {
		t.Fatalf("rev %d, sítios %v", rev, trip["places"])
	}
	tpl := bs["Templo"]
	if tpl["_in"] != "blocks" || tpl["start"] != float64(9*60+15) || tpl["len"] != float64(60) || tpl["cat"] != "tour" || tpl["status"] != "ideia" || tpl["pp"] != float64(1500) || tpl["ccat"] != "atividades" {
		t.Errorf("templo gravado: %v", tpl)
	}
	if bs["Karaoke"]["_in"] != "tray" || bs["Karaoke"]["date"] != nil || bs["Karaoke"]["total"] != float64(9000) {
		t.Errorf("sem date nem start fica em por agendar: %v", bs["Karaoke"])
	}
	stamp := "2026-10-13T09:00:00Z"
	for title, b := range bs {
		if b["ai"] != stamp {
			t.Errorf("%s sem a marca ai: %v", title, b["ai"])
		}
	}
	if trip["ai"] != stamp {
		t.Error("um sítio novo marca a viagem")
	}

	// mudar, mover, sítios do dia, custos
	clk.add(time.Hour)
	tplID, karID := tpl["id"].(string), bs["Karaoke"]["id"].(string)
	got := mustTool(t, s, "update_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"title":"Templo Kinkaku-ji","start":"10:00","cost_pp":0,"note":""}`, id, tplID))
	if a := got["activity"].(map[string]any); a["title"] != "Templo Kinkaku-ji" || a["start"] != "10:00" || a["date"] != "2026-11-02" || a["cost_pp"] != nil || a["ai_changed_at"] != "2026-10-13T10:00:00Z" {
		t.Errorf("update_activity: %v", a)
	}
	mustTool(t, s, "move_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"date":"2026-11-03","start":"21:00"}`, id, karID))
	mustTool(t, s, "move_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"to_tray":true}`, id, tplID))
	if r := tool(t, s, "update_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"start":"10:00"}`, id, tplID)); !strings.Contains(r.errMsg, "date e start") {
		t.Errorf("uma atividade por agendar precisa de date e start: %q", r.errMsg)
	}
	dp := mustTool(t, s, "set_day_places", fmt.Sprintf(`{"trip_id":%q,"date":"2026-11-02","places":["Quioto","Quioto","Nara","Osaka"]}`, id))
	if ps := dp["places"].([]any); len(ps) != 3 || ps[1].(map[string]any)["name"] != "Nara" {
		t.Errorf("set_day_places junta os repetidos seguidos: %v", ps)
	}
	place := mustTool(t, s, "add_place", fmt.Sprintf(`{"trip_id":%q,"name":"nara"}`, id))
	if place["place"].(map[string]any)["name"] != "Nara" {
		t.Errorf("add_place com um nome que já existe devolve o mesmo sítio: %v", place)
	}
	cost := mustTool(t, s, "add_cost", fmt.Sprintf(`{"trip_id":%q,"label":"Hotel","amount":60000,"date":"2026-11-02","category":"alojamento"}`, id))
	cid := cost["cost"].(map[string]any)["id"].(string)
	mustTool(t, s, "update_cost", fmt.Sprintf(`{"trip_id":%q,"cost_id":%q,"per":"pp","date":"","paid":true}`, id, cid))
	if r := tool(t, s, "update_cost", fmt.Sprintf(`{"trip_id":%q,"cost_id":%q,"amount":1}`, id, cid)); !strings.Contains(r.errMsg, "pago") {
		t.Errorf("um custo pago não muda: %q", r.errMsg)
	}

	// leitura
	full := mustTool(t, s, "get_trip", fmt.Sprintf(`{"trip_id":%q}`, id))
	if len(full["scheduled_activities"].([]any)) != 2 || len(full["unscheduled_activities"].([]any)) != 1 || len(full["costs"].([]any)) != 1 || full["tz"] != "Asia/Tokyo" {
		t.Errorf("get_trip: %v", full)
	}
	if c := full["costs"].([]any)[0].(map[string]any); c["paid"] != true || c["per"] != "pp" || c["date"] != nil {
		t.Errorf("custo em get_trip: %v", c)
	}
	day := mustTool(t, s, "get_day", fmt.Sprintf(`{"trip_id":%q,"date":"2026-11-03"}`, id))
	if as := day["activities"].([]any); len(as) != 1 || as[0].(map[string]any)["title"] != "Karaoke" {
		t.Errorf("get_day: %v", day)
	}
	list := mustTool(t, s, "list_trips", `{}`)
	if ts := list["trips"].([]any); len(ts) != 1 || ts[0].(map[string]any)["activities"] != float64(2) {
		t.Errorf("list_trips: %v", list)
	}

	// encurtar a viagem manda para "por agendar" o que fica de fora, e os custos desses dias passam a gerais
	upd := mustTool(t, s, "update_trip", fmt.Sprintf(`{"trip_id":%q,"end":"2026-11-02","budget":250000,"day_start":8}`, id))
	if m := upd["moved_to_unscheduled"].([]any); len(m) != 1 || m[0] != karID {
		t.Errorf("update_trip moved_to_unscheduled: %v", upd)
	}
	trip, _ = storedTrip(t, s, id)
	if trip["end"] != "2026-11-02" || trip["budget"] != float64(250000) || trip["dayStart"] != float64(8) {
		t.Errorf("update_trip gravou: %v", trip)
	}
}

func TestMCPProtectedThings(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	id := newMCPTrip(t, s)
	paid := addOne(t, s, id, `{"title":"Voo","date":"2026-11-01","start":"08:00","status":"pago"}`)
	booked := addOne(t, s, id, `{"title":"Hotel","date":"2026-11-05","start":"15:00","status":"reservado"}`)
	locked := addOne(t, s, id, `{"title":"Jantar","date":"2026-11-02","start":"20:00"}`)
	// a página fixa uma atividade com locked:true
	trip, rev := storedTrip(t, s, id)
	for _, b := range trip["blocks"].([]any) {
		if b.(map[string]any)["id"] == locked {
			b.(map[string]any)["locked"] = true
		}
	}
	putStored(t, s, id, rev, trip)

	for _, a := range []string{paid, booked, locked} {
		for name, args := range map[string]string{
			"update_activity": fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"title":"outro"}`, id, a),
			"move_activity":   fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"to_tray":true}`, id, a),
		} {
			if r := tool(t, s, name, args); !strings.Contains(r.errMsg, "só o utilizador") {
				t.Errorf("%s numa atividade protegida (%s): %q", name, a, r.errMsg)
			}
		}
	}
	if r := tool(t, s, "update_trip", fmt.Sprintf(`{"trip_id":%q,"end":"2026-11-03"}`, id)); !strings.Contains(r.errMsg, "Hotel") {
		t.Errorf("encurtar a viagem não pode tirar uma atividade reservada do quadro: %q", r.errMsg)
	}
	if after, _ := storedTrip(t, s, id); after["end"] != "2026-11-05" {
		t.Error("um erro numa ferramenta não pode gravar nada")
	}

	// viagens só de leitura e arquivadas: a IA lê, mas não escreve
	for _, field := range []string{"readOnly", "archived"} {
		trip, rev := storedTrip(t, s, id)
		trip[field] = true
		putStored(t, s, id, rev, trip)
		if r := tool(t, s, "add_activities", fmt.Sprintf(`{"trip_id":%q,"activities":[{"title":"x"}]}`, id)); !strings.Contains(r.errMsg, "só o utilizador") {
			t.Errorf("%s: add_activities devia ser recusado: %q", field, r.errMsg)
		}
		if r := tool(t, s, "undo_last_ai_change", fmt.Sprintf(`{"trip_id":%q}`, id)); r.errMsg == "" {
			t.Errorf("%s: undo_last_ai_change devia ser recusado", field)
		}
		mustTool(t, s, "get_trip", fmt.Sprintf(`{"trip_id":%q}`, id))
		delete(trip, field)
		_, rev = storedTrip(t, s, id)
		putStored(t, s, id, rev, trip)
	}
	trip, rev = storedTrip(t, s, id)
	trip["archived"] = true
	putStored(t, s, id, rev, trip)
	if ts := mustTool(t, s, "list_trips", `{}`)["trips"].([]any); len(ts) != 0 {
		t.Errorf("as arquivadas não aparecem por omissão: %v", ts)
	}
	ts := mustTool(t, s, "list_trips", `{"include_archived":true}`)["trips"].([]any)
	if len(ts) != 1 || ts[0].(map[string]any)["archived"] != true || ts[0].(map[string]any)["read_only"] != true {
		t.Errorf("include_archived: %v", ts)
	}
}

// putStored grava a viagem como a página (PUT com baseRev).
func putStored(t *testing.T, s *server, id string, rev int64, trip map[string]any) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"baseRev": rev, "trip": trip})
	if w := authedCall(s, "PUT", "/api/trips/"+id, string(b)); w.Code != 200 {
		t.Fatalf("PUT: %d %s", w.Code, w.Body.String())
	}
}

func TestMCPValidation(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	id := newMCPTrip(t, s)
	act := addOne(t, s, id, `{"title":"Passeio","date":"2026-11-02","start":"10:00"}`)
	add := func(a string) string { return fmt.Sprintf(`{"trip_id":%q,"activities":[%s]}`, id, a) }
	for _, tc := range []struct{ tool, args, want string }{
		{"get_trip", `{"trip_id":"../x"}`, "inválido"},
		{"get_trip", `{"trip_id":"naoexiste"}`, "não existe"},
		{"get_trip", `{"trip_id":"x","extra":1}`, "argumentos inválidos"},
		{"get_day", fmt.Sprintf(`{"trip_id":%q,"date":"2026-12-01"}`, id), "não é da viagem"},
		{"add_activities", add(`{"title":"x","date":"2026-11-02","start":"25:00"}`), "inválida"},
		{"add_activities", add(`{"title":"x","date":"2026-11-02","start":"10h"}`), "HH:MM"},
		{"add_activities", add(`{"title":"x","date":"2026-10-31","start":"10:00"}`), "não é da viagem"},
		{"add_activities", add(`{"title":"x","date":"2026-11-02"}`), "juntos"},
		{"add_activities", add(`{"title":"  "}`), "vazio"},
		{"add_activities", add(`{"date":"2026-11-02","start":"10:00"}`), "title"},
		{"add_activities", add(`{"title":"x","duration":10}`), "duração"},
		{"add_activities", add(`{"title":"x","kind":"museu"}`), "kind"},
		{"add_activities", add(`{"title":"x","status":"confirmado"}`), "status"},
		{"add_activities", add(`{"title":"x","tz":"Lua/Base"}`), "fuso"},
		{"add_activities", add(`{"title":"x","link":"javascript:alert(1)"}`), "http"},
		{"add_activities", add(`{"title":"x","cost_pp":-1}`), "negativo"},
		{"add_activities", add(`{"title":"x","cost_category":"luxos"}`), "categoria"},
		{"add_activities", add(`{"title":"x","weekdays":[7]}`), "weekdays"},
		{"add_activities", add(`{"title":"x","colour":"red"}`), "argumentos inválidos"},
		{"add_activities", add(`{"title":"` + strings.Repeat("x", maxTitleLen+1) + `"}`), "demasiado longo"},
		{"add_activities", add(`{"title":"x\u0007"}`), "controlo"},
		{"add_activities", fmt.Sprintf(`{"trip_id":%q,"activities":[]}`, id), "de 1 a"},
		{"update_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":"nada"}`, id), "não existe"},
		{"move_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q}`, id, act), "to_tray"},
		{"move_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"to_tray":true,"date":"2026-11-02"}`, id, act), "to_tray"},
		{"move_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"date":"2026-11-02","start":"x"}`, id, act), "HH:MM"},
		{"set_day_places", fmt.Sprintf(`{"trip_id":%q,"date":"2026-11-02","places":["a","b","c","d","e","f","g","h","i","j","k","l","m"]}`, id), "no máximo"},
		{"set_day_places", fmt.Sprintf(`{"trip_id":%q,"date":"2027-01-01","places":[]}`, id), "não é da viagem"},
		{"add_place", fmt.Sprintf(`{"trip_id":%q,"name":" "}`, id), "vazio"},
		{"add_cost", fmt.Sprintf(`{"trip_id":%q,"label":"x"}`, id), "amount"},
		{"add_cost", fmt.Sprintf(`{"trip_id":%q,"label":"x","amount":-5}`, id), "negativo"},
		{"add_cost", fmt.Sprintf(`{"trip_id":%q,"label":"x","amount":5,"per":"dia"}`, id), "per"},
		{"add_cost", fmt.Sprintf(`{"trip_id":%q,"label":"x","amount":5,"date":"2026-01-01"}`, id), "não é da viagem"},
		{"add_cost", fmt.Sprintf(`{"trip_id":%q,"label":" ","amount":5}`, id), "vazia"},
		{"update_cost", fmt.Sprintf(`{"trip_id":%q,"cost_id":"nada"}`, id), "não existe"},
		{"create_trip", `{"name":"x"}`, "start"},
		{"create_trip", `{"name":"x","start":"2026-02-30","end":"2026-03-01"}`, "AAAA-MM-DD"},
		{"create_trip", `{"name":"x","start":"2026-03-02","end":"2026-03-01"}`, "antes de começar"},
		{"create_trip", `{"name":"x","start":"2026-01-01","end":"2026-03-15"}`, "máximo"},
		{"create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02","currency":"<b>"}`, "moeda"},
		{"create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02","people":0}`, "people"},
		{"create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02","day_start":24}`, "0 a 23"},
		{"create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02","budget":-1}`, "negativo"},
		{"create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02","tz":"Marte"}`, "fuso"},
		{"create_trip", `{"name":"","start":"2026-01-01","end":"2026-01-02"}`, "vazio"},
		{"create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02","archived":true}`, "argumentos inválidos"},
	} {
		if r := tool(t, s, tc.tool, tc.args); !strings.Contains(r.errMsg, tc.want) {
			t.Errorf("%s %s: erro %q, esperava algo com %q", tc.tool, tc.args, r.errMsg, tc.want)
		}
	}
	if _, rev := storedTrip(t, s, id); rev != 2 {
		t.Errorf("nenhuma das chamadas erradas podia gravar: rev %d", rev)
	}
}

func TestMCPUndo(t *testing.T) {
	t.Parallel()
	s, clk := newMCPServer(t)
	id := newMCPTrip(t, s)
	undo := fmt.Sprintf(`{"trip_id":%q}`, id)
	if r := tool(t, s, "undo_last_ai_change", undo); !strings.Contains(r.errMsg, "nenhuma") {
		t.Errorf("sem nada para desfazer: %q", r.errMsg)
	}
	a := addOne(t, s, id, `{"title":"A"}`)
	clk.add(time.Second)
	addOne(t, s, id, `{"title":"B"}`)

	// desfaz uma de cada vez, da mais recente para a mais antiga
	if out := mustTool(t, s, "undo_last_ai_change", undo); out["rev"] != float64(4) {
		t.Errorf("undo: %v", out)
	}
	if bs := blocksByTitle(must(storedTrip(t, s, id))); len(bs) != 1 || bs["A"] == nil {
		t.Errorf("depois de desfazer B: %v", bs)
	}
	mustTool(t, s, "undo_last_ai_change", undo)
	if bs := blocksByTitle(must(storedTrip(t, s, id))); len(bs) != 0 {
		t.Errorf("depois de desfazer A: %v", bs)
	}

	// a página deu as alterações como vistas (tirou as marcas ai) e gravou: o undo continua a funcionar
	mustTool(t, s, "update_trip", fmt.Sprintf(`{"trip_id":%q,"name":"Japão 2026"}`, id))
	addOne(t, s, id, `{"title":"D"}`)
	trip, rev := storedTrip(t, s, id)
	delete(trip, "ai")
	for _, b := range trip["tray"].([]any) {
		delete(b.(map[string]any), "ai")
	}
	putStored(t, s, id, rev, trip)
	mustTool(t, s, "undo_last_ai_change", undo)
	if bs := blocksByTitle(must(storedTrip(t, s, id))); len(bs) != 0 {
		t.Errorf("undo depois de a página tirar as marcas: %v", bs)
	}

	// se o utilizador mudou a viagem depois da IA, o undo recusa (e a página usa o seu Desfazer)
	trip, rev = storedTrip(t, s, id)
	trip["people"] = float64(5)
	putStored(t, s, id, rev, trip)
	if r := tool(t, s, "undo_last_ai_change", undo); !strings.Contains(r.errMsg, "mudou depois") {
		t.Errorf("com a viagem mudada pela página: %q", r.errMsg)
	}
	if w := authedCall(s, "POST", "/api/trips/"+id+"/undo-ai", ""); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "mudou depois") {
		t.Errorf("POST undo-ai com a viagem mudada: %d %s", w.Code, w.Body.String())
	}

	// o botão da página faz o mesmo que a ferramenta
	addOne(t, s, id, `{"title":"C"}`)
	w := authedCall(s, "POST", "/api/trips/"+id+"/undo-ai", "")
	if w.Code != 200 || decode[map[string]any](t, w)["rev"] == nil {
		t.Errorf("POST undo-ai: %d %s", w.Code, w.Body.String())
	}
	if w := call(s, "POST", "/api/trips/"+id+"/undo-ai", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("undo-ai sem sessão: %d", w.Code)
	}
	_ = a
}

func must(trip map[string]any, _ int64) map[string]any { return trip }

func TestMCPSnapshotRetention(t *testing.T) {
	t.Parallel()
	s, clk := newMCPServer(t)
	id := newMCPTrip(t, s)
	for i := 0; i < aiSnapshotsKept+3; i++ {
		clk.add(time.Second)
		addOne(t, s, id, fmt.Sprintf(`{"title":"a%d"}`, i))
	}
	if n := len(s.aiSnapshots(id)); n != aiSnapshotsKept {
		t.Errorf("ficaram %d cópias de antes da IA, esperava %d", n, aiSnapshotsKept)
	}
	// as cópias da IA não contam para as diárias, nem as diárias as apagam
	clk.add(48 * time.Hour)
	s.backup(id, s.tripPath(id))
	if n := len(s.aiSnapshots(id)); n != aiSnapshotsKept {
		t.Errorf("a cópia diária apagou cópias da IA: ficaram %d", n)
	}
}

func TestMCPWriteFailure(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	id := newMCPTrip(t, s)
	logs := captureLog(s)
	s.writeFile = func(string, []byte) error { return errors.New("disco cheio") }
	if r := tool(t, s, "add_activities", fmt.Sprintf(`{"trip_id":%q,"activities":[{"title":"x"}]}`, id)); !strings.Contains(r.errMsg, "erro do servidor") {
		t.Errorf("com o disco cheio: %q", r.errMsg)
	}
	if !strings.Contains(logs.String(), "disco cheio") {
		t.Errorf("o erro devia ficar no log: %q", logs.String())
	}
	if r := tool(t, s, "create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02"}`); !strings.Contains(r.errMsg, "erro do servidor") {
		t.Errorf("create_trip com o disco cheio: %q", r.errMsg)
	}
	if w := authedCall(s, "POST", "/api/trips/"+id+"/undo-ai", ""); w.Code != http.StatusConflict {
		t.Errorf("undo-ai sem cópias: %d", w.Code) // a gravação falhou, por isso não ficou nenhuma cópia
	}
}

func TestMCPTripTooBig(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	id := newMCPTrip(t, s)
	note := strings.Repeat("n", maxTextLen)
	acts := make([]string, maxActivities/2) // 1,2 MB por pedido, abaixo do limite do corpo
	for i := range acts {
		acts[i] = fmt.Sprintf(`{"title":"x","note":%q,"address":%q,"ref":%q}`, note, note, note)
	}
	var r toolResult
	for i := 0; i < 3 && r.errMsg == ""; i++ { // 100 atividades com 12 kB de texto: a segunda vez passa dos 2 MB
		r = tool(t, s, "add_activities", fmt.Sprintf(`{"trip_id":%q,"activities":[%s]}`, id, strings.Join(acts, ",")))
	}
	if !strings.Contains(r.errMsg, "demasiado grande") {
		t.Errorf("viagem acima de maxTripBytes: %q", r.errMsg)
	}
}

// TestMCPGolden grava uma viagem com todas as ferramentas que escrevem, num relógio parado e com ids previsíveis,
// e compara-a com testdata/mcp-trip.json. tests/mcp.test.mjs passa esse ficheiro pelo cleanTrip da página:
// se as regras de tripedit.go se afastarem das de clean.js, um dos dois testes falha.
func TestMCPGolden(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	id := newMCPTrip(t, s)
	addOne(t, s, id, `{"title":"Voo","date":"2026-11-01","start":"23:30","duration":600,"kind":"transport","status":"reservar","tz":"Europe/Lisbon","ref":"TP123"}`)
	a := addOne(t, s, id, `{"title":"Templo","date":"2026-11-02","start":"09:00","place":"Quioto","cost_pp":1500,"cost_category":"atividades","weekdays":[1,2,3,4,5]}`)
	addOne(t, s, id, `{"title":"Karaoke","kind":"party","cost_total":9000,"link":"https://example.com","note":"duas\nlinhas","address":"Shibuya"}`)
	mustTool(t, s, "update_activity", fmt.Sprintf(`{"trip_id":%q,"activity_id":%q,"duration":90,"status":"pago"}`, id, a))
	mustTool(t, s, "set_day_places", fmt.Sprintf(`{"trip_id":%q,"date":"2026-11-02","places":["Tóquio","Quioto"]}`, id))
	mustTool(t, s, "add_cost", fmt.Sprintf(`{"trip_id":%q,"label":"Hotel","amount":60000,"per":"total","date":"2026-11-02","category":"alojamento"}`, id))
	mustTool(t, s, "add_cost", fmt.Sprintf(`{"trip_id":%q,"label":"Seguro","amount":40,"per":"pp","paid":true}`, id))
	mustTool(t, s, "update_trip", fmt.Sprintf(`{"trip_id":%q,"budget":300000,"day_end":2}`, id))

	got, err := os.ReadFile(s.tripPath(id))
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		Trip json.RawMessage `json:"trip"`
	}
	json.Unmarshal(got, &rec)
	var pretty map[string]any
	json.Unmarshal(rec.Trip, &pretty)
	out, _ := json.MarshalIndent(pretty, "", "  ")
	out = append(out, '\n')
	p := filepath.Join("testdata", "mcp-trip.json")
	if *updateGolden {
		if err := os.WriteFile(p, out, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("%v (corre go test -run TestMCPGolden -update)", err)
	}
	if string(want) != string(out) {
		t.Errorf("a viagem gravada mudou: corre go test -run TestMCPGolden -update, confirma o diff e node --test tests/mcp.test.mjs\n%s", out)
	}
}
