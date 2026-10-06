/* Para onde vai uma atividade movida no quadro, com as setas ou a arrastar.
   As contas fazem-se na hora do quadro (frame = boardFrame(t), que pode ser o segundo fuso) e o resultado
   vem na hora da viagem (date/start, o que se guarda) e também na hora do quadro (boardDate/boardStart, o que se mostra).
   Módulo sem DOM (testado em tests/moves.test.mjs); ui/board.js e ui/drag.js leem o rato e o teclado. */
import { SNAP, parseISO } from './util.js';
import { boardHours, toBoard, fromBoard } from './trip.js';
import { absStart, slotAt } from './span.js';

const DAY = 1440;

/* Minuto absoluto do quadro (desde a meia-noite da 1.ª coluna) minute minutos abaixo do topo da coluna do dia date. */
export function boardTime(t, frame, date, minute){ return frame.dates.indexOf(date)*DAY + boardHours(t).from + minute; }

/* Setas: ↑/↓ mudam a hora 15 min dentro do horário visível (para a atividade não sair do ecrã e perder o foco),
   ←/→ mudam de coluna; com shift, ↑/↓ mudam a duração (sem limite: pode passar para o dia seguinte).
   Devolve {date, start, len, boardDate, boardStart}, ou null se não muda (no limite, bloqueada ou por agendar). */
export function keyMove(t, frame, b, key, shift){
  if(b.locked || !b.date) return null;
  const hours=boardHours(t), ds=frame.dates;
  let {date, start}=toBoard(t,frame,b), len=b.len;
  const di=ds.indexOf(date);
  if(shift){
    if(key==='ArrowDown') len+=SNAP;
    else if(key==='ArrowUp' && len>SNAP) len-=SNAP;
    else return null;
    return {date:b.date, start:b.start, len, boardDate:date, boardStart:start};
  }
  if(key==='ArrowUp' && start>hours.from) start-=SNAP;
  else if(key==='ArrowDown' && start+SNAP<hours.to) start+=SNAP;
  else if(key==='ArrowLeft' && di>0) date=ds[di-1];
  else if(key==='ArrowRight' && di>=0 && di<ds.length-1) date=ds[di+1];
  else return null;
  return {...fromBoard(t,frame,date,start), len, boardDate:date, boardStart:start};
}

/* Largar a atividade na coluna colDate, minute minutos abaixo do topo, agarrada grab minutos depois do início.
   Arredonda a 15 min e pode ir parar a outra coluna (quem agarra pelo fundo e larga no topo de um dia).
   Devolve {date, start} (hora da viagem) e {boardDate, boardStart} (hora do quadro). */
export function dropSlot(t, frame, colDate, minute, grab){
  const raw=boardTime(t,frame,colDate,minute)-grab;
  const slot=slotAt(t, Math.round(raw/SNAP)*SNAP, frame.dates.length);
  const boardDate=frame.dates[slot.i], boardStart=slot.start;
  return {...fromBoard(t,frame,boardDate,boardStart), boardDate, boardStart};
}

/* Puxar a pega de baixo até minute minutos abaixo do topo da coluna colDate: a nova duração.
   O fim arredonda a 15 min, pode ir para outra coluna (a atividade passa a continuar no dia seguinte),
   fica pelo menos 15 min depois do início e não passa do fim do horário dessa coluna. */
export function resizeEnd(t, frame, b, colDate, minute){
  const hours=boardHours(t), j=frame.dates.indexOf(colDate), A=absStart(t,b)+frame.shiftMin;
  const end=j*DAY+hours.from+Math.round(minute/SNAP)*SNAP;
  return Math.max(A+SNAP, Math.min(j*DAY+hours.to, end)) - A;
}

/* A atividade b em date choca com os dias da semana em que acontece ou com o sítio desse dia? (aviso ao arrastar) */
export function clashesOn(t, b, date){
  const wd=parseISO(date).getDay(), dp=t.dayPlaces[date]||[];
  if(b.weekdays && b.weekdays.length && !b.weekdays.includes(wd)) return true;
  return !!(b.place && dp.length && !dp.includes(b.place));
}
