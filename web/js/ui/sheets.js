/* Painéis laterais (editor, dia, viagem, custos, avisos): fechar. */
import { $ } from './dom.js';
import { S } from '../state.js';

export function closeSheets(){ ['editor','daysheet','tripsheet','warnings','costsheet'].forEach(id=>$('#'+id).hidden=true); S.editingId=null; S.dayOpen=null; }
export function initSheets(){
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{ const id=b.dataset.close; $('#'+id).hidden=true; if(id==='editor') S.editingId=null; if(id==='daysheet') S.dayOpen=null; }));
}
