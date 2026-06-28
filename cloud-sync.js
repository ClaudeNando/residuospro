/* ============================================================================
 * cloud-sync.js — Cerrado Ambiental
 * Camada compartilhada: autenticação, login/logout, sincronização (Firestore),
 * backup/restauração e monitoramento de estado da conexão.
 * Usada por index.html (ResíduosPRO) e furgao.html (FurgãoPRO).
 *
 * Reproduz FIELMENTE o comportamento que antes estava embutido (duplicado) em
 * cada app. Não altera regras de negócio, layout, banco nem o Decision Engine.
 *
 * Uso (no fim do script principal de cada app):
 *   if(window.CloudSync) CloudSync.initSync({
 *     collection : 'residuospro' | 'furgaopro',
 *     syncKeys   : ['rpro_cfg','rpro_hist','rpro_coletas'] | ['fp2_*'...],
 *     onRemote   : function(key,value){ ... recarrega estado + re-renderiza ... },
 *     onLogout   : function(){ ... fecha modal de config do app ... }
 *   });
 * Backup:
 *   CloudSync.exportBackup(prefixoArquivo, payloadObj, msgToast);
 *   CloudSync.importBackup(inputEl, function(d){ ...valida + aplica... });
 * ========================================================================== */

(function (global) {
  'use strict';

  /* Config do Firebase (idêntica à que estava embutida nos dois apps). */
  var FB_CONFIG = {
    apiKey: "AIzaSyDzPZMZ0tP0dYDzfaFR1fm6Thx6ir4K76Q",
    authDomain: "residuospro---cerrado.firebaseapp.com",
    projectId: "residuospro---cerrado",
    storageBucket: "residuospro---cerrado.firebasestorage.app",
    messagingSenderId: "849223957541",
    appId: "1:849223957541:web:002d832603cb7ab75cd3cc"
  };

  var _auth = null, _db = null;
  var _col = '', _syncKeys = [], _onRemote = null, _onLogout = null, _onConnection = null;
  var _applyingRemote = false, _timers = {}, _unsub = [];
  var _setItem = Storage.prototype.setItem;       // referência nativa
  var _online = (typeof navigator !== 'undefined') ? navigator.onLine : true;

  function _g(id) { return document.getElementById(id); }
  function _toast(m) { if (typeof global.toast === 'function') global.toast(m); }

  /* ---- Resolução de conflito (timestamp por chave + auditoria) ---- */
  var _META = '__cs_ts_';      // prefixo: timestamp da última edição local de cada chave
  var _LOG  = '__cs_conflog';  // log de conflitos (auditável)
  var _initTime = 0;           // marca o início da sincronização (evita avisos no login)
  var _remote = {};            // último snapshot conhecido por chave: { value, ts } (proteção TASK-016)
  function _now() { return Date.now(); }
  // Valor "vazio" = sem dados úteis: usado para não semear/sobrescrever a nuvem a partir de um aparelho vazio.
  function _isVazio(v) {
    if (v == null) return true;
    var s = String(v).trim();
    return s === '' || s === '[]' || s === '{}' || s === 'null';
  }
  function _getLocalTs(k) { var t = Number(localStorage.getItem(_META + k)); return isNaN(t) ? 0 : t; }
  function _setLocalTs(k, ts) { try { _setItem.call(window.localStorage, _META + k, String(ts)); } catch (e) {} }
  function _logConflito(k, acao, localTs, remoteTs) {
    var ev = { k: k, acao: acao, localTs: localTs, remoteTs: remoteTs, em: new Date().toISOString() };
    try { console.info('[CloudSync] conflito de sincronização:', ev); } catch (e) {}
    try {
      var arr = JSON.parse(localStorage.getItem(_LOG) || '[]'); arr.push(ev);
      if (arr.length > 50) arr = arr.slice(-50);
      _setItem.call(window.localStorage, _LOG, JSON.stringify(arr));
    } catch (e) {}
    // aviso leve só após a sincronização inicial (não polui durante o login)
    if (_now() - _initTime > 4000) {
      if (acao === 'remoto-aplicado') _toast('🔄 Dados atualizados de outro dispositivo');
      else if (acao === 'local-mantido') _toast('✓ Mantida a versão mais recente deste aparelho');
    }
  }

  /* ---- Gravação explícita (substitui a antiga interceptação de Storage.setItem, TASK-010) ---- */
  /* Grava no localStorage e, se a chave é sincronizável e há sessão, carimba o timestamp
     e agenda o push (mesmo comportamento que o override fazia, agora explícito). */
  function save(k, v) {
    _setItem.call(window.localStorage, k, v == null ? '' : String(v));
    if (_syncKeys.indexOf(k) >= 0 && !_applyingRemote && _auth && _auth.currentUser) {
      _setLocalTs(k, _now());
      clearTimeout(_timers[k]); _timers[k] = setTimeout(function () { _pushCloud(k); }, 400);
    }
    return v;
  }

  /* ---- Sincronização (local -> nuvem e nuvem -> local) ---- */
  function _pushCloud(k) {
    if (!_auth || !_auth.currentUser) return;
    var localVal = localStorage.getItem(k) || '';
    // Proteção (TASK-016): nunca enviar valor VAZIO que apagaria a nuvem.
    // - Se já conhecemos um remoto CHEIO: re-semeia este aparelho a partir dele e bloqueia o overwrite.
    // - Se o remoto ainda é desconhecido (snapshot não chegou) ou também vazio: não há o que enviar — ignora o push vazio.
    if (_isVazio(localVal)) {
      var rem = _remote[k];
      if (rem && !_isVazio(rem.value)) {
        _logConflito(k, 'overwrite-vazio-bloqueado', _getLocalTs(k), rem.ts);
        _applyingRemote = true; _setItem.call(localStorage, k, rem.value); _applyingRemote = false;
        _setLocalTs(k, rem.ts);
        if (_onRemote) { try { _onRemote(k, rem.value); } catch (e) {} }
      }
      return;
    }
    var ts = _getLocalTs(k); if (!ts) { ts = _now(); _setLocalTs(k, ts); }
    _db.collection(_col).doc(k).set({
      value: localVal, ts: ts, by: _auth.currentUser.email || ''
    }).catch(function () {});
  }
  function _aplicarRemoto(k, val, remoteTs) {
    remoteTs = Number(remoteTs) || 0;
    var localTs = _getLocalTs(k);
    // Conteúdo igual: nada a fazer (só converge o timestamp para o maior conhecido).
    if (localStorage.getItem(k) === val) { if (remoteTs > localTs) _setLocalTs(k, remoteTs); return; }
    if (remoteTs >= localTs) {
      // Remoto é mais novo (ou do mesmo instante): aplica e re-renderiza.
      _applyingRemote = true; _setItem.call(localStorage, k, val == null ? '' : val); _applyingRemote = false;
      _setLocalTs(k, remoteTs);
      if (_onRemote) { try { _onRemote(k, val); } catch (e) {} }
      if (localTs > 0) _logConflito(k, 'remoto-aplicado', localTs, remoteTs);
    } else if (_isVazio(localStorage.getItem(k)) && !_isVazio(val)) {
      // Local é mais novo MAS está vazio e o remoto tem dados: NÃO sobrescreve a nuvem
      // (proteção TASK-016 contra semeadura por aparelho vazio). Re-semeia o local a partir do remoto.
      _applyingRemote = true; _setItem.call(localStorage, k, val); _applyingRemote = false;
      _setLocalTs(k, remoteTs);
      if (_onRemote) { try { _onRemote(k, val); } catch (e) {} }
      _logConflito(k, 'overwrite-vazio-bloqueado', localTs, remoteTs);
    } else {
      // Local é mais novo e tem conteúdo: NÃO sobrescreve; reenvia o local para a nuvem (sem perda silenciosa).
      _logConflito(k, 'local-mantido', localTs, remoteTs);
      _pushCloud(k);
    }
  }
  function _iniciarSync() {
    _syncKeys.forEach(function (k) {
      var un = _db.collection(_col).doc(k).onSnapshot(function (doc) {
        if (doc.exists) {
          var d = doc.data();
          if (d && typeof d.value === 'string') { _remote[k] = { value: d.value, ts: Number(d.ts) || 0 }; _aplicarRemoto(k, d.value, d.ts); }
        } else {
          _remote[k] = { value: '', ts: 0 };               // nuvem sem este doc: seguro semear com local cheio
          if (localStorage.getItem(k)) _pushCloud(k);
        }
      }, function () {});
      _unsub.push(un);
    });
  }
  function _pararSync() { _unsub.forEach(function (u) { try { u(); } catch (e) {} }); _unsub = []; _remote = {}; }

  /* ---- Login / Logout ---- */
  function login() {
    var em = (_g('lg-email').value || '').trim(), sn = _g('lg-senha').value || '';
    if (!em || !sn) { _g('lg-erro').textContent = 'Preencha e-mail e senha.'; return; }
    _g('lg-erro').textContent = ''; _g('lg-btn').textContent = 'Entrando...';
    _auth.signInWithEmailAndPassword(em, sn).catch(function (err) {
      var m = 'Não foi possível entrar.';
      if (err.code === 'auth/invalid-email') m = 'E-mail inválido.';
      else if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') m = 'E-mail ou senha incorretos.';
      else if (err.code === 'auth/network-request-failed') m = 'Sem conexão com a internet.';
      else if (err.code === 'auth/too-many-requests') m = 'Muitas tentativas. Aguarde um pouco.';
      _g('lg-erro').textContent = m;
    }).finally(function () { _g('lg-btn').textContent = 'Entrar'; });
  }
  function logout() {
    if (confirm('Sair da conta? Os dados continuam salvos na nuvem.')) {
      _pararSync(); _auth.signOut(); if (_onLogout) { try { _onLogout(); } catch (e) {} }
    }
  }

  /* ---- Inicialização (autenticação + intercepta setItem + estado) ---- */
  function initSync(opts) {
    if (typeof global.firebase === 'undefined') return false; // SDK não carregou → app segue só local
    if (!firebase.apps || !firebase.apps.length) { firebase.initializeApp(FB_CONFIG); }
    _auth = firebase.auth(); _db = firebase.firestore();
    try { _db.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (e) {}

    _col = opts.collection; _syncKeys = opts.syncKeys || [];
    _onRemote = opts.onRemote || null; _onLogout = opts.onLogout || null;
    _onConnection = opts.onConnection || null;
    _initTime = _now();

    /* Gravação de chaves sincronizáveis é explícita via CloudSync.save (TASK-010):
       não há mais override de Storage.prototype.setItem. */

    _auth.onAuthStateChanged(function (user) {
      if (user) {
        var gate = _g('login-gate'); if (gate) gate.style.display = 'none';
        var em = _g('cfg-user-email'); if (em) em.textContent = user.email || '';
        _iniciarSync();
      } else {
        _pararSync();
        var em2 = _g('cfg-user-email'); if (em2) em2.textContent = '—';
        var gate2 = _g('login-gate'); if (gate2) gate2.style.display = 'flex';
      }
    });

    global.fazerLogin = login;
    global.sairConta = logout;
    ['lg-email', 'lg-senha'].forEach(function (id) {
      var el = _g(id); if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
    });

    /* Monitoramento de conexão (passivo: não altera comportamento; só expõe estado). */
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', function () { _online = true; if (_onConnection) try { _onConnection(true); } catch (e) {} });
      window.addEventListener('offline', function () { _online = false; if (_onConnection) try { _onConnection(false); } catch (e) {} });
    }
    return true;
  }

  /* ---- Backup / Restauração (plumbing centralizado; payload por app) ---- */
  function exportBackup(filenamePrefix, payload, toastMsg) {
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = filenamePrefix + '-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      if (toastMsg) _toast(toastMsg);
    } catch (e) { _toast('⚠️ Falha ao exportar'); }
  }
  function importBackup(input, handler) {
    var file = input.files && input.files[0]; if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try { var d = JSON.parse(e.target.result); handler(d); }
      catch (err) { _toast('⚠️ Arquivo inválido'); }
      input.value = '';
    };
    reader.readAsText(file);
  }

  function isOnline() { return _online; }
  function getConflictLog() { try { return JSON.parse(localStorage.getItem(_LOG) || '[]'); } catch (e) { return []; } }
  function clearConflictLog() { try { _setItem.call(window.localStorage, _LOG, '[]'); } catch (e) {} }

  global.CloudSync = {
    _version: '1.2.0',
    config: FB_CONFIG,
    initSync: initSync,
    save: save,
    login: login,
    logout: logout,
    exportBackup: exportBackup,
    importBackup: importBackup,
    isOnline: isOnline,
    getConflictLog: getConflictLog,
    clearConflictLog: clearConflictLog
  };

})(typeof window !== 'undefined' ? window : this);
