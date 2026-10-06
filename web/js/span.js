/* Tempo absoluto no quadro, sem DOM (testado em Node).
   Uma atividade guarda `date` + `start` (minutos desde a meia-noite desse dia) + `len`,
   mas pode durar mais de um dia e cair fora do horário visível. Aqui convertemos para
   minutos desde a meia-noite do primeiro dia da viagem e cortamos em pedaços por coluna.
   A coluna i mostra o intervalo [i*1440+from, i*1440+to) (ver boardHours). O resto é tempo escondido.

   Escalas de tempo (os comentários de cada função dizem qual usam):
   - horas: Trip.dayStart e Trip.dayEnd (0–23).
   - minutos do dia: Block.start, desde a meia-noite de Block.date; pode passar de 1440 (madrugada do dia seguinte).
   - minutos absolutos: desde a meia-noite de Trip.start, o 1.º dia da viagem (absStart). Somam-se e comparam-se
     sem olhar para datas.
   - minutos absolutos do quadro: os absolutos + shiftMin, desde a meia-noite da 1.ª coluna do quadro
     (frame.firstDate). Iguais aos absolutos quando o quadro está na hora da viagem (shiftMin = 0).
   - minutos da coluna: top/bot de segments, desde o início visível da coluna (from), não desde a meia-noite.
   - offsetMin: diferença entre dois fusos, em minutos (positiva quando o outro fuso está à frente). */

/** @typedef {import('./clean.js').Trip} Trip */
/** @typedef {import('./clean.js').Block} Block */
/** @typedef {import('./clean.js').ISODate} ISODate */

const DAY = 1440;
/** Máximo de dias de uma viagem. O formulário só aceita 60 (MAX_DAYS em tripform.js); este limite protege
   dos dados feitos à mão ou malformados (uma data de fim no ano 9999 não pode encher o quadro). */
export const MAX_TRIP_DATES = 120;
/* Datas em UTC: para contar dias (dayIndex, addISO) sem os saltos da mudança de hora, em que um dia local tem 23 ou 25 h.
   util.js tem a outra convenção, parseISO em hora local, para o dia da semana e os rótulos. */
const utc = s => { const [y,m,d] = s.split('-').map(Number); return Date.UTC(y, m-1, d); };

/**
 * Horário do quadro: começa em from e acaba em to, span minutos depois.
 * @param {Trip} t
 * @returns {{from: number, span: number, to: number}} minutos do dia; to passa de 1440 quando o quadro acaba
 *   depois da meia-noite, e span vai de 60 a 1440 (dayStart = dayEnd é um dia inteiro)
 */
export function boardHours(t){ const from=t.dayStart*60; const span=(((t.dayEnd - t.dayStart)+24)%24 || 24)*60; return {from, span, to:from+span}; }
/**
 * @param {Trip} t
 * @param {ISODate} date
 * @returns {number} dias desde t.start (0 no primeiro dia, negativo antes dele)
 */
export function dayIndex(t, date){ return Math.round((utc(date) - utc(t.start)) / 864e5); }
/**
 * @param {Trip} t
 * @param {Block} b  no quadro (com date e start)
 * @returns {number} início de b em minutos absolutos (desde a meia-noite de t.start)
 */
export function absStart(t, b){ return dayIndex(t, b.date)*DAY + b.start; }
/** Data s mais n dias: addISO('2027-07-31', 1) → '2027-08-01'.
    @type {(s: ISODate, n: number) => ISODate} */
export const addISO = (s, n) => new Date(utc(s) + n*864e5).toISOString().slice(0,10);

/** Quadro noutro fuso. O quadro começa à meia-noite do dia firstDate desse fuso e
   shiftMin = minutos a somar ao tempo absoluto da viagem para ter o tempo absoluto do quadro
   (offsetMin = quanto o fuso do quadro está à frente da hora da viagem). Na hora da viagem, shiftMin=0.
   @param {Trip} t
   @param {number} offsetMin  minutos que o fuso do quadro está à frente da hora da viagem
   @param {ISODate} firstDate  primeira coluna do quadro, no fuso do quadro
   @returns {number} shiftMin, em minutos */
export function frameShift(t, offsetMin, firstDate){ return offsetMin - dayIndex(t, firstDate)*DAY; }
/** Dia e hora em que a atividade aparece no quadro (dia firstDate+i, start em [from, from+1440)).
   @param {Trip} t
   @param {Block} b  no quadro
   @param {number} shiftMin  minutos (ver frameShift)
   @param {ISODate} firstDate  primeira coluna do quadro
   @returns {{date: ISODate, start: number}} coluna do quadro e minutos do dia nessa coluna */
export function toFrame(t, b, shiftMin, firstDate){
  const {from}=boardHours(t), X=absStart(t,b)+shiftMin, i=Math.floor((X-from)/DAY);
  return {date:addISO(firstDate, i), start:X-i*DAY};
}
/** O contrário: dia e hora do quadro → date/start guardados na hora da viagem.
   Fica na coluna onde a hora da viagem a mostra; se cair nas horas escondidas depois do fim
   do quadro, fica como hora normal do dia seguinte (06:00 de dia 12, não 30:00 de dia 11).
   @param {Trip} t
   @param {ISODate} date  coluna do quadro
   @param {number} start  minutos do dia nessa coluna (hora do quadro)
   @param {number} shiftMin  minutos (ver frameShift)
   @param {ISODate} firstDate  primeira coluna do quadro
   @returns {{date: ISODate, start: number}} Block.date e Block.start a guardar (hora da viagem) */
export function fromFrame(t, date, start, shiftMin, firstDate){
  const {from, to}=boardHours(t), A=Math.round((utc(date)-utc(firstDate))/864e5)*DAY + start - shiftMin;
  let i=Math.floor((A-from)/DAY), s=A-i*DAY;
  if(s>=to && s>=DAY){ i++; s-=DAY; }
  return {date:addISO(t.start, i), start:s};
}

/** Coluna e hora para um instante absoluto. Cada dia do quadro vai da hora from até à hora from do dia
   seguinte, por isso a 01:00 de uma noite fica no dia anterior (start ≥ 1440).
   @param {Trip} t
   @param {number} abs  minutos absolutos do quadro
   @param {number} n  quantas colunas tem o quadro: a coluna fica em [0, n-1]
   @returns {{i: number, start: number}} índice da coluna e minutos do dia nessa coluna (≥ 0) */
export function slotAt(t, abs, n){
  const {from}=boardHours(t); const i=Math.max(0, Math.min(n-1, Math.floor((abs-from)/DAY)));
  return {i, start:Math.max(0, abs-i*DAY)};
}
/** O mesmo sem limitar às colunas da viagem: date/start a guardar para um instante absoluto.
   Antes do início do quadro (from) no primeiro dia fica no dia da viagem (06:00 de dia 1, não 30:00 do dia anterior),
   para não aparecer o aviso "fora das datas" a uma atividade que está dentro delas.
   @param {Trip} t
   @param {number} abs  minutos absolutos (hora da viagem)
   @returns {{date: ISODate, start: number}} Block.date e Block.start a guardar */
export function dateAt(t, abs){
  const {from}=boardHours(t), i=Math.max(Math.floor((abs-from)/DAY), Math.min(0, Math.floor(abs/DAY)));
  return {date:addISO(t.start, i), start:abs-i*DAY};
}

/**
 * Pedaço visível de uma atividade numa coluna do quadro.
 * @typedef {object} Segment
 * @property {number} i        índice da coluna
 * @property {number} top      início, em minutos da coluna (desde from)
 * @property {number} bot      fim, em minutos da coluna (top < bot ≤ span)
 * @property {boolean} cutTop  começa antes (noutro dia ou nas horas escondidas): desenha-se a borda em zigue-zague
 * @property {boolean} cutBot  continua depois
 */
/**
 * Pedaços visíveis de uma atividade num quadro de n colunas.
 * @param {Trip} t
 * @param {Block} b  no quadro
 * @param {number} n  quantas colunas tem o quadro
 * @param {number} [shiftMin=0]  minutos (ver frameShift)
 * @returns {Segment[]} pela ordem das colunas; vazio se b fica toda nas horas escondidas ou fora do quadro
 */
export function segments(t, b, n, shiftMin=0){
  const {from, to}=boardHours(t); const A=absStart(t,b)+shiftMin, B=A+b.len, out=[];
  const j0=Math.max(0, Math.floor((A-to)/DAY)), j1=Math.min(n-1, Math.floor((B-from)/DAY));
  for(let j=j0; j<=j1; j++){
    const W0=j*DAY+from, W1=j*DAY+to;
    if(A<W1 && B>W0) out.push({i:j, top:Math.max(A,W0)-W0, bot:Math.min(B,W1)-W0, cutTop:A<W0, cutBot:B>W1});
  }
  return out;
}

/** Atividade toda escondida: em que coluna e em que ponta (top/bot) mostrar a marca.
   Fica na ponta visível mais próxima no tempo. null se tem alguma parte visível.
   @param {Trip} t
   @param {Block} b  no quadro
   @param {number} n  quantas colunas tem o quadro
   @param {number} [shiftMin=0]  minutos (ver frameShift)
   @returns {{i: number, edge: 'top'|'bot'} | null} */
export function hiddenEdge(t, b, n, shiftMin=0){
  if(segments(t,b,n,shiftMin).length) return null;
  const {from, to}=boardHours(t); const A=absStart(t,b)+shiftMin, B=A+b.len;
  const k=Math.floor((A-from)/DAY);            // a falha depois da coluna k contém a atividade
  if(k<0) return {i:0, edge:'top'};
  if(k>=n-1) return {i:n-1, edge:'bot'};
  return (A-(k*DAY+to)) <= ((k+1)*DAY+from-B) ? {i:k, edge:'bot'} : {i:k+1, edge:'top'};
}

/** @typedef {object} Layout
    @property {Array<Array<Segment & {b: Block}>>} cols  pedaços de cada coluna, por top (e os mais longos primeiro)
    @property {Block[][]} top  por coluna: atividades escondidas com a marca no topo
    @property {Block[][]} bot  por coluna: as que têm a marca no fundo */
/** Distribui as atividades pelas colunas ds: pedaços visíveis em cols[i] (ordenados) e,
   para as que ficam todas escondidas, uma marca no topo ou no fundo de uma coluna.
   shiftMin≠0 quando o quadro está noutro fuso (ver frameShift); shiftMin também pode dar 0 noutro fuso
   (diferença de 24 h), por isso "está nas datas da viagem?" usa sempre as datas da viagem e não ds.
   @param {Trip} t
   @param {ISODate[]} ds  as colunas do quadro (tripDates, ou frame.dates noutro fuso)
   @param {number} [shiftMin=0]  minutos (ver frameShift)
   @returns {Layout} */
export function boardLayout(t, ds, shiftMin=0){
  const n=ds.length, cols=ds.map(()=>[]), top=ds.map(()=>[]), bot=ds.map(()=>[]), nd=Math.min(MAX_TRIP_DATES, dayIndex(t, t.end)+1);
  for(const b of t.blocks){
    for(const s of segments(t,b,n,shiftMin)) cols[s.i].push(Object.assign({b}, s));
    const d=dayIndex(t, b.date); if(!(d>=0 && d<nd)) continue;   // fora das datas: já há um aviso próprio
    const h=hiddenEdge(t,b,n,shiftMin); if(h) (h.edge==='top'?top:bot)[h.i].push(b);
  }
  for(const c of cols) c.sort((x,y)=>x.top-y.top||(y.bot-y.top)-(x.bot-x.top));
  return {cols, top, bot};
}

/** Quantas meias-noites a atividade atravessa desde que começa (o "+1" dos voos).
   @param {{start: number, len: number}} b  start em minutos do dia, len em minutos
   @returns {number} */
export function dayShift(b){ return Math.floor((b.start+b.len-1)/DAY) - Math.floor(b.start/DAY); }

/** Faixas lado a lado para os pedaços de uma coluna que se sobrepõem (segs ordenados por top, como em boardLayout).
   Um grupo é uma cadeia de pedaços sobrepostos; dentro dele, cada pedaço fica na primeira faixa livre.
   Devolve id da atividade → {lane, n}: a faixa e quantas faixas tem o seu grupo.
   @param {Array<Segment & {b: Block}>} segs  uma coluna de Layout.cols
   @returns {Map<string, {lane: number, n: number}>} lane de 0 a n-1; cada pedaço ocupa 1/n da largura */
export function laneLayout(segs){
  const res=new Map(); let group=[], end=-1;
  const flush=()=>{
    const lanes=[];   // onde acaba o último pedaço de cada faixa
    for(const s of group){
      let li=lanes.findIndex(e=>e<=s.top);
      if(li<0){ li=lanes.length; lanes.push(0); }
      lanes[li]=s.bot;
      res.set(s.b.id, {lane:li});
    }
    for(const s of group) res.get(s.b.id).n=lanes.length;
    group=[]; end=-1;
  };
  for(const s of segs){
    if(group.length && s.top>=end) flush();
    group.push(s);
    end=Math.max(end, s.bot);
  }
  if(group.length) flush();
  return res;
}
