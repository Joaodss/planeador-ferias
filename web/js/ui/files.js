/* Ficheiros: exportar Excel, cópia de segurança e importar. */
import { tr } from '../i18n.js';
import { newId } from '../util.js';
import { $, toast } from './dom.js';
import { S, T, setActive, pushHistory } from '../state.js';
import { planSheet, detailRows, costSheet, excelName } from '../excel.js';
import { backupName, backupJSON, parseBackup, mergeTrips } from '../backup.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';

function saveFile(name, blob){
  const u=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=u; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),2000);
}
/* A biblioteca do Excel só é carregada quando é precisa. */
let xlsxP=null;
function loadXLSX(){
  if(window.XLSX) return Promise.resolve(true);
  if(!xlsxP) xlsxP=new Promise(res=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload=()=>res(true); s.onerror=()=>{ xlsxP=null; s.remove(); res(false); }; document.head.appendChild(s); });
  return xlsxP;
}

/* Botões de exportar, cópia de segurança e importar (main.js chama-a uma vez ao arrancar). */
export function initFiles(){
  /* Excel: as folhas vêm de excel.js; aqui só se carrega o SheetJS e se descarrega o ficheiro. */
  $('#export').addEventListener('click', async ()=>{
    const t=T(); if(!t) return;
    if(!(await loadXLSX())){ toast(tr('tExcelFail')); return; }
    const XLSX=window.XLSX, wb=XLSX.utils.book_new();
    const plan=planSheet(t), ws=XLSX.utils.aoa_to_sheet(plan.aoa); ws['!merges']=plan.merges; ws['!cols']=plan.cols;
    XLSX.utils.book_append_sheet(wb,ws,tr('xPlan'));
    const ws2=XLSX.utils.aoa_to_sheet(detailRows(t)); ws2['!cols']=[14,7,7,34,11,16,12,18,9,10,24,30,14,40].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb,ws2,tr('xDetails'));
    const ws3=XLSX.utils.aoa_to_sheet(costSheet(t)); ws3['!cols']=[18,36,20,10,11,11].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb,ws3,tr('xCosts'));
    const out=XLSX.write(wb,{bookType:'xlsx',type:'array'});
    saveFile(excelName(t), new Blob([out],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  });

  /* cópia de segurança e importar (backup.js) */
  $('#backup').addEventListener('click',()=>{
    saveFile(backupName(new Date()), new Blob([backupJSON(S.store.trips, Date.now())],{type:'application/json'}));
    toast(tr('tBackup'));
  });
  $('#import').addEventListener('click',()=>$('#import-file').click());
  $('#import-file').addEventListener('change', async e=>{
    const f=e.target.files[0]; e.target.value=''; if(!f) return;
    let trips; try{ trips=parseBackup(await f.text()); }catch{ toast(tr('tImportBad')); return; }
    pushHistory(true);
    const {added, replaced, first}=mergeTrips(S.store, trips, newId);
    setActive(first);
    closeSheets(); commit(); $('#scroller').scrollTo(0,0);
    toast(tr('tImported',{added, replaced}));
  });
}
