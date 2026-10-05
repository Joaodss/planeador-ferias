/* Tempo absoluto no quadro, sem DOM (testado em Node).
   Uma atividade guarda `date` + `start` (minutos desde a meia-noite desse dia) + `len`,
   mas pode durar mais de um dia e cair fora do horário visível. Aqui convertemos para
   minutos desde a meia-noite do primeiro dia da viagem e cortamos em pedaços por coluna.
   A coluna i mostra o intervalo [i*1440+T0, i*1440+T1). O resto é tempo escondido. */

const DAY = 1440;
const utc = s => { const [y,m,d] = s.split('-').map(Number); return Date.UTC(y, m-1, d); };

export function view(t){ const T0=t.dayStart*60; const span=(((t.dayEnd - t.dayStart)+24)%24 || 24)*60; return {T0, span, T1:T0+span}; }
export function dayIndex(t, date){ return Math.round((utc(date) - utc(t.start)) / 864e5); }
export function absStart(t, b){ return dayIndex(t, b.date)*DAY + b.start; }
export const addISO = (s, n) => new Date(utc(s) + n*864e5).toISOString().slice(0,10);

/* Quadro noutro fuso. O quadro começa à meia-noite do dia d0 desse fuso e
   sh = minutos a somar ao tempo absoluto da viagem para ter o tempo absoluto do quadro
   (off = quanto o fuso do quadro está à frente da hora da viagem). Na hora da viagem, sh=0. */
export function frameShift(t, off, d0){ return off - dayIndex(t, d0)*DAY; }
/* Dia e hora em que a atividade aparece no quadro (dia d0+i, start em [T0, T0+1440)). */
export function toFrame(t, b, sh, d0){
  const {T0}=view(t), X=absStart(t,b)+sh, i=Math.floor((X-T0)/DAY);
  return {date:addISO(d0, i), start:X-i*DAY};
}
/* O contrário: dia e hora do quadro → date/start guardados na hora da viagem.
   Fica na coluna onde a hora da viagem a mostra; se cair nas horas escondidas depois do fim
   do quadro, fica como hora normal do dia seguinte (06:00 de dia 12, não 30:00 de dia 11). */
export function fromFrame(t, date, start, sh, d0){
  const {T0, T1}=view(t), A=Math.round((utc(date)-utc(d0))/864e5)*DAY + start - sh;
  let i=Math.floor((A-T0)/DAY), s=A-i*DAY;
  if(s>=T1 && s>=DAY){ i++; s-=DAY; }
  return {date:addISO(t.start, i), start:s};
}

/* Coluna e hora para um instante absoluto. Cada dia do quadro vai de T0 até T0 do dia
   seguinte, por isso a 01:00 de uma noite fica no dia anterior (start ≥ 1440). */
export function slotAt(t, abs, n){
  const {T0}=view(t); const i=Math.max(0, Math.min(n-1, Math.floor((abs-T0)/DAY)));
  return {i, start:Math.max(0, abs-i*DAY)};
}
/* O mesmo sem limitar às colunas da viagem: date/start a guardar para um instante absoluto.
   Antes do primeiro T0 da viagem fica no dia da viagem (06:00 de dia 1, não 30:00 do dia anterior),
   para não aparecer o aviso "fora das datas" a uma atividade que está dentro delas. */
export function dateAt(t, abs){
  const {T0}=view(t), i=Math.max(Math.floor((abs-T0)/DAY), Math.min(0, Math.floor(abs/DAY)));
  return {date:addISO(t.start, i), start:abs-i*DAY};
}

/* Pedaços visíveis de uma atividade num quadro de n colunas (sh: ver frameShift).
   top/bot em minutos desde T0 da coluna; cutTop/cutBot quando continua para fora. */
export function segments(t, b, n, sh=0){
  const {T0, T1}=view(t); const A=absStart(t,b)+sh, B=A+b.len, out=[];
  const j0=Math.max(0, Math.floor((A-T1)/DAY)), j1=Math.min(n-1, Math.floor((B-T0)/DAY));
  for(let j=j0; j<=j1; j++){
    const W0=j*DAY+T0, W1=j*DAY+T1;
    if(A<W1 && B>W0) out.push({i:j, top:Math.max(A,W0)-W0, bot:Math.min(B,W1)-W0, cutTop:A<W0, cutBot:B>W1});
  }
  return out;
}

/* Atividade toda escondida: em que coluna e em que ponta (top/bot) mostrar a marca.
   Fica na ponta visível mais próxima no tempo. null se tem alguma parte visível. */
export function hiddenEdge(t, b, n, sh=0){
  if(segments(t,b,n,sh).length) return null;
  const {T0, T1}=view(t); const A=absStart(t,b)+sh, B=A+b.len;
  const k=Math.floor((A-T0)/DAY);              // a falha depois da coluna k contém a atividade
  if(k<0) return {i:0, edge:'top'};
  if(k>=n-1) return {i:n-1, edge:'bot'};
  return (A-(k*DAY+T1)) <= ((k+1)*DAY+T0-B) ? {i:k, edge:'bot'} : {i:k+1, edge:'top'};
}

/* Distribui as atividades pelas colunas ds: pedaços visíveis em cols[i] (ordenados) e,
   para as que ficam todas escondidas, uma marca no topo ou no fundo de uma coluna.
   sh≠0 quando o quadro está noutro fuso (ver frameShift); sh também pode dar 0 noutro fuso
   (diferença de 24 h), por isso "está nas datas da viagem?" usa sempre as datas da viagem e não ds. */
export function boardLayout(t, ds, sh=0){
  const n=ds.length, cols=ds.map(()=>[]), top=ds.map(()=>[]), bot=ds.map(()=>[]), nd=Math.min(120, dayIndex(t, t.end)+1);
  for(const b of t.blocks){
    for(const s of segments(t,b,n,sh)) cols[s.i].push(Object.assign({b}, s));
    const d=dayIndex(t, b.date); if(!(d>=0 && d<nd)) continue;   // fora das datas: já há um aviso próprio
    const h=hiddenEdge(t,b,n,sh); if(h) (h.edge==='top'?top:bot)[h.i].push(b);
  }
  for(const c of cols) c.sort((x,y)=>x.top-y.top||(y.bot-y.top)-(x.bot-x.top));
  return {cols, top, bot};
}

/* Quantas meias-noites a atividade atravessa desde que começa (o "+1" dos voos). */
export function dayShift(b){ return Math.floor((b.start+b.len-1)/DAY) - Math.floor(b.start/DAY); }
