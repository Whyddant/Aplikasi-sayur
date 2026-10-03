/* ==========================================================
   SAYUR APP — storage.js (v1.0)
   
   Modul offline-first untuk client.
   
   Konsep:
   - Cache: baca dari localStorage dulu, baru refresh dari server
   - Queue: setiap tulis masuk queue dulu → optimistic update
   - Sync: background process kirim queue ke server
   - Idempotent: setiap aksi punya clientId unik (anti dobel)
   - Local always wins: kalau konflik, HP yang dianggap benar
   
   Cara pakai:
   
     // Baca
     const data = await SayurAPI.get('getBelanja', {tanggal:'2026-10-02'});
     
     // Tulis (otomatis masuk queue)
     await SayurAPI.post('addBelanja', {...});
     
     // Event untuk UI
     window.addEventListener('sayur:sync-status', e => { ... });
   ========================================================== */

(function(global){
  'use strict';

  /* ==========================================================
     KONFIGURASI
     ========================================================== */
  const CONFIG = {
    API_URL: 'https://script.google.com/macros/s/AKfycbyj3eXJV0qSa0-3HFuph0AaV1y5dft9Zjsqt-en7j_DU9mM4huxGoctMD52KTbivuN6/exec',
    API_TOKEN: 'T_ps2ImXNPwz51wWz-bb7qjHjT4dNgFh',
    CACHE_TTL_MS: 4 * 1000,        // cache GET berlaku 4 detik
    SYNC_INTERVAL_MS: 30 * 1000,   // auto-sync setiap 30 detik
    MAX_RETRY: 5,                  // max 5x retry per item queue
    QUEUE_TTL_DAYS: 30             // queue lebih tua dari ini dihapus
  };

  /* ==========================================================
     KEYS — prefix localStorage
     ========================================================== */
  const K = {
    CACHE: 'sayur_cache_',
    QUEUE: 'sayur_queue',
    LAST_SYNC: 'sayur_last_sync',
    PENGATURAN: 'sayur_pengaturan',
    META: 'sayur_meta'
  };

  /* ==========================================================
     EVENT NAMES — untuk komunikasi dengan UI
     ========================================================== */
  const EV = {
    STATUS_CHANGE: 'sayur:status',   // {status, pending, lastSync}
    SYNC_DONE: 'sayur:sync-done',    // {ok, hasil, total}
    SYNC_ERROR: 'sayur:sync-error',  // {error}
    DATA_CHANGE: 'sayur:data'        // {key} — cache berubah
  };

  /* ==========================================================
     UTILITAS
     ========================================================== */
  function uid(prefix){
    return (prefix || '') + Date.now() + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  function now(){
    return new Date().toISOString();
  }

  function daysAgo(n){
    return Date.now() - (n * 24 * 60 * 60 * 1000);
  }

  function safeJSON(str, def){
    try{
      if(!str) return def;
      return JSON.parse(str);
    }catch(e){
      return def;
    }
  }

  function emit(eventName, detail){
    try{
      const ev = new CustomEvent(eventName, {detail});
      window.dispatchEvent(ev);
    }catch(e){
      // fallback kalau CustomEvent tidak support
      console.warn('Emit event gagal:', eventName, e);
    }
  }

  /* ==========================================================
     CACHE — read/write localStorage dengan TTL
     ========================================================== */
  const Cache = {
    save(key, data){
      try{
        const entry = { data, t: Date.now() };
        localStorage.setItem(K.CACHE + key, JSON.stringify(entry));
        emit(EV.DATA_CHANGE, {key});
        return true;
      }catch(e){
        console.warn('Cache save gagal:', key, e);
        return false;
      }
    },

    load(key){
      try{
        const raw = localStorage.getItem(K.CACHE + key);
        if(!raw) return null;
        const entry = safeJSON(raw, null);
        return entry ? entry.data : null;
      }catch(e){
        return null;
      }
    },

    loadWithTime(key){
      try{
        const raw = localStorage.getItem(K.CACHE + key);
        if(!raw) return null;
        return safeJSON(raw, null);
      }catch(e){
        return null;
      }
    },

    isFresh(key, ttlMs){
      const entry = this.loadWithTime(key);
      if(!entry || !entry.t) return false;
      const ttl = ttlMs !== undefined ? ttlMs : CONFIG.CACHE_TTL_MS;
      return (Date.now() - entry.t) < ttl;
    },

    remove(key){
      try{
        localStorage.removeItem(K.CACHE + key);
        return true;
      }catch(e){
        return false;
      }
    },

    clearAll(){
      try{
        const keys = [];
        for(let i = 0; i < localStorage.length; i++){
          const k = localStorage.key(i);
          if(k && k.startsWith(K.CACHE)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
        return true;
      }catch(e){
        return false;
      }
    },

    /* Daftar semua key cache yang ada */
    keys(){
      const result = [];
      try{
        for(let i = 0; i < localStorage.length; i++){
          const k = localStorage.key(i);
          if(k && k.startsWith(K.CACHE)) result.push(k.slice(K.CACHE.length));
        }
      }catch(e){}
      return result;
    }
  };

  /* ==========================================================
     QUEUE — pending writes yang belum terkirim ke server
     ========================================================== */
  const Queue = {
    /* Baca seluruh queue */
    list(){
      try{
        const raw = localStorage.getItem(K.QUEUE);
        const arr = safeJSON(raw, []);
        return Array.isArray(arr) ? arr : [];
      }catch(e){
        return [];
      }
    },

    /* Simpan queue */
    _save(arr){
      try{
        localStorage.setItem(K.QUEUE, JSON.stringify(arr));
        emit(EV.STATUS_CHANGE, Status.get());
        return true;
      }catch(e){
        console.warn('Queue save gagal:', e);
        return false;
      }
    },

    /* Tambah aksi ke queue */
    add(action, data, clientId){
      const arr = this.list();
      const cid = clientId || uid('q-');
      const item = {
        clientId: cid,
        action: action,
        data: data || {},
        retry: 0,
        createdAt: now(),
        lastRetry: null
      };
      arr.push(item);
      this._save(arr);
      return cid;
    },

    /* Hapus 1 item dari queue */
    remove(clientId){
      const arr = this.list().filter(x => x.clientId !== clientId);
      this._save(arr);
      return true;
    },

    /* Hapus banyak item sekaligus */
    removeMany(clientIds){
      const set = new Set(clientIds);
      const arr = this.list().filter(x => !set.has(x.clientId));
      this._save(arr);
    },

    /* Update retry count (+ simpan alasan error terakhir) */
    bumpRetry(clientId, errMsg){
      const arr = this.list();
      const item = arr.find(x => x.clientId === clientId);
      if(item){
        item.retry = (item.retry || 0) + 1;
        item.lastRetry = now();
        if(errMsg) item.lastError = String(errMsg);
        this._save(arr);
        return item.retry;
      }
      return 0;
    },

    /* Item yang sudah melebihi MAX_RETRY (berhenti dikirim otomatis) */
    getFailedItems(){
      return this.list().filter(x => (x.retry || 0) >= CONFIG.MAX_RETRY);
    },

    /* Item yang masih layak dikirim */
    getPendingItems(){
      return this.list().filter(x => (x.retry || 0) < CONFIG.MAX_RETRY);
    },

    pendingCount(){ return this.getPendingItems().length; },
    failedCount(){ return this.getFailedItems().length; },

    /* Reset retry item gagal supaya dicoba kirim lagi */
    resetFailed(){
      const arr = this.list();
      let n = 0;
      arr.forEach(x => {
        if((x.retry || 0) >= CONFIG.MAX_RETRY){ x.retry = 0; n++; }
      });
      if(n > 0) this._save(arr);
      return n;
    },

    /* Buang item gagal dari queue (data tidak akan terkirim) */
    discardFailed(){
      const arr = this.list();
      const keep = arr.filter(x => (x.retry || 0) < CONFIG.MAX_RETRY);
      this._save(keep);
      return arr.length - keep.length;
    },

    /* Bersihkan item yang terlalu tua */
    pruneOld(){
      const cutoff = daysAgo(CONFIG.QUEUE_TTL_DAYS);
      const arr = this.list().filter(x => {
        const t = new Date(x.createdAt).getTime();
        return !isNaN(t) && t > cutoff;
      });
      this._save(arr);
    },

    /* Jumlah item di queue */
    count(){
      return this.list().length;
    },

    /* Hapus semua */
    clear(){
      this._save([]);
      return true;
    }
  };

  /* ==========================================================
     META — info internal (last sync, versi, dll)
     ========================================================== */
  const Meta = {
    get(key, def){
      try{
        const raw = localStorage.getItem(K.META);
        const obj = safeJSON(raw, {});
        return obj[key] !== undefined ? obj[key] : def;
      }catch(e){
        return def;
      }
    },
    set(key, val){
      try{
        const raw = localStorage.getItem(K.META);
        const obj = safeJSON(raw, {});
        obj[key] = val;
        localStorage.setItem(K.META, JSON.stringify(obj));
        return true;
      }catch(e){
        return false;
      }
    }
  };

  /* ==========================================================
     STATUS — status koneksi & sync
     ========================================================== */
  const Status = {
    get(){
      const pending = Queue.pendingCount();
      const failedItems = Queue.getFailedItems();
      const failed = failedItems.length;
      const isOnline = navigator.onLine;
      let status = 'online';
      if(!isOnline) status = 'offline';
      else if(pending > 0) status = 'pending';
      else if(failed > 0) status = 'failed';
      return {
        status: status,           // 'online' | 'pending' | 'failed' | 'offline'
        pending: pending,
        failed: failed,
        lastError: failed ? (failedItems[0].lastError || '') : '',
        lastSync: Meta.get('lastSync', null),
        apiUrl: CONFIG.API_URL
      };
    },
    isOnline(){ return navigator.onLine; },
    isSyncing(){ return _syncing; }
  };

  /* ==========================================================
     API CALL — HTTP wrapper
     ========================================================== */
  async function _httpGet(action, params){
    const qs = new URLSearchParams({
      action: action,
      token: CONFIG.API_TOKEN,
      ...(params || {})
    }).toString();

    const url = CONFIG.API_URL + '?' + qs;
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store'
    });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if(!json.ok) throw new Error(json.error || 'Gagal');
    return json.data;
  }

  async function _httpPost(action, data){
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: action,
        token: CONFIG.API_TOKEN,
        data: data || {}
      })
    });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if(!json.ok) throw new Error(json.error || 'Gagal');
    return json.data;
  }

  /* ==========================================================
     GET — dengan cache
     
     Strategi:
     1. Kalau cache masih fresh (< TTL) → langsung kembalikan
     2. Kalau tidak ada / kadaluarsa → coba fetch dari server
     3. Kalau fetch gagal (offline) → kembalikan cache lama kalau ada
     ========================================================== */
  async function get(action, params){
    const key = _cacheKey(action, params);

    /* Cek cache fresh */
    if(Cache.isFresh(key)){
      return Cache.load(key);
    }

    /* Coba fetch server */
    if(navigator.onLine){
      try{
        const data = await _httpGet(action, params);
        Cache.save(key, data);
        return data;
      }catch(e){
        /* Gagal → fallback ke cache */
        const cached = Cache.load(key);
        if(cached !== null) return cached;
        throw e;
      }
    }

    /* Offline → pakai cache */
    const cached = Cache.load(key);
    if(cached !== null) return cached;
    throw new Error('Offline & belum ada data tersimpan');
  }

  /* Buat cache key dari action + params */
  function _cacheKey(action, params){
    if(!params || Object.keys(params).length === 0) return action;
    const sorted = Object.keys(params).sort().map(k => k + '=' + params[k]);
    return action + '::' + sorted.join('&');
  }

  /* ==========================================================
     POST — optimistic + queue
     
     Strategi:
     1. Tulis ke queue dulu (instant)
     2. Optimistic update cache kalau bisa
     3. Trigger sync di background
     4. Return langsung (tidak tunggu server)
     
     Pengecualian: kalau action butuh respons server
     (misal getLaporan setelah update), pakai postNow().
     ========================================================== */
  async function post(action, data){
    /* Tambah ke queue */
    const clientId = data && data.id ? data.id : uid('q-');
    Queue.add(action, data, clientId);

    /* Trigger sync di background (tidak tunggu) */
    if(navigator.onLine){
      _scheduleSyncSoon();
    }

    return {
      ok: true,
      queued: true,
      clientId: clientId,
      pending: Queue.count()
    };
  }

  /* POST yang langsung tunggu respons server — untuk kasus khusus */
  async function postNow(action, data){
    if(!navigator.onLine){
      /* Offline → tetap masuk queue, tapi kasih tahu client */
      return await post(action, data);
    }
    try{
      const result = await _httpPost(action, data);
      Meta.set('lastSync', now());
      emit(EV.STATUS_CHANGE, Status.get());
      return { ok: true, data: result, queued: false };
    }catch(e){
      /* Gagal → masuk queue untuk retry */
      Queue.add(action, data);
      throw e;
    }
  }

  /* ==========================================================
     SYNC — background processor
     ========================================================== */
  let _syncing = false;
  let _syncTimer = null;
  let _syncSoonTimer = null;

  /* Jadwalkan sync sebentar lagi (debounce 2 detik) */
  function _scheduleSyncSoon(){
    if(_syncSoonTimer) clearTimeout(_syncSoonTimer);
    _syncSoonTimer = setTimeout(() => {
      _syncSoonTimer = null;
      processQueue().catch(() => {});
    }, 2000);
  }

  /* Proses queue — kirim ke server dalam batch */
  async function processQueue(){
    if(_syncing) return {skipped: true};
    if(!navigator.onLine){
      emit(EV.STATUS_CHANGE, Status.get());
      return {skipped: true, reason: 'offline'};
    }

    /* Item yang sudah gagal MAX_RETRY kali tidak dikirim otomatis lagi */
    const arr = Queue.getPendingItems();
    if(arr.length === 0){
      Meta.set('lastSync', now());
      emit(EV.STATUS_CHANGE, Status.get());
      return {skipped: true, reason: 'empty'};
    }

    _syncing = true;
    emit(EV.STATUS_CHANGE, Status.get());

    try{
      /* Kirim dalam batch (max 50 per request) */
      const BATCH_SIZE = 50;
      const batches = [];
      for(let i = 0; i < arr.length; i += BATCH_SIZE){
        batches.push(arr.slice(i, i + BATCH_SIZE));
      }

      let totalOk = 0, totalSkip = 0, totalError = 0;
      let newlyFailed = 0, batchError = null;
      const toRemove = [];

      for(const batch of batches){
        try{
          const res = await _httpPost('batchSync', {aksi: batch});
          const hasil = (res && res.hasil) || [];

          hasil.forEach(h => {
            if(h.status === 'ok'){ totalOk++; toRemove.push(h.clientId); }
            else if(h.status === 'skip'){ totalSkip++; toRemove.push(h.clientId); }
            else if(h.status === 'error'){
              totalError++;
              const r = Queue.bumpRetry(h.clientId, h.error);
              if(r === CONFIG.MAX_RETRY) newlyFailed++;
            }
          });
        }catch(e){
          /* Batch gagal total (jaringan / server sibuk) → sementara.
             Jangan bump retry, supaya item tidak ditandai gagal
             hanya karena sinyal jelek. */
          batchError = String(e.message || e);
        }
      }

      /* Hapus yang sukses dari queue */
      if(toRemove.length > 0) Queue.removeMany(toRemove);

      /* Prune item lama */
      Queue.pruneOld();

      Meta.set('lastSync', now());
      emit(EV.SYNC_DONE, {
        ok: totalOk,
        skip: totalSkip,
        error: totalError,
        newlyFailed: newlyFailed,
        failed: Queue.failedCount(),
        pending: Queue.pendingCount()
      });
      if(batchError) emit(EV.SYNC_ERROR, {error: batchError});
      emit(EV.STATUS_CHANGE, Status.get());

      return {ok: totalOk, skip: totalSkip, error: totalError,
              newlyFailed: newlyFailed, failed: Queue.failedCount()};
    }catch(e){
      emit(EV.SYNC_ERROR, {error: String(e.message || e)});
      emit(EV.STATUS_CHANGE, Status.get());
      return {error: String(e.message || e)};
    }finally{
      _syncing = false;
      emit(EV.STATUS_CHANGE, Status.get());
    }
  }

  /* Auto-sync mulai */
  function startAutoSync(){
    if(_syncTimer) clearInterval(_syncTimer);
    _syncTimer = setInterval(() => {
      if(navigator.onLine && Queue.pendingCount() > 0){
        processQueue().catch(() => {});
      } else {
        emit(EV.STATUS_CHANGE, Status.get());
      }
    }, CONFIG.SYNC_INTERVAL_MS);

    /* Sync saat aplikasi pertama buka */
    setTimeout(() => {
      if(navigator.onLine && Queue.pendingCount() > 0){
        processQueue().catch(() => {});
      }
    }, 1000);

    return true;
  }

  function stopAutoSync(){
    if(_syncTimer) clearInterval(_syncTimer);
    _syncTimer = null;
  }

  /* ==========================================================
     ONLINE / OFFLINE LISTENER
     ========================================================== */
  function _initNetworkListener(){
    window.addEventListener('online', () => {
      emit(EV.STATUS_CHANGE, Status.get());
      /* Begitu online, langsung sync */
      setTimeout(() => processQueue().catch(() => {}), 500);
    });

    window.addEventListener('offline', () => {
      emit(EV.STATUS_CHANGE, Status.get());
    });

    /* Cek juga saat tab dibuka kembali */
    document.addEventListener('visibilitychange', () => {
      if(!document.hidden && navigator.onLine && Queue.pendingCount() > 0){
        processQueue().catch(() => {});
      }
    });
  }

  /* ==========================================================
     PENGATURAN — helper khusus untuk setting
     ========================================================== */
  const Pengaturan = {
    async get(){
      /* Coba dari local dulu (biar cepat & offline-safe) */
      const local = safeJSON(localStorage.getItem(K.PENGATURAN), null);
      if(local) return local;

      /* Belum ada → fetch dari server */
      try{
        const remote = await get('getPengaturan');
        localStorage.setItem(K.PENGATURAN, JSON.stringify(remote));
        return remote;
      }catch(e){
        return {
          NamaLapak: '',
          NamaPemilik: '',
          NoHP: '',
          OperasionalBelanja: 100000,
          Bensin: 50000,
          BatasMinimalLaba: 250000,
          SusutRate: 0.30
        };
      }
    },

    async save(data){
      /* Simpan lokal dulu */
      const current = await this.get();
      const merged = {...current, ...data};
      localStorage.setItem(K.PENGATURAN, JSON.stringify(merged));

      /* Kirim ke server via queue */
      await post('setPengaturan', data);
      return merged;
    },

    /* Hapus cache lokal, paksa refresh dari server */
    clearLocal(){
      localStorage.removeItem(K.PENGATURAN);
      return true;
    }
  };

  /* ==========================================================
     BACA — helper tambahan
     ========================================================== */
  const Helper = {
    uid,
    now,
    daysAgo,
    safeJSON,

    /* Baca cache langsung (tanpa fetch) */
    cacheGet(key, def){
      const v = Cache.load(key);
      return v !== null ? v : def;
    },

    /* Cek apakah ada data pending untuk action tertentu */
    hasPending(action){
      return Queue.list().some(x => x.action === action);
    },

    /* Bersihkan semua data lokal (untuk logout / reset) */
    clearAll(){
      Cache.clearAll();
      Queue.clear();
      localStorage.removeItem(K.PENGATURAN);
      localStorage.removeItem(K.META);
      return true;
    },

    /* Statistik storage */
    stats(){
      let total = 0, count = 0;
      try{
        for(let i = 0; i < localStorage.length; i++){
          const k = localStorage.key(i);
          if(k && k.startsWith('sayur_')){
            total += (localStorage.getItem(k) || '').length + k.length;
            count++;
          }
        }
      }catch(e){}
      return {
        keys: count,
        bytes: total,
        kb: (total / 1024).toFixed(1),
        queueCount: Queue.count()
      };
    }
  };

  /* ==========================================================
     EXPORT — global object
     ========================================================== */
  global.SayurStorage = {
    /* API */
    get,
    post,
    postNow,

    /* Sync */
    processQueue,
    retryFailed(){ Queue.resetFailed(); return processQueue(); },
    discardFailed(){ return Queue.discardFailed(); },
    startAutoSync,
    stopAutoSync,

    /* Status */
    status: Status,

    /* Cache / Queue direct access */
    cache: Cache,
    queue: Queue,
    meta: Meta,

    /* Pengaturan shortcut */
    pengaturan: Pengaturan,

    /* Helper */
    helper: Helper,

    /* Config (untuk debug) */
    config: CONFIG,

    /* Event names */
    events: EV,

    /* Init — panggil sekali di startup */
    init(){
      _initNetworkListener();
      startAutoSync();
      emit(EV.STATUS_CHANGE, Status.get());
      return true;
    }
  };

})(window);