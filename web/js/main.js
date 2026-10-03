/* Ponto de entrada da página.
   Cada módulo de ui/ liga os seus próprios eventos quando é carregado;
   aqui só se garante que todos são carregados e arranca-se a ligação ao servidor.

   js/            lógica sem interface
     i18n.js      textos PT/EN
     util.js      DOM, datas, horas, toast
     state.js     estado partilhado (S) e Desfazer
     trip.js      dias, horário, sítios, mover atividades
     costs.js     categorias e totais de custos
     warnings.js  regras dos pontos a rever
     sync.js      gravação no servidor, login e logout
   js/ui/         interface
     board.js     quadro, render() e teclado
     drag.js      arrastar e redimensionar
     sheets.js    fechar painéis
     editor.js    painel da atividade
     daysheet.js  painel do dia
     tripsheet.js painel da viagem (sítios, categorias)
     costsheet.js painel de custos
     review.js    painel dos pontos a rever
     toolbar.js   barra de ferramentas
     files.js     Excel, cópia de segurança e importar */
import { boot } from './sync.js';
import './ui/board.js';
import './ui/drag.js';
import './ui/sheets.js';
import './ui/editor.js';
import './ui/daysheet.js';
import './ui/tripsheet.js';
import './ui/costsheet.js';
import './ui/review.js';
import './ui/toolbar.js';
import './ui/files.js';

boot();
