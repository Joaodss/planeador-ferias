/* Ponto de entrada da página.
   Nenhum módulo faz nada quando é importado: aqui ligam-se os eventos de cada parte da interface,
   liga-se sync.js à interface, escrevem-se os textos fixos e arranca-se a ligação ao servidor.

   js/            lógica sem DOM (os testes importam-na em Node)
     i18n.js      textos PT/EN
     util.js      texto, datas e horas
     state.js     estado partilhado (S) e Desfazer
     trip.js      dias, horário, sítios, mover atividades
     span.js      tempo absoluto, pedaços visíveis e segundo fuso no quadro
     clean.js     limpeza dos dados do servidor e das importações
     costs.js     categorias e totais de custos
     warnings.js  regras dos pontos a rever
     tz.js        fusos horários e segundo fuso
     sync.js      pedidos ao servidor, gravação e sessão
   js/ui/         interface
     dom.js       $, toast, announce, tamanho do ecrã e escala da grelha
     login.js     ecrãs de login e sem ligação, botão Sair
     board.js     quadro, render() e teclado
     drag.js      arrastar e redimensionar
     sheets.js    fechar painéis
     editor.js    painel da atividade
     daysheet.js  painel do dia
     tripsheet.js painel da viagem (sítios, categorias)
     costsheet.js painel de custos
     review.js    painel dos pontos a rever
     toolbar.js   barra de ferramentas e indicador de gravação
     files.js     Excel, cópia de segurança e importar */
import { I18N } from './i18n.js';
import { boot, connectUI, initSync } from './sync.js';
import { toast, announce } from './ui/dom.js';
import { initLogin, showLogin, showApp, showOffline } from './ui/login.js';
import { initBoard, render } from './ui/board.js';
import { initDrag } from './ui/drag.js';
import { initSheets, closeSheets } from './ui/sheets.js';
import { initEditor } from './ui/editor.js';
import { initDaysheet } from './ui/daysheet.js';
import { initTripsheet } from './ui/tripsheet.js';
import { initCostsheet } from './ui/costsheet.js';
import { initReview } from './ui/review.js';
import { initToolbar, showSaveState } from './ui/toolbar.js';
import { initFiles } from './ui/files.js';

initLogin(); initBoard(); initDrag(); initSheets(); initEditor(); initDaysheet();
initTripsheet(); initCostsheet(); initReview(); initToolbar(); initFiles();
connectUI({render, closeSheets, toast, announce, saveState:showSaveState, showLogin, showApp, showOffline});
initSync();
I18N.apply();
boot();
