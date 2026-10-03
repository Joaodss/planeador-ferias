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

/* Coluna e hora para um instante absoluto. Cada dia do quadro vai de T0 até T0 do dia
   seguinte, por isso a 01:00 de uma noite fica no dia anterior (start ≥ 1440). */
export function slotAt(t, abs, n){
  const {T0}=view(t); const i=Math.max(0, Math.min(n-1, Math.floor((abs-T0)/DAY)));
  return {i, start:Math.max(0, abs-i*DAY)};
}

/* Pedaços visíveis de uma atividade num quadro de n colunas.
   top/bot em minutos desde T0 da coluna; cutTop/cutBot quando continua para fora. */
export function segments(t, b, n){
  const {T0, T1}=view(t); const A=absStart(t,b), B=A+b.len, out=[];
  const j0=Math.max(0, Math.floor((A-T1)/DAY)), j1=Math.min(n-1, Math.floor((B-T0)/DAY));
  for(let j=j0; j<=j1; j++){
    const W0=j*DAY+T0, W1=j*DAY+T1;
    if(A<W1 && B>W0) out.push({i:j, top:Math.max(A,W0)-W0, bot:Math.min(B,W1)-W0, cutTop:A<W0, cutBot:B>W1});
  }
  return out;
}

/* Atividade toda escondida: em que coluna e em que ponta (top/bot) mostrar a marca.
   Fica na ponta visível mais próxima no tempo. null se tem alguma parte visível. */
export function hiddenEdge(t, b, n){
  if(segments(t,b,n).length) return null;
  const {T0, T1}=view(t); const A=absStart(t,b), B=A+b.len;
  const k=Math.floor((A-T0)/DAY);              // a falha depois da coluna k contém a atividade
  if(k<0) return {i:0, edge:'top'};
  if(k>=n-1) return {i:n-1, edge:'bot'};
  return (A-(k*DAY+T1)) <= ((k+1)*DAY+T0-B) ? {i:k, edge:'bot'} : {i:k+1, edge:'top'};
}

/* Quantas meias-noites a atividade atravessa desde que começa (o "+1" dos voos). */
export function dayShift(b){ return Math.floor((b.start+b.len-1)/DAY) - Math.floor(b.start/DAY); }
