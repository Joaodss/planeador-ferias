package main

// As ferramentas MCP (mcp.go): o que um assistente de IA pode ler e mudar nas viagens.
//
// Regras, para um engano da IA não estragar o plano (as validações estão em tripedit.go):
//   - não há ferramentas para apagar: tirar uma atividade do plano é mandá-la para "por agendar";
//   - atividades fixas, reservadas ou pagas, custos pagos e viagens só de leitura ou arquivadas não mudam;
//   - tudo o que muda fica com o campo ai (data da alteração), que a página mostra até o utilizador o dar como visto;
//   - antes de cada alteração fica uma cópia (aiSnapshot) e undo_last_ai_change volta a ela.
// Com PLANNER_MCP_MODE=read as ferramentas que escrevem nem aparecem na lista.

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"time"
)

// mcpTool é uma ferramenta: a descrição que vai no tools/list e a função que a corre.
type mcpTool struct {
	Name        string  `json:"name"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	InputSchema jsonObj `json:"inputSchema"`
	Annotations jsonObj `json:"annotations"`
	write       bool
	run         func(s *server, args json.RawMessage) (any, error)
}

/* ---------- esquemas ---------- */

func schemaObj(required []string, props jsonObj) jsonObj {
	if required == nil {
		required = []string{}
	}
	return jsonObj{"type": "object", "properties": props, "required": required, "additionalProperties": false}
}
func pStr(desc string) jsonObj  { return jsonObj{"type": "string", "description": desc} }
func pInt(desc string) jsonObj  { return jsonObj{"type": "integer", "description": desc} }
func pNum(desc string) jsonObj  { return jsonObj{"type": "number", "description": desc} }
func pBool(desc string) jsonObj { return jsonObj{"type": "boolean", "description": desc} }
func pEnum(desc string, values []string) jsonObj {
	return jsonObj{"type": "string", "description": desc, "enum": values}
}

const (
	dTripID = "id da viagem (de list_trips)"
	dDate   = "dia, AAAA-MM-DD, na hora local da viagem"
)

// with junta propriedades a um esquema (sem mexer nos mapas recebidos).
func with(base jsonObj, extra jsonObj) jsonObj {
	out := jsonObj{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// activityProps: os campos de activityIn.
func activityProps() jsonObj {
	return jsonObj{
		"title":         pStr("título curto"),
		"date":          pStr(dDate + "; com start. Sem date nem start fica em \"por agendar\""),
		"start":         pStr("hora de início, HH:MM, na hora local da viagem; com date"),
		"duration":      pInt("duração em minutos (mínimo 15; por omissão 60). Pode passar da meia-noite e durar vários dias"),
		"kind":          pEnum("tipo: tour (passeio, visita), party (festa, saída à noite), transport (voo, comboio, carro), food (refeição), rest (tempo livre), sleep (dormir). Por omissão tour", kinds),
		"status":        pEnum("estado: ideia, reservar (falta reservar), reservado, pago. Por omissão ideia. Uma atividade reservada ou paga deixa de poder ser mudada pela IA", statuses),
		"place":         pStr("sítio onde acontece: id ou nome (um nome novo cria o sítio). Vazio tira o sítio"),
		"cost_pp":       pNum("custo por pessoa, na moeda da viagem. 0 tira"),
		"cost_total":    pNum("custo para o grupo todo. 0 tira"),
		"cost_category": pStr("categoria de custo (ids em get_trip: cost_categories). Sem ela a página escolhe pelo tipo"),
		"tz":            pStr("fuso próprio (IANA, ex.: America/New_York), para um voo entre fusos. date e start continuam na hora da viagem"),
		"address":       pStr("morada"),
		"link":          pStr("link http(s)"),
		"ref":           pStr("referência da reserva"),
		"note":          pStr("notas"),
		"weekdays":      jsonObj{"type": "array", "items": jsonObj{"type": "integer", "minimum": 0, "maximum": 6}, "description": "dias da semana em que é possível (0 = domingo … 6 = sábado), ex.: um museu fechado à segunda. Lista vazia tira"},
	}
}

// tripProps: os campos de tripIn.
func tripProps() jsonObj {
	return jsonObj{
		"name":      pStr("nome da viagem"),
		"start":     pStr("primeiro dia, AAAA-MM-DD"),
		"end":       pStr("último dia (inclusive), AAAA-MM-DD; no máximo 60 dias"),
		"tz":        pStr("fuso da viagem (IANA, ex.: Asia/Tokyo): as horas do quadro são a hora local deste fuso. Vazio tira"),
		"people":    pInt("número de pessoas, para dividir os custos"),
		"currency":  pStr("símbolo da moeda, até 5 caracteres (ex.: €, $, ¥)"),
		"budget":    pNum("orçamento para o grupo. 0 tira"),
		"day_start": pInt("hora (0–23) a que o quadro começa; só muda o que se vê"),
		"day_end":   pInt("hora (0–23) a que o quadro acaba; menor que day_start quando acaba depois da meia-noite"),
	}
}

func costProps() jsonObj {
	return jsonObj{
		"label":    pStr("descrição (ex.: Hotel, Seguro de viagem)"),
		"amount":   pNum("valor, na moeda da viagem"),
		"per":      pEnum("total: para o grupo; pp: por pessoa. Por omissão total", []string{"total", "pp"}),
		"category": pStr("categoria de custo (ids em get_trip: cost_categories)"),
		"date":     pStr(dDate + ". Sem date é um custo geral da viagem"),
		"paid":     pBool("já está pago (deixa de poder ser mudado pela IA)"),
	}
}

func readAnn() jsonObj { return jsonObj{"readOnlyHint": true, "openWorldHint": false} }

// writeAnn: additive quando só junta coisas novas (destructiveHint false); senão muda o que já existe.
func writeAnn(additive bool) jsonObj {
	return jsonObj{"readOnlyHint": false, "destructiveHint": !additive, "idempotentHint": false, "openWorldHint": false}
}

/* ---------- vistas ---------- */

// blockView mostra uma atividade com os nomes das ferramentas (kind, duration, …) e as horas em HH:MM.
func blockView(t, b jsonObj) jsonObj {
	v := jsonObj{"id": str(b, "id"), "title": str(b, "title"), "duration": int(num(b, "len")), "kind": str(b, "cat")}
	if d := str(b, "date"); d != "" {
		start := int(num(b, "start"))
		end := start + int(num(b, "len"))
		v["date"], v["start"], v["end"] = d, clockLabel(start), clockLabel(end)
		if day, ok := parseDate(d); ok && end/1440 > 0 {
			v["end_date"] = day.AddDate(0, 0, end/1440).Format(time.DateOnly)
		}
		if day, ok := parseDate(d); ok && start >= 1440 { // começa depois da meia-noite, mas pertence à coluna de date
			v["start_date"] = day.AddDate(0, 0, start/1440).Format(time.DateOnly)
		}
	}
	for _, k := range [][2]string{{"status", "status"}, {"tz", "tz"}, {"address", "address"}, {"link", "link"}, {"ref", "ref"}, {"note", "note"}, {"ccat", "cost_category"}} {
		if x := str(b, k[0]); x != "" {
			v[k[1]] = x
		}
	}
	if p := str(b, "place"); p != "" {
		v["place"] = jsonObj{"id": p, "name": placeName(t, p)}
	}
	if x := num(b, "pp"); x > 0 {
		v["cost_pp"] = x
	}
	if x := num(b, "total"); x > 0 {
		v["cost_total"] = x
	}
	if w, ok := b["weekdays"].([]any); ok && len(w) > 0 {
		v["weekdays"] = w
	}
	if why := blockProtected(b); why != "" {
		v["protected"] = why
	}
	if b["locked"] == true {
		v["locked"] = true
	}
	if a := str(b, "ai"); a != "" {
		v["ai_changed_at"] = a
	}
	return v
}

func placeName(t jsonObj, id string) string {
	for _, p := range objs(t, "places") {
		if str(p, "id") == id {
			return str(p, "name")
		}
	}
	return ""
}

func costView(c jsonObj) jsonObj {
	v := jsonObj{"id": str(c, "id"), "label": str(c, "label"), "amount": num(c, "amount"), "per": str(c, "per")}
	if v["per"] == "" {
		v["per"] = "total"
	}
	for _, k := range [][2]string{{"cat", "category"}, {"date", "date"}, {"ai", "ai_changed_at"}} {
		if x := str(c, k[0]); x != "" {
			v[k[1]] = x
		}
	}
	if c["paid"] == true {
		v["paid"] = true
	}
	return v
}

func placesOf(t jsonObj, ids []any) []jsonObj {
	out := []jsonObj{}
	for _, x := range ids {
		if id, ok := x.(string); ok {
			out = append(out, jsonObj{"id": id, "name": placeName(t, id)})
		}
	}
	return out
}

// tripSummary: o cabeçalho de uma viagem, sem as atividades.
func tripSummary(t jsonObj, rev int64) jsonObj {
	v := jsonObj{"id": str(t, "id"), "name": str(t, "name"), "start": str(t, "start"), "end": str(t, "end"),
		"people": int(num(t, "people")), "currency": str(t, "currency"), "day_start": int(num(t, "dayStart")), "day_end": int(num(t, "dayEnd")),
		"rev": rev, "activities": len(objs(t, "blocks")), "unscheduled": len(objs(t, "tray")),
		"read_only": t["readOnly"] == true || t["archived"] == true, "archived": t["archived"] == true}
	if tz := str(t, "tz"); tz != "" {
		v["tz"] = tz
	}
	if b := num(t, "budget"); b > 0 {
		v["budget"] = b
	}
	return v
}

// sortedBlocks: as atividades do quadro por dia e hora.
func sortedBlocks(t jsonObj, keep func(jsonObj) bool) []jsonObj {
	bs := slices.DeleteFunc(objs(t, "blocks"), func(b jsonObj) bool { return !keep(b) })
	slices.SortStableFunc(bs, func(a, b jsonObj) int {
		if c := strings.Compare(str(a, "date"), str(b, "date")); c != 0 {
			return c
		}
		return int(num(a, "start") - num(b, "start"))
	})
	out := make([]jsonObj, len(bs))
	for i, b := range bs {
		out[i] = blockView(t, b)
	}
	return out
}

func tripView(t jsonObj, rev int64) jsonObj {
	v := tripSummary(t, rev)
	places := []jsonObj{}
	for _, p := range objs(t, "places") {
		places = append(places, jsonObj{"id": str(p, "id"), "name": str(p, "name")})
	}
	days := jsonObj{}
	if dp, ok := t["dayPlaces"].(jsonObj); ok {
		for d, ids := range dp {
			a, _ := ids.([]any)
			days[d] = placesOf(t, a)
		}
	}
	tray := []jsonObj{}
	for _, b := range objs(t, "tray") {
		tray = append(tray, blockView(t, b))
	}
	costs := []jsonObj{}
	for _, c := range objs(t, "costs") {
		costs = append(costs, costView(c))
	}
	v["places"], v["day_places"], v["unscheduled_activities"], v["costs"] = places, days, tray, costs
	v["scheduled_activities"] = sortedBlocks(t, func(jsonObj) bool { return true })
	v["cost_categories"] = costCatIDs(t)
	return v
}

/* ---------- ferramentas ---------- */

// decodeArgs lê os argumentos de uma ferramenta e recusa campos desconhecidos (um nome mal escrito pela IA
// não pode passar em silêncio).
func decodeArgs(args json.RawMessage, v any) error {
	d := json.NewDecoder(bytes.NewReader(args))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return &toolError{"argumentos inválidos: " + err.Error()}
	}
	return nil
}

type tripRef struct {
	TripID string `json:"trip_id"`
}

var mcpTools = []*mcpTool{
	{
		Name: "list_trips", Title: "Listar viagens", Annotations: readAnn(),
		Description: "Lista as viagens (sem as atividades). As arquivadas só aparecem com include_archived.",
		InputSchema: schemaObj(nil, jsonObj{"include_archived": pBool("incluir as viagens arquivadas")}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				IncludeArchived bool `json:"include_archived"`
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			raws, _, err := s.readTripRecords()
			if err != nil {
				return nil, err
			}
			trips := []jsonObj{}
			for _, raw := range raws {
				var rec struct {
					Rev  int64   `json:"rev"`
					Trip jsonObj `json:"trip"`
				}
				if json.Unmarshal(raw, &rec) != nil || (rec.Trip["archived"] == true && !in.IncludeArchived) {
					continue
				}
				trips = append(trips, tripSummary(rec.Trip, rec.Rev))
			}
			slices.SortFunc(trips, func(a, b jsonObj) int { return strings.Compare(a["start"].(string), b["start"].(string)) })
			return jsonObj{"trips": trips}, nil
		},
	},
	{
		Name: "get_trip", Title: "Ver viagem", Annotations: readAnn(),
		Description: "A viagem toda: dados, sítios, sítios de cada dia, atividades no quadro (por dia e hora), atividades por agendar e custos. " +
			"protected numa atividade diz porque é que a IA não a pode mudar.",
		InputSchema: schemaObj([]string{"trip_id"}, jsonObj{"trip_id": pStr(dTripID)}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in tripRef
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			t, rev, err := s.readTrip(in.TripID)
			if err != nil {
				return nil, err
			}
			return tripView(t, rev), nil
		},
	},
	{
		Name: "get_day", Title: "Ver um dia", Annotations: readAnn(),
		Description: "Um dia da viagem: os sítios (onde começam, paragens, onde acabam), as atividades por hora e os custos desse dia.",
		InputSchema: schemaObj([]string{"trip_id", "date"}, jsonObj{"trip_id": pStr(dTripID), "date": pStr(dDate)}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID string `json:"trip_id"`
				Date   string `json:"date"`
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			t, rev, err := s.readTrip(in.TripID)
			if err != nil {
				return nil, err
			}
			if !slices.Contains(tripDates(t), in.Date) {
				return nil, &toolError{"o dia " + in.Date + " não é da viagem (" + str(t, "start") + " a " + str(t, "end") + ")"}
			}
			dp, _ := t["dayPlaces"].(jsonObj)
			ids, _ := dp[in.Date].([]any)
			costs := []jsonObj{}
			for _, c := range objs(t, "costs") {
				if str(c, "date") == in.Date {
					costs = append(costs, costView(c))
				}
			}
			return jsonObj{"trip_id": in.TripID, "rev": rev, "date": in.Date, "places": placesOf(t, ids), "costs": costs,
				"activities": sortedBlocks(t, func(b jsonObj) bool { return str(b, "date") == in.Date })}, nil
		},
	},
	{
		Name: "create_trip", Title: "Criar viagem", Annotations: writeAnn(true), write: true,
		Description: "Cria uma viagem vazia. Devolve o id. Por omissão: 2 pessoas, euro, quadro das 7:00 à 1:00.",
		InputSchema: schemaObj([]string{"name", "start", "end"}, tripProps()),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in tripIn
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			t, err := s.newTripFrom(in)
			if err != nil {
				return nil, err
			}
			rev, err := s.createTrip(t)
			if err != nil {
				return nil, err
			}
			return tripSummary(t, rev), nil
		},
	},
	{
		Name: "update_trip", Title: "Mudar viagem", Annotations: writeAnn(false), write: true,
		Description: "Muda os dados da viagem (só os campos enviados). Ao encurtar as datas, as atividades que ficam de fora vão para \"por agendar\" " +
			"(devolvidas em moved_to_unscheduled) e os custos desses dias passam a gerais; se alguma for protegida, nada muda.",
		InputSchema: schemaObj([]string{"trip_id"}, with(tripProps(), jsonObj{"trip_id": pStr(dTripID)})),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID string `json:"trip_id"`
				tripIn
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			var moved []string
			var t jsonObj
			_, rev, err := s.editTrip(in.TripID, func(x jsonObj) (any, error) {
				t = x
				var err error
				moved, err = s.applyTrip(x, in.tripIn)
				return nil, err
			})
			if err != nil {
				return nil, err
			}
			out := tripSummary(t, rev)
			if moved == nil {
				moved = []string{}
			}
			out["moved_to_unscheduled"] = moved
			return out, nil
		},
	},
	{
		Name: "add_activities", Title: "Juntar atividades", Annotations: writeAnn(true), write: true,
		Description: "Junta uma ou mais atividades de uma vez (um itinerário inteiro numa só chamada). Com date e start ficam no quadro; " +
			"sem nenhum dos dois ficam em \"por agendar\". Se uma falhar, nenhuma é gravada. Devolve as atividades criadas, com os ids.",
		InputSchema: schemaObj([]string{"trip_id", "activities"}, jsonObj{
			"trip_id":    pStr(dTripID),
			"activities": jsonObj{"type": "array", "minItems": 1, "maxItems": maxActivities, "items": schemaObj([]string{"title"}, activityProps())},
		}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID     string       `json:"trip_id"`
				Activities []activityIn `json:"activities"`
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			if len(in.Activities) == 0 || len(in.Activities) > maxActivities {
				return nil, &toolError{"activities tem de ter de 1 a 200 atividades"}
			}
			out, rev, err := s.editTrip(in.TripID, func(t jsonObj) (any, error) {
				views := []jsonObj{}
				for _, a := range in.Activities {
					b, err := s.newActivity(t, a)
					if err != nil {
						return nil, err
					}
					views = append(views, blockView(t, b))
				}
				return views, nil
			})
			if err != nil {
				return nil, err
			}
			return jsonObj{"trip_id": in.TripID, "rev": rev, "added": out}, nil
		},
	},
	{
		Name: "update_activity", Title: "Mudar atividade", Annotations: writeAnn(false), write: true,
		Description: "Muda uma atividade (só os campos enviados; texto vazio ou 0 tiram o campo). date e start movem-na no quadro. " +
			"Atividades fixas, reservadas ou pagas não podem ser mudadas.",
		InputSchema: schemaObj([]string{"trip_id", "activity_id"}, with(activityProps(), jsonObj{"trip_id": pStr(dTripID), "activity_id": pStr("id da atividade")})),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID     string `json:"trip_id"`
				ActivityID string `json:"activity_id"`
				activityIn
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			return s.blockEdit(in.TripID, in.ActivityID, func(t, b jsonObj, inTray bool) error {
				if err := s.applyActivity(t, b, in.activityIn); err != nil {
					return err
				}
				if in.Date == nil && in.Start == nil {
					return nil
				}
				if inTray && (in.Date == nil || in.Start == nil) {
					return &toolError{"para pôr no quadro uma atividade que está por agendar são precisos date e start"}
				}
				date, start := str(b, "date"), int(num(b, "start")) // o que não vem fica como está
				if in.Date != nil {
					date = *in.Date
				}
				if in.Start != nil {
					m, err := parseClock(*in.Start)
					if err != nil {
						return err
					}
					start = m
				}
				return s.placeBlock(t, b, date, start, false)
			})
		},
	},
	{
		Name: "move_activity", Title: "Mover atividade", Annotations: writeAnn(false), write: true,
		Description: "Move uma atividade para outro dia e hora (date e start) ou para \"por agendar\" (to_tray). " +
			"É assim que se tira uma atividade do plano: a IA não apaga nada.",
		InputSchema: schemaObj([]string{"trip_id", "activity_id"}, jsonObj{
			"trip_id": pStr(dTripID), "activity_id": pStr("id da atividade"),
			"date": pStr(dDate), "start": pStr("hora de início, HH:MM"), "to_tray": pBool("tirar do quadro para \"por agendar\""),
		}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID     string `json:"trip_id"`
				ActivityID string `json:"activity_id"`
				Date       string `json:"date"`
				Start      string `json:"start"`
				ToTray     bool   `json:"to_tray"`
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			if in.ToTray {
				if in.Date != "" || in.Start != "" {
					return nil, &toolError{"envia date e start, ou só to_tray: true"}
				}
				return s.blockEdit(in.TripID, in.ActivityID, func(t, b jsonObj, _ bool) error {
					return s.placeBlock(t, b, "", 0, true)
				})
			}
			if in.Date == "" || in.Start == "" {
				return nil, &toolError{"envia date e start, ou só to_tray: true"}
			}
			m, err := parseClock(in.Start)
			if err != nil {
				return nil, err
			}
			return s.blockEdit(in.TripID, in.ActivityID, func(t, b jsonObj, _ bool) error {
				return s.placeBlock(t, b, in.Date, m, false)
			})
		},
	},
	{
		Name: "add_place", Title: "Juntar sítio", Annotations: writeAnn(true), write: true,
		Description: "Junta um sítio à viagem (cidade, hotel…). Se já existir um com esse nome, devolve-o. " +
			"\"Lisboa · Hotel Avenida\": o que vem antes de \" ·\" é o nome curto que aparece no quadro.",
		InputSchema: schemaObj([]string{"trip_id", "name"}, jsonObj{"trip_id": pStr(dTripID), "name": pStr("nome do sítio")}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID string `json:"trip_id"`
				Name   string `json:"name"`
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			p, rev, err := s.editTrip(in.TripID, func(t jsonObj) (any, error) {
				p, err := s.addPlace(t, in.Name)
				if err != nil {
					return nil, err
				}
				return jsonObj{"id": str(p, "id"), "name": str(p, "name")}, nil
			})
			if err != nil {
				return nil, err
			}
			return jsonObj{"trip_id": in.TripID, "rev": rev, "place": p}, nil
		},
	},
	{
		Name: "set_day_places", Title: "Sítios do dia", Annotations: writeAnn(false), write: true,
		Description: "Diz onde a viagem está num dia: [onde começam, …paragens, onde acabam] (até 12; o mesmo sítio seguido conta uma vez). " +
			"Um dia de viagem de Lisboa para o Porto é [\"Lisboa\", \"Porto\"]. Aceita ids ou nomes (um nome novo cria o sítio). Lista vazia limpa o dia.",
		InputSchema: schemaObj([]string{"trip_id", "date", "places"}, jsonObj{
			"trip_id": pStr(dTripID), "date": pStr(dDate),
			"places": jsonObj{"type": "array", "items": jsonObj{"type": "string"}, "maxItems": maxDayPlaces, "description": "ids ou nomes dos sítios, por ordem"},
		}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID string   `json:"trip_id"`
				Date   string   `json:"date"`
				Places []string `json:"places"`
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			out, rev, err := s.editTrip(in.TripID, func(t jsonObj) (any, error) {
				ids, err := s.setDayPlaces(t, in.Date, in.Places)
				a := make([]any, len(ids))
				for i, id := range ids {
					a[i] = id
				}
				return placesOf(t, a), err
			})
			if err != nil {
				return nil, err
			}
			return jsonObj{"trip_id": in.TripID, "rev": rev, "date": in.Date, "places": out}, nil
		},
	},
	{
		Name: "add_cost", Title: "Juntar custo", Annotations: writeAnn(true), write: true,
		Description: "Junta um custo que não é de uma atividade (alojamento, seguro, compras…): de um dia (date) ou geral. " +
			"O custo de uma atividade vai na própria atividade (cost_pp ou cost_total).",
		InputSchema: schemaObj([]string{"trip_id", "label", "amount"}, with(costProps(), jsonObj{"trip_id": pStr(dTripID)})),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID string `json:"trip_id"`
				costIn
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			if in.Label == nil || in.Amount == nil {
				return nil, &toolError{"um custo precisa de label e amount"}
			}
			out, rev, err := s.editTrip(in.TripID, func(t jsonObj) (any, error) {
				c := jsonObj{"id": s.freshID("c", usedIDs(t, "costs")), "per": "total"}
				if err := s.applyCost(t, c, in.costIn); err != nil {
					return nil, err
				}
				setObjs(t, "costs", append(objs(t, "costs"), c))
				return costView(c), nil
			})
			if err != nil {
				return nil, err
			}
			return jsonObj{"trip_id": in.TripID, "rev": rev, "cost": out}, nil
		},
	},
	{
		Name: "update_cost", Title: "Mudar custo", Annotations: writeAnn(false), write: true,
		Description: "Muda um custo (só os campos enviados; date vazio passa-o a geral). Custos pagos não podem ser mudados.",
		InputSchema: schemaObj([]string{"trip_id", "cost_id"}, with(costProps(), jsonObj{"trip_id": pStr(dTripID), "cost_id": pStr("id do custo")})),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in struct {
				TripID string `json:"trip_id"`
				CostID string `json:"cost_id"`
				costIn
			}
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			out, rev, err := s.editTrip(in.TripID, func(t jsonObj) (any, error) {
				c, err := findCost(t, in.CostID)
				if err != nil {
					return nil, err
				}
				if err := checkCostEditable(c); err != nil {
					return nil, err
				}
				if err := s.applyCost(t, c, in.costIn); err != nil {
					return nil, err
				}
				return costView(c), nil
			})
			if err != nil {
				return nil, err
			}
			return jsonObj{"trip_id": in.TripID, "rev": rev, "cost": out}, nil
		},
	},
	{
		Name: "undo_last_ai_change", Title: "Desfazer a última alteração da IA", Annotations: writeAnn(false), write: true,
		Description: "Volta a pôr a viagem como estava antes da última alteração feita por uma ferramenta da IA. Chamar outra vez desfaz a anterior. " +
			"Recusa se o utilizador mudou a viagem depois (aí o Desfazer é na página).",
		InputSchema: schemaObj([]string{"trip_id"}, jsonObj{"trip_id": pStr(dTripID)}),
		run: func(s *server, args json.RawMessage) (any, error) {
			var in tripRef
			if err := decodeArgs(args, &in); err != nil {
				return nil, err
			}
			if !tripIDRe.MatchString(in.TripID) {
				return nil, &toolError{"identificador de viagem inválido: " + in.TripID}
			}
			rev, err := s.undoAI(in.TripID)
			if err != nil {
				return nil, err
			}
			return jsonObj{"trip_id": in.TripID, "rev": rev, "undone": true}, nil
		},
	},
}

// blockEdit muda a atividade id da viagem tripID com fn, se não for protegida, e devolve-a como blockView.
func (s *server) blockEdit(tripID, id string, fn func(t, b jsonObj, inTray bool) error) (any, error) {
	out, rev, err := s.editTrip(tripID, func(t jsonObj) (any, error) {
		b, inTray, err := mustBlock(t, id)
		if err != nil {
			return nil, err
		}
		if err := checkBlockEditable(b); err != nil {
			return nil, err
		}
		if err := fn(t, b, inTray); err != nil {
			return nil, err
		}
		return blockView(t, b), nil
	})
	if err != nil {
		return nil, err
	}
	return jsonObj{"trip_id": tripID, "rev": rev, "activity": out}, nil
}

// visibleTools: as ferramentas do tools/list. Em modo só de leitura, as que escrevem ficam de fora.
func (s *server) visibleTools() []*mcpTool {
	out := []*mcpTool{}
	for _, t := range mcpTools {
		if !t.write || !s.cfg.mcpReadOnly {
			out = append(out, t)
		}
	}
	return out
}

func (s *server) findTool(name string) *mcpTool {
	for _, t := range mcpTools {
		if t.Name == name {
			return t
		}
	}
	return nil
}
