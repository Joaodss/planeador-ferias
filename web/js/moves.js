/* Para onde vai uma atividade movida no quadro, com as setas ou a arrastar.
   As contas fazem-se na hora do quadro (F = boardFrame(t), que pode ser o segundo fuso) e o resultado
   vem na hora da viagem (date/start, o que se guarda) e também na hora do quadro (bd/bs, o que se mostra).
   Módulo sem DOM (testado em tests/moves.test.mjs); ui/board.js e ui/drag.js leem o rato e o teclado. */
import { SNAP, parseISO } from './util.js';
import { view, toBoard, fromBoard } from './trip.js';
import { absStart, slotAt } from './span.js';

const DAY = 1440;

/* Minuto absoluto do quadro (desde a meia-noite da 1.ª coluna) minute minutos abaixo do topo da coluna do dia date. */
export function boardTime(t, F, date, minute){ return F.ds.indexOf(date)*DAY + view(t).T0 + minute; }

/* Setas: ↑/↓ mudam a hora 15 min dentro do horário visível (para a atividade não sair do ecrã e perder o foco),
   ←/→ mudam de coluna; com shift, ↑/↓ mudam a duração (sem limite: pode passar para o dia seguinte).
   Devolve {date, start, len, bd, bs}, ou null se não muda (no limite, bloqueada ou por agendar). */
export function keyMove(t, F, b, key, shift){
  if(b.locked || !b.date) return null;
  const v=view(t), ds=F.ds;
  let {date, start}=toBoard(t,F,b), len=b.len;
  const di=ds.indexOf(date);
  if(shift){
    if(key==='ArrowDown') len+=SNAP;
    else if(key==='ArrowUp' && len>SNAP) len-=SNAP;
    else return null;
    return {date:b.date, start:b.start, len, bd:date, bs:start};
  }
  if(key==='ArrowUp' && start>v.T0) start-=SNAP;
  else if(key==='ArrowDown' && start+SNAP<v.T1) start+=SNAP;
  else if(key==='ArrowLeft' && di>0) date=ds[di-1];
  else if(key==='ArrowRight' && di>=0 && di<ds.length-1) date=ds[di+1];
  else return null;
  return {...fromBoard(t,F,date,start), len, bd:date, bs:start};
}

/* Largar a atividade na coluna colDate, minute minutos abaixo do topo, agarrada grab minutos depois do início.
   Arredonda a 15 min e pode ir parar a outra coluna (quem agarra pelo fundo e larga no topo de um dia).
   Devolve {date, start} (hora da viagem) e {bd, bs} (hora do quadro). */
export function dropSlot(t, F, colDate, minute, grab){
  const raw=boardTime(t,F,colDate,minute)-grab;
  const slot=slotAt(t, Math.round(raw/SNAP)*SNAP, F.ds.length);
  const bd=F.ds[slot.i], bs=slot.start;
  return {...fromBoard(t,F,bd,bs), bd, bs};
}

/* Puxar a pega de baixo até minute minutos abaixo do topo da coluna colDate: a nova duração.
   O fim arredonda a 15 min, pode ir para outra coluna (a atividade passa a continuar no dia seguinte),
   fica pelo menos 15 min depois do início e não passa do fim do horário dessa coluna. */
export function resizeEnd(t, F, b, colDate, minute){
  const v=view(t), j=F.ds.indexOf(colDate), A=absStart(t,b)+F.sh;
  const end=j*DAY+v.T0+Math.round(minute/SNAP)*SNAP;
  return Math.max(A+SNAP, Math.min(j*DAY+v.T1, end)) - A;
}

/* A atividade b em date choca com os dias da semana em que acontece ou com o sítio desse dia? (aviso ao arrastar) */
export function clashesOn(t, b, date){
  const wd=parseISO(date).getDay(), dp=t.dayPlaces[date]||[];
  if(b.weekdays && b.weekdays.length && !b.weekdays.includes(wd)) return true;
  return !!(b.place && dp.length && !dp.includes(b.place));
}
