/* Ecrãs de login e sem ligação, formulário de login e botão Sair.
   Os pedidos e o estado da sessão estão em sync.js. */
import { tr } from '../i18n.js';
import { $, toast } from './dom.js';
import { signIn, signOut, isAuthError } from '../sync.js';

export function showLogin(){
  $('.app').hidden=true; $('#offline').hidden=true; $('#login').hidden=false; $('#l-err').hidden=true;
  ($('#l-user').value ? $('#l-pass') : $('#l-user')).focus();
}
/* Ao entrar, a palavra-passe sai do formulário. */
export function showApp(){ $('#l-pass').value=''; $('#login').hidden=true; $('#offline').hidden=true; $('.app').hidden=false; }
export function showOffline(){ $('#offline').hidden=false; }

export function initLogin(){
  $('#login-form').addEventListener('submit', async e=>{
    e.preventDefault(); const err=$('#l-err'), btn=$('#l-submit'); err.hidden=true;
    const fail=m=>{ err.textContent=m; err.hidden=false; };
    if(!$('#l-user').value.trim() || !$('#l-pass').value) return fail(tr('errFill'));
    btn.disabled=true; btn.textContent=tr('signingIn');
    try{
      const status=await signIn($('#l-user').value, $('#l-pass').value);
      if(status===429) fail(tr('errTooMany'));
      else if(status!==200) fail(tr('errWrong'));
    }catch(ex){ if(!isAuthError(ex)) fail(tr('errServer')); }
    finally{ btn.disabled=false; btn.textContent=tr('signIn'); }
  });
  $('#logout').addEventListener('click', async ()=>{ if(!await signOut()) toast(tr('tLogoutPending')); });
}
