/* Traduções (PT e EN).
   Cada texto tem uma chave. O valor pode ser texto com {marcadores}, uma lista
   ou uma função (para plurais e frases que mudam de ordem entre línguas).
   No HTML: data-i18n (texto), data-i18n-ph (placeholder), data-i18n-title, data-i18n-aria. */
const pl = (n, one, many) => n===1 ? one : many;

const pt = {
  appName:'Planeador de Férias',
  wd:['Dom','2ª','3ª','4ª','5ª','6ª','Sáb'],
  wdLong:['domingo','segunda','terça','quarta','quinta','sexta','sábado'],
  mon:['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'],
  onDay: p => (p.w===0||p.w===6?'ao ':'à ')+pt.wdLong[p.w],
  and:'e',
  cats:{tour:'Passeio', party:'Festa', transport:'Transporte', food:'Refeição', rest:'Livre', sleep:'Sono'},
  status:{ideia:'ideia', reservar:'por reservar', reservado:'reservado', pago:'pago'},
  defaultCats:{alojamento:'Alojamento', transporte:'Transportes', alimentacao:'Alimentação', atividades:'Atividades', festas:'Festas e saídas', compras:'Compras', outros:'Outros'},

  langSwitch:'English', langSwitchTitle:'Mudar para inglês',
  close:'Fechar', cancel:'Cancelar', del:'Apagar', add:'Adicionar', save:'Guardar', remove:'Remover', untitled:'Sem nome',
  perPerson:'Por pessoa', perPersonLower:'por pessoa', total:'Total', totalFor:'Para {n}', toBook:'Por reservar',
  checking:'A verificar…', loading:'A carregar…', chooseTrip:'Escolher viagem',

  // barra de ferramentas
  undo:'Desfazer', undoTitle:'Desfazer (Ctrl/⌘+Z)', newActivity:'Nova atividade', datesPlaces:'Datas e sítios', costs:'Custos',
  showSleep:'Mostrar sono', exportExcel:'Exportar Excel', backup:'Cópia de segurança', backupTitle:'Descarrega todas as viagens num ficheiro',
  import:'Importar', importTitle:'Junta as viagens de uma cópia de segurança', logout:'Sair', legend:'Legenda',
  legTour:'Passeios', legParty:'Festas', legTransport:'Transportes', legFood:'Refeições', legRest:'Livre', legSleep:'Sono',
  trayAria:'Atividades por agendar', unscheduled:'Por agendar', unscheduledLower:'por agendar',
  trayHint:'Ideias ainda sem dia. Arrasta daqui para a grelha, ou da grelha para aqui.', trayEmpty:'Nada por agendar.',

  // editor de atividade
  activity:'Atividade', fName:'Nome', fDay:'Dia', fStart:'Começa', fLen:'Duração', fType:'Tipo',
  catTour:'Passeio', catParty:'Festa', catTransport:'Transporte', catFood:'Refeição', catRest:'Livre / descanso', catSleep:'Sono',
  fStatus:'Estado', stNone:'Sem estado', stIdea:'Ideia', stToBook:'Por reservar', stBooked:'Reservado', stPaid:'Pago',
  fPlace:'Onde acontece', costPP:'Custo por pessoa', costTotal:'Custo total', costPPCur:'Custo por pessoa ({cur})', costTotalCur:'Custo total ({cur})',
  costCat:'Categoria de custo', onlyOn:'Só acontece em',
  wdHint:'Deixa tudo desmarcado se acontece em qualquer dia. Se marcares dias, avisa quando a puseres num dia em que não existe.',
  fAddress:'Morada ou ponto de encontro', fLink:'Link (site, reserva, mapa)', fRef:'Referência da reserva', fNote:'Notas',
  fLock:'Fixo (não arrasta sem querer)', duplicate:'Duplicar', toTray:'Mover para "por agendar"', delActivityQ:'Apagar esta atividade?',
  editorHint:'No quadro: arrasta para mudar de dia ou hora (no telemóvel, carrega uns instantes antes de arrastar). Puxa a borda de baixo para mudar a duração. Com o teclado: setas movem 15 min ou um dia, Shift+setas mudam a duração.',
  anywhere:'Em qualquer sítio', afterMidnight:' (madrugada)', outsideBoard:' (fora do quadro)', autoCat:'Automática: {name}', openLink:'Abrir link ↗',

  // dia
  day:'Dia', dPlace:'Onde estão', dPlace2:'Mudam durante o dia para', dUntil:'Aplicar também aos dias seguintes até', savePlace:'Guardar sítio',
  newPlace:'Novo sítio', newPlacePh:'Ex.: Lisboa, Hotel X, Algarve', dayCosts:'Custos do dia', addCost:'Adicionar custo',
  dayActivities:'Atividades deste dia', newActivityDay:'Nova atividade neste dia', noPlace:'— sem sítio —', noChange:'Não mudam',
  justThisDay:'Só este dia', dayEmpty:'Ainda não há nada neste dia.',

  // viagem
  trip:'Viagem', tName:'Nome da viagem', tNamePh:'Ex.: Açores 2027', tEnd:'Acaba', tDayStart:'O quadro começa às', tDayEnd:'E vai até às',
  tTz:'Fuso horário da viagem', tTzPh:'Ex.: Asia/Tokyo', tHomeTz:'Segundo fuso (neste dispositivo)', homeTzDefault:'Por omissão: {tz}',
  tzHint:'As horas do quadro são a hora local da viagem. Quando o segundo fuso é diferente, aparece numa coluna de horas ao lado. Clica no nome de uma cidade, no canto da grelha, para ver o quadro na hora dela.',
  errTz:'Não reconheço o fuso "{v}". Escolhe um da lista (ex.: Europe/Lisbon, Asia/Tokyo).',
  tzRoute:'hora de {city}', secAt:'Em {city}: {range}', prevDay:' (dia anterior)', nextDay:' (dia seguinte)',
  viewIn:'Ver o quadro na hora de {city}', viewingIn:'O quadro está na hora de {city}', tzDatesNote:'sítios e custos do dia pelas datas de {city}', outsideTrip:'Fora da viagem',
  people:'Pessoas', currency:'Moeda', budgetOpt:'Orçamento total da viagem (opcional)', budgetPh:'Ex.: 4000',
  places:'Sítios', placesHint:'Os sítios onde vão estar (cidades, ilhas, hotéis). Atribui-os aos dias clicando no cabeçalho de cada dia.',
  costCats:'Categorias de custo', costCatsHint:'As categorias em que os custos são somados no resumo. Podes mudar os nomes, remover ou criar novas.',
  newCat:'Nova categoria', otherActions:'Outras ações', dupTrip:'Duplicar viagem', delTrip:'Apagar viagem', delTripQ:'Apagar esta viagem e todas as atividades?',
  newTrip:'Nova viagem', createTrip:'Criar viagem', noPlaces:'Ainda não há sítios.', placeNameAria:'Nome do sítio', catNameAria:'Nome da categoria', noCats:'Sem categorias.',

  // custos
  byCat:'Por categoria', byDay:'Por dia', generalCosts:'Custos gerais', addGeneralCost:'Adicionar custo geral',
  costsHint:'Os valores do resumo são totais para o grupo. As atividades em "Por agendar" não entram nas contas. Sem categoria escolhida, uma atividade usa a do seu tipo (um passeio conta como Atividades, uma refeição como Alimentação).',
  noCat:'Sem categoria', noDesc:'Sem descrição', general:'Geral', generalPl:'Gerais',
  noGeneralCosts:'Sem custos gerais. Serve para o que não pertence a um dia: voos, seguro, vistos.',
  noDayCosts:'Sem custos neste dia. Serve para alojamento, refeições ou outros gastos que não são uma atividade.',
  costDescPh:'Descrição (ex.: hotel)', costDescAria:'Descrição do custo', costAmountAria:'Valor em {cur}', costPerAria:'Valor total ou por pessoa',
  perTotal:'total', paid:'Pago', paidMark:'✓ pago', removeCost:'Remover este custo',
  alreadyPaid:'Já pago', toPay:'Por pagar', budget:'Orçamento', overBudget:'Acima do orçamento em {x}', left:'Sobram {x}',
  budgetUsedAria:'{pct}% do orçamento usado', budgetUsed:'{pct}% usado', budgetPP: p => `${p.x} por pessoa ${p.over?'a mais':'de margem'}`,
  budgetHint:'Define um orçamento em "Datas e sítios" para ver aqui quanto sobra.',
  noCosts:'Ainda não há custos. Põe um valor numa atividade ou acrescenta custos a um dia.',
  openDay:'Abrir o dia',

  // avisos
  review:'Pontos a rever', noConflicts:'Sem conflitos', nToReview: p => `${p.n} ${pl(p.n,'ponto','pontos')} a rever`,
  nWarnings: p => `${p.n} ${pl(p.n,'aviso','avisos')}`,
  warnOk:'Nada sobreposto. Todas as atividades estão nos dias em que acontecem e no sítio onde vão estar.',
  warnHint:'Vermelho: sobreposições, dias em que o evento não existe ou atividade no sítio errado. Âmbar: sono cortado, noite longa antes de um compromisso cedo, ou fora do horário do quadro.',
  wSleep:'{a} entra no sono', wOverlap:'{a} e {b} ao mesmo tempo', wWeekday:'{a} não acontece {day}',
  wWeekdayD:'Só acontece {days}. Dias possíveis nesta viagem: {ok}.', none:'nenhum',
  wPlace:'{a} é em {place}', wPlaceD:'{day}: estão em {places}.',
  wHours:'{a} fica fora do horário do quadro', wHoursD:'Começa às {time}. Alarga o horário em "Datas e sítios" ou muda a hora.',
  wNight:'Noite longa antes de {b}', wNightD:'{a} acaba às {t1} e {b} começa às {t2} de {day}.',
  wDates:'{a} está fora das datas da viagem', wDatesD:'Está marcada para {date}. Abre-a e escolhe outro dia.',
  seeWarnings:' · ver avisos',

  // quadro
  switchTrip:'Trocar de viagem', trips:'Viagens', openMark:' (aberta)', newTripOpt:'+ Nova viagem…',
  emptyH:'Cria a primeira viagem', emptyP:'Escolhe o nome e as datas de início e fim. Depois vais acrescentando atividades dentro do horário de cada dia.',
  importBackup:'Importar cópia de segurança', nDays:'{n} dias', clickDay:'clica num dia para dizer onde estão',
  whereClick:'Onde? Clica aqui', placesJoin:' para ',

  // guardar e sessão
  saving:'A guardar…', saveError:'Não foi possível guardar — a tentar de novo', unsaved:'Por guardar', allSaved:'Tudo guardado',
  loginHint:'Entra para ver e editar as tuas viagens.', user:'Utilizador', password:'Palavra-passe', signIn:'Entrar', signingIn:'A entrar…',
  offlineH:'Sem ligação', offlineP:'Não consegui falar com o servidor. Vou tentando de novo de 5 em 5 segundos.',
  errFill:'Escreve o utilizador e a palavra-passe.', errTooMany:'Demasiadas tentativas falhadas. Espera 10 minutos e tenta de novo.',
  errWrong:'Utilizador ou palavra-passe errados.', errServer:'Não consegui falar com o servidor. Tenta de novo.',

  // mensagens
  tConflict:'Esta viagem foi alterada noutro dispositivo. Carreguei a versão mais recente e a tua última alteração não foi guardada.',
  tTooBig:'Esta viagem ficou demasiado grande para guardar (limite de 2 MB). Encurta as notas mais longas.',
  undone:'Alteração desfeita', tRefreshed:'Atualizei com as alterações feitas noutro dispositivo.',
  tLogoutPending:'Ainda há alterações por guardar. Tenta sair daqui a pouco.',
  tLocked:'Esta atividade está marcada como fixa. Abre-a para desbloquear.', movedToTray:'{a} passou para "por agendar"',
  tDupActivity:'Cópia criada logo a seguir à original.', tDelActivity:'Atividade apagada. Usa Desfazer se foi engano.',
  tPlaceLastDay:'A mudança de sítio ficou no último dia escolhido.', placeSaved:'Sítio guardado',
  tPlaceAdded:'"{name}" adicionado. Carrega em Guardar sítio para o atribuir.',
  errTripName:'Dá um nome à viagem.', errTripDates:'Escolhe as datas de início e de fim.', errTripOrder:'A data de fim tem de ser igual ou depois da de início.',
  errTripLong:'São {n} dias. O limite é 60 dias por viagem.',
  tTripCreated:'Viagem criada. Clica no cabeçalho de um dia para dizer onde estão, ou faz duplo clique na grelha para criar uma atividade.',
  tOutOfDates: p => `${p.n} ${pl(p.n,'atividade ficou','atividades ficaram')} fora das novas datas e ${pl(p.n,'passou','passaram')} para "Por agendar".`,
  copySuffix:' (cópia)', tTripDup:'Viagem duplicada.', tTripDel:'"{name}" apagada. Usa Desfazer se foi engano.',
  tCatRemoved:'"{name}" removida. O que estava nessa categoria passa a "Sem categoria" ou à categoria automática do tipo.',
  tCatExists:'Já existe uma categoria com esse nome.',
  tExcelFail:'Não consegui carregar o módulo de Excel. Verifica a ligação à internet e tenta outra vez.',
  tBackup:'Cópia descarregada com todas as viagens.',
  tImported: p => `Importação feita: ${p.added} ${pl(p.added,'viagem nova','viagens novas')}${p.replaced?` e ${p.replaced} ${pl(p.replaced,'substituída','substituídas')}`:''}. Usa Desfazer se foi engano.`,
  tImportBad:'Este ficheiro não é uma cópia do planeador. Escolhe um ficheiro descarregado com "Cópia de segurança".',

  // Excel
  xMonths:['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'],
  xWeekdays:['DOMINGO','2F','3F','4F','5F','6F','SÁBADO'],
  xDay: p => `${p.d} DE ${p.m} - ${p.w}`, xAnd:'— e —', xPP:'PP',
  xPlan:'Plano', xDetails:'Detalhes', xCosts:'Custos',
  xHead:['Dia','Início','Fim','Atividade','Tipo','Onde','Estado','Categoria de custo','Custo pp','Custo total','Morada','Link','Reserva','Notas'],
  xCatHead:['Categoria','Total','Por pessoa','% do total'], xMargin:'Margem',
  xItemHead:['Dia','Descrição','Categoria','Total','Por pessoa','Pago'], xYes:'sim',
  xFile:'{name} - plano.xlsx',
};

const en = {
  appName:'Holiday Planner',
  wd:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],
  wdLong:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
  mon:['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
  onDay: p => 'on '+en.wdLong[p.w],
  and:'and',
  cats:{tour:'Tour', party:'Party', transport:'Transport', food:'Meal', rest:'Free time', sleep:'Sleep'},
  status:{ideia:'idea', reservar:'to book', reservado:'booked', pago:'paid'},
  defaultCats:{alojamento:'Accommodation', transporte:'Transport', alimentacao:'Food', atividades:'Activities', festas:'Parties & nights out', compras:'Shopping', outros:'Other'},

  langSwitch:'Português', langSwitchTitle:'Switch to Portuguese',
  close:'Close', cancel:'Cancel', del:'Delete', add:'Add', save:'Save', remove:'Remove', untitled:'Untitled',
  perPerson:'Per person', perPersonLower:'per person', total:'Total', totalFor:'For {n}', toBook:'To book',
  checking:'Checking…', loading:'Loading…', chooseTrip:'Choose trip',

  undo:'Undo', undoTitle:'Undo (Ctrl/⌘+Z)', newActivity:'New activity', datesPlaces:'Dates & places', costs:'Costs',
  showSleep:'Show sleep', exportExcel:'Export Excel', backup:'Backup', backupTitle:'Download all trips in one file',
  import:'Import', importTitle:'Merge the trips from a backup', logout:'Sign out', legend:'Legend',
  legTour:'Tours', legParty:'Parties', legTransport:'Transport', legFood:'Meals', legRest:'Free time', legSleep:'Sleep',
  trayAria:'Unscheduled activities', unscheduled:'Unscheduled', unscheduledLower:'unscheduled',
  trayHint:'Ideas without a day yet. Drag from here onto the grid, or from the grid back here.', trayEmpty:'Nothing unscheduled.',

  activity:'Activity', fName:'Name', fDay:'Day', fStart:'Starts', fLen:'Duration', fType:'Type',
  catTour:'Tour', catParty:'Party', catTransport:'Transport', catFood:'Meal', catRest:'Free time / rest', catSleep:'Sleep',
  fStatus:'Status', stNone:'No status', stIdea:'Idea', stToBook:'To book', stBooked:'Booked', stPaid:'Paid',
  fPlace:'Where it happens', costPP:'Cost per person', costTotal:'Total cost', costPPCur:'Cost per person ({cur})', costTotalCur:'Total cost ({cur})',
  costCat:'Cost category', onlyOn:'Only happens on',
  wdHint:'Leave everything unticked if it happens on any day. If you tick days, you get a warning when you put it on a day it doesn\'t happen.',
  fAddress:'Address or meeting point', fLink:'Link (website, booking, map)', fRef:'Booking reference', fNote:'Notes',
  fLock:'Locked (can\'t be dragged by accident)', duplicate:'Duplicate', toTray:'Move to "unscheduled"', delActivityQ:'Delete this activity?',
  editorHint:'On the board: drag to change day or time (on a phone, press and hold for a moment before dragging). Pull the bottom edge to change the duration. With the keyboard: arrows move 15 min or one day, Shift+arrows change the duration.',
  anywhere:'Anywhere', afterMidnight:' (after midnight)', outsideBoard:' (outside the board)', autoCat:'Automatic: {name}', openLink:'Open link ↗',

  day:'Day', dPlace:'Where you are', dPlace2:'During the day you move to', dUntil:'Also apply to the following days until', savePlace:'Save place',
  newPlace:'New place', newPlacePh:'E.g. Lisbon, Hotel X, Algarve', dayCosts:'Day costs', addCost:'Add cost',
  dayActivities:'Activities this day', newActivityDay:'New activity on this day', noPlace:'— no place —', noChange:'No change',
  justThisDay:'Just this day', dayEmpty:'Nothing on this day yet.',

  trip:'Trip', tName:'Trip name', tNamePh:'E.g. Azores 2027', tEnd:'Ends', tDayStart:'The board starts at', tDayEnd:'And goes until',
  tTz:'Trip time zone', tTzPh:'E.g. Asia/Tokyo', tHomeTz:'Second time zone (this device)', homeTzDefault:'Default: {tz}',
  tzHint:'Board times are the trip\'s local time. When the second time zone is different, it shows as an extra column of hours. Click a city name in the corner of the grid to see the board in its time.',
  errTz:'I don\'t recognise the time zone "{v}". Pick one from the list (e.g. Europe/London, Asia/Tokyo).',
  tzRoute:'{city} time', secAt:'In {city}: {range}', prevDay:' (day before)', nextDay:' (day after)',
  viewIn:'Show the board in {city} time', viewingIn:'The board is in {city} time', tzDatesNote:'day places and costs follow {city} dates', outsideTrip:'Outside the trip',
  people:'People', currency:'Currency', budgetOpt:'Total trip budget (optional)', budgetPh:'E.g. 4000',
  places:'Places', placesHint:'The places where you\'ll be (cities, islands, hotels). Assign them to days by clicking each day\'s header.',
  costCats:'Cost categories', costCatsHint:'The categories costs are added up into in the summary. You can rename, remove or create new ones.',
  newCat:'New category', otherActions:'Other actions', dupTrip:'Duplicate trip', delTrip:'Delete trip', delTripQ:'Delete this trip and all its activities?',
  newTrip:'New trip', createTrip:'Create trip', noPlaces:'No places yet.', placeNameAria:'Place name', catNameAria:'Category name', noCats:'No categories.',

  byCat:'By category', byDay:'By day', generalCosts:'General costs', addGeneralCost:'Add general cost',
  costsHint:'Summary amounts are totals for the group. Activities in "Unscheduled" are not counted. With no category chosen, an activity uses its type\'s one (a tour counts as Activities, a meal as Food).',
  noCat:'No category', noDesc:'No description', general:'General', generalPl:'General',
  noGeneralCosts:'No general costs. Use this for things that don\'t belong to a day: flights, insurance, visas.',
  noDayCosts:'No costs on this day. Use this for accommodation, meals or other expenses that aren\'t an activity.',
  costDescPh:'Description (e.g. hotel)', costDescAria:'Cost description', costAmountAria:'Amount in {cur}', costPerAria:'Total or per person',
  perTotal:'total', paid:'Paid', paidMark:'✓ paid', removeCost:'Remove this cost',
  alreadyPaid:'Already paid', toPay:'Still to pay', budget:'Budget', overBudget:'Over budget by {x}', left:'{x} left',
  budgetUsedAria:'{pct}% of the budget used', budgetUsed:'{pct}% used', budgetPP: p => `${p.x} per person ${p.over?'over':'to spare'}`,
  budgetHint:'Set a budget in "Dates & places" to see here how much is left.',
  noCosts:'No costs yet. Put an amount on an activity or add costs to a day.',
  openDay:'Open the day',

  review:'Things to review', noConflicts:'No conflicts', nToReview: p => `${p.n} ${pl(p.n,'thing','things')} to review`,
  nWarnings: p => `${p.n} ${pl(p.n,'warning','warnings')}`,
  warnOk:'Nothing overlaps. Every activity is on a day it happens and in the place where you\'ll be.',
  warnHint:'Red: overlaps, days the event doesn\'t happen or an activity in the wrong place. Amber: cut-short sleep, a late night before an early commitment, or outside the board hours.',
  wSleep:'{a} cuts into sleep', wOverlap:'{a} and {b} at the same time', wWeekday:'{a} doesn\'t happen {day}',
  wWeekdayD:'Only happens {days}. Possible days on this trip: {ok}.', none:'none',
  wPlace:'{a} is in {place}', wPlaceD:'{day}: you\'re in {places}.',
  wHours:'{a} is outside the board hours', wHoursD:'Starts at {time}. Widen the hours in "Dates & places" or change the time.',
  wNight:'Late night before {b}', wNightD:'{a} ends at {t1} and {b} starts at {t2} on {day}.',
  wDates:'{a} is outside the trip dates', wDatesD:'It\'s set for {date}. Open it and pick another day.',
  seeWarnings:' · see warnings',

  switchTrip:'Switch trip', trips:'Trips', openMark:' (open)', newTripOpt:'+ New trip…',
  emptyH:'Create your first trip', emptyP:'Choose the name and the start and end dates. Then add activities within each day\'s hours.',
  importBackup:'Import backup', nDays:'{n} days', clickDay:'click a day to say where you are',
  whereClick:'Where? Click here', placesJoin:' to ',

  saving:'Saving…', saveError:'Couldn\'t save — retrying', unsaved:'Not saved yet', allSaved:'All saved',
  loginHint:'Sign in to see and edit your trips.', user:'Username', password:'Password', signIn:'Sign in', signingIn:'Signing in…',
  offlineH:'No connection', offlineP:'Couldn\'t reach the server. Trying again every 5 seconds.',
  errFill:'Enter your username and password.', errTooMany:'Too many failed attempts. Wait 10 minutes and try again.',
  errWrong:'Wrong username or password.', errServer:'Couldn\'t reach the server. Try again.',

  tConflict:'This trip was changed on another device. I loaded the latest version and your last change was not saved.',
  tTooBig:'This trip got too big to save (2 MB limit). Shorten the longest notes.',
  undone:'Change undone', tRefreshed:'Updated with changes made on another device.',
  tLogoutPending:'There are still unsaved changes. Try signing out in a moment.',
  tLocked:'This activity is locked. Open it to unlock.', movedToTray:'{a} moved to "unscheduled"',
  tDupActivity:'Copy created right after the original.', tDelActivity:'Activity deleted. Use Undo if that was a mistake.',
  tPlaceLastDay:'The change of place was set on the last chosen day.', placeSaved:'Place saved',
  tPlaceAdded:'"{name}" added. Press Save place to assign it.',
  errTripName:'Give the trip a name.', errTripDates:'Choose the start and end dates.', errTripOrder:'The end date must be the same as or after the start date.',
  errTripLong:'That\'s {n} days. The limit is 60 days per trip.',
  tTripCreated:'Trip created. Click a day\'s header to say where you are, or double-click the grid to create an activity.',
  tOutOfDates: p => `${p.n} ${pl(p.n,'activity was','activities were')} outside the new dates and moved to "Unscheduled".`,
  copySuffix:' (copy)', tTripDup:'Trip duplicated.', tTripDel:'"{name}" deleted. Use Undo if that was a mistake.',
  tCatRemoved:'"{name}" removed. What was in that category becomes "No category" or the type\'s automatic category.',
  tCatExists:'A category with that name already exists.',
  tExcelFail:'Couldn\'t load the Excel module. Check your internet connection and try again.',
  tBackup:'Backup downloaded with all trips.',
  tImported: p => `Import done: ${p.added} new ${pl(p.added,'trip','trips')}${p.replaced?` and ${p.replaced} replaced`:''}. Use Undo if that was a mistake.`,
  tImportBad:'This file isn\'t a planner backup. Choose a file downloaded with "Backup".',

  xMonths:['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'],
  xWeekdays:['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'],
  xDay: p => `${p.w} ${p.d} ${p.m}`, xAnd:'— and —', xPP:'PP',
  xPlan:'Plan', xDetails:'Details', xCosts:'Costs',
  xHead:['Day','Start','End','Activity','Type','Where','Status','Cost category','Cost pp','Total cost','Address','Link','Booking','Notes'],
  xCatHead:['Category','Total','Per person','% of total'], xMargin:'Margin',
  xItemHead:['Day','Description','Category','Total','Per person','Paid'], xYes:'yes',
  xFile:'{name} - plan.xlsx',
};

const DICT = {pt, en}, KEY = 'ferias-lang';
let lang = null;
try{ lang = localStorage.getItem(KEY); }catch(e){}
if(!DICT[lang]) lang = /^pt\b/i.test(navigator.language||'') ? 'pt' : 'en';

function tr(k, p){
  let v = DICT[lang][k]; if(v===undefined) v = pt[k]; if(v===undefined) return k;
  if(typeof v==='function') return v(p||{});
  if(typeof v!=='string' || !p) return v;
  return v.replace(/\{(\w+)\}/g, (m,n) => n in p ? p[n] : m);
}
function apply(root){
  const r = root||document;
  r.querySelectorAll('[data-i18n]').forEach(el => el.textContent = tr(el.dataset.i18n));
  r.querySelectorAll('[data-i18n-ph]').forEach(el => el.placeholder = tr(el.dataset.i18nPh));
  r.querySelectorAll('[data-i18n-title]').forEach(el => el.title = tr(el.dataset.i18nTitle));
  r.querySelectorAll('[data-i18n-aria]').forEach(el => el.setAttribute('aria-label', tr(el.dataset.i18nAria)));
  document.documentElement.lang = lang==='pt' ? 'pt-PT' : 'en';
}
function set(l){
  if(!DICT[l]) return; lang = l;
  try{ localStorage.setItem(KEY, l); }catch(e){}
  apply();
}

export const I18N = {
  tr, apply, set, dicts: DICT,
  get lang(){ return lang; },
  get locale(){ return lang==='pt' ? 'pt-PT' : 'en-GB'; },
  other(){ return lang==='pt' ? 'en' : 'pt'; },
};
apply();

export { tr };
