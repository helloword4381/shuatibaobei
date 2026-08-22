/* store.js — localStorage 状态：用户/错题/统计/设置（按账号命名空间隔离）+ Supabase 云端同步 */
(function () {
  'use strict';

  // ========== Supabase 云端配置（项目 URL 从 anon key JWT 的 ref 字段反推得到）==========
  const CLOUD = {
    ENABLED: true,
    URL: 'https://nvhgbkqpfgmkntjsigij.supabase.co',
    ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52aGticWtwZmdta250anNpZ2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNDQzNzcsImV4cCI6MjEwMjkyMDM3N30.uXY2blnzOK5axCqO95QkWF765y4Kuhs78G3knh3llIc'
  };

  function cloudHeaders() {
    return {
      'apikey': CLOUD.ANON_KEY,
      'Authorization': 'Bearer ' + CLOUD.ANON_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };
  }

  // 调用 RPC（Postgres 存储过程）
  async function cloudRPC(name, params) {
    const res = await fetch(CLOUD.URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: cloudHeaders(),
      body: JSON.stringify(params || {})
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const t = await res.text(); if (t) msg += ': ' + t; } catch (_) {}
      throw new Error('云端 [' + name + '] 失败：' + msg);
    }
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return body;
  }

  // 查询 public.users 表，返回 {username, pwd_hash, salt} 或 null
  async function cloudGetUserRecord(username) {
    const u = encodeURIComponent(String(username || '').toLowerCase());
    const res = await fetch(CLOUD.URL + '/rest/v1/users?username=eq.' + u + '&select=username,pwd_hash,salt&limit=1', {
      method: 'GET',
      headers: {
        'apikey': CLOUD.ANON_KEY,
        'Authorization': 'Bearer ' + CLOUD.ANON_KEY,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      if (res.status === 404) return null; // 没建表也不报硬错
      throw new Error('云端查询用户失败：HTTP ' + res.status);
    }
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  // 查询 public.progress 表（答题/错题 blob）
  async function cloudGetProgress(username) {
    const u = encodeURIComponent(String(username || '').toLowerCase());
    const res = await fetch(CLOUD.URL + '/rest/v1/progress?username=eq.' + u + '&select=wrong,hist,settings,updated_at&limit=1', {
      method: 'GET',
      headers: {
        'apikey': CLOUD.ANON_KEY,
        'Authorization': 'Bearer ' + CLOUD.ANON_KEY,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[0];
  }

  // 云端注册（POST /rpc/register_user），失败返回 null，成功返回 {ok:true}
  async function cloudRegisterUser(username, pwdHash, salt) {
    try {
      await cloudRPC('register_user', {
        p_username: String(username || '').toLowerCase(),
        p_pwd_hash: pwdHash,
        p_salt: salt
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // 云端推送进度（POST /rpc/sync_progress_to_cloud）
  async function cloudPushProgress(username, wrongBlob, histBlob, settingsBlob) {
    try {
      await cloudRPC('sync_progress_to_cloud', {
        p_username: String(username || '').toLowerCase(),
        p_wrong: wrongBlob || {},
        p_hist: histBlob || {},
        p_settings: settingsBlob || {}
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ============== 账号模块 ==============
  const K_USERS = 'sdzj_users';   // 全量用户表 { username: { pwdHash, createdAt, salt } }
  const K_REMEMBER = 'sdzj_remember'; // 记住的账号 { username, pwdHash (可选) }
  // 命名空间前缀：每个用户的数据分开；访客用 '_guest_'
  const NS_GUEST = '_guest_';
  let currentUser = NS_GUEST;

  function nsKey(k) {
    return 'sdzj_' + currentUser + '_' + k;
  }

  function load(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  // 简易 SHA-256（Web Crypto 原生，不需要外部库）
  async function sha256(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function getUsers() { return load(K_USERS, {}); }
  function setUsers(u) { save(K_USERS, u); }

  async function register(username, password) {
    username = (username || '').trim();
    if (!username) throw new Error('请输入用户名');
    if (username.length < 2) throw new Error('用户名至少 2 个字符');
    if (!password || password.length < 4) throw new Error('密码至少 4 位');
    const users = getUsers();
    if (users[username]) throw new Error('用户名已存在');
    const salt = Math.random().toString(36).slice(2, 10);
    const pwdHash = await sha256(salt + '::' + password);
    users[username] = { pwdHash, salt, createdAt: Date.now() };
    setUsers(users);

    // 云端注册：失败不阻断（离线/表未建）但给控制台记录
    if (CLOUD.ENABLED) {
      try {
        const r = await cloudRegisterUser(username, pwdHash, salt);
        if (!r.ok) console.warn('云端注册失败（本地已注册成功）：', r.error);
      } catch (_) {}
    }
    return await login(username, password, true);
  }

  async function login(username, password, remember) {
    username = (username || '').trim();
    const users = getUsers();
    let u = users[username];

    // ========== 云端优先校验 ==========
    // 1) 如果本地没这个账号，但云端存在：从云端拉回用户表再落本地（允许"先在电脑注册→手机直接登录"场景）
    if (!u && CLOUD.ENABLED) {
      try {
        const cloudUser = await cloudGetUserRecord(username);
        if (cloudUser) {
          // 本地补录用户表
          users[username] = { pwdHash: cloudUser.pwd_hash, salt: cloudUser.salt, createdAt: Date.now(), fromCloud: true };
          setUsers(users);
          u = users[username];
        }
      } catch (e) {
        console.warn('云端查询用户失败（尝试本地降级）：', e);
      }
    }

    if (!u) throw new Error('用户不存在（若注册/登录在其他设备，请先联网后再登录一次）');

    const pwdHash = await sha256(u.salt + '::' + password);
    if (pwdHash !== u.pwdHash) throw new Error('密码错误');

    currentUser = username;

    // ========== 登录后：拉云端进度合并到本地 ==========
    if (CLOUD.ENABLED) {
      try {
        const cloudProg = await cloudGetProgress(username);
        if (cloudProg) {
          // merge 模式：云端 blob 和本地 blob 各自按"取大值/并集"合并
          const ns = 'sdzj_' + username + '_';
          mergeRemoteBlob(ns + 'wrong', cloudProg.wrong, mergeWrong);
          mergeRemoteBlob(ns + 'hist', cloudProg.hist, mergeHist);
          mergeRemoteBlob(ns + 'set', cloudProg.settings, (l, r) => Object.assign({}, r || {}, l || {}));
        }
      } catch (e) {
        console.warn('拉取云端进度失败（离线也能正常用本地进度）：', e);
      }
    }

    // 记住账号
    const prev = load(K_REMEMBER, null);
    if (remember) save(K_REMEMBER, { username, autoLogin: true });
    else if (prev && prev.username === username) save(K_REMEMBER, { username, autoLogin: false });
    return { username };
  }

  // 工具：把云端拉回的 blob 合并回 localStorage（按提供的 merge fn）
  function mergeRemoteBlob(key, remoteBlob, mergeFn) {
    let local; try { const v = localStorage.getItem(key); local = v ? JSON.parse(v) : null; } catch (_) { local = null; }
    const merged = mergeFn(local, remoteBlob);
    try { localStorage.setItem(key, JSON.stringify(merged || {})); } catch (_) {}
  }
  function mergeWrong(local, remote) {
    const merged = Object.assign({}, local || {});
    for (const id of Object.keys(remote || {})) {
      const l = merged[id], r = remote[id];
      if (!l) merged[id] = r;
      else merged[id] = { count: Math.max(+l.count|0, +r.count|0), ts: Math.max(+l.ts|0, +r.ts|0), bank: l.bank || r.bank };
    }
    return merged;
  }
  function mergeHist(local, remote) {
    const merged = Object.assign({}, local || {});
    for (const id of Object.keys(remote || {})) {
      const l = merged[id], r = remote[id];
      if (!l) merged[id] = r;
      else merged[id] = {
        seen: Math.max(+l.seen|0, +r.seen|0),
        correct: Math.max(+l.correct|0, +r.correct|0),
        wrong: Math.max(+l.wrong|0, +r.wrong|0),
        ts: Math.max(+l.ts|0, +r.ts|0),
        bank: l.bank || r.bank
      };
    }
    return merged;
  }

  function autoLogin() {
    // 自动登录（只填用户名，不存密码；因为密码不可逆，这里用 "记住账号下次自动填用户名" 策略；
    // 如需真正免输密码自动登录，可选存 pwdHash，下面代码已预留切换）
    const r = load(K_REMEMBER, null);
    if (r && r.username && r.autoLogin) {
      // 只自动填用户名（免验证直接登录 = 信任本地单用户场景）
      const users = getUsers();
      if (users[r.username]) {
        currentUser = r.username;
        return { username: r.username, auto: true };
      }
    }
    return null;
  }
  function rememberUsername() {
    const r = load(K_REMEMBER, null);
    return r ? r.username : '';
  }
  function logout() {
    const r = load(K_REMEMBER, null);
    // 退出时保留用户名填充，但不自动登录
    if (r) save(K_REMEMBER, { username: r.username, autoLogin: false });
    currentUser = NS_GUEST;
  }
  function who() {
    return currentUser === NS_GUEST ? null : currentUser;
  }
  function isGuest() {
    return currentUser === NS_GUEST;
  }
  function switchUser(username) {
    const users = getUsers();
    if (username === null || username === undefined) { currentUser = NS_GUEST; return; }
    if (!users[username]) throw new Error('用户不存在');
    currentUser = username;
    const r = load(K_REMEMBER, null) || {};
    save(K_REMEMBER, Object.assign(r, { username, autoLogin: false }));
  }
  function listAccounts() {
    return Object.keys(getUsers());
  }

  // ============== 业务数据（按账号命名空间） ==============
  const K = { wrong: 'wrong', hist: 'hist', set: 'set' };

  // 错题: { id: {count, ts, bank} }
  const wrong = () => load(nsKey(K.wrong), {});
  const setWrong = o => save(nsKey(K.wrong), o);

  // 历史: { id: {seen, correct, wrong, ts, bank} }
  const hist = () => load(nsKey(K.hist), {});
  const setHist = o => save(nsKey(K.hist), o);

  // 设置
  const settings = () => load(nsKey(K.set), {});
  const setSettings = o => save(nsKey(K.set), Object.assign(settings(), o));

  // ---- 错题 API ----
  function getWrongIds() { return Object.keys(wrong()).map(Number).sort((a, b) => {
    const A = wrong()[a], B = wrong()[b]; return (B.ts || 0) - (A.ts || 0); }); }
  function isWrong(id) { return !!wrong()[id]; }
  function addWrong(id, bank) {
    const o = wrong(); const e = o[id] || { count: 0, ts: 0, bank };
    e.count++; e.ts = Date.now(); e.bank = bank; o[id] = e; setWrong(o);
  }
  function removeWrong(id) { const o = wrong(); delete o[id]; setWrong(o); }
  function clearWrong() { setWrong({}); }
  function wrongCount() { return Object.keys(wrong()).length; }

  // ---- 做题历史 API ----
  function recordAnswer(id, correct, bank) {
    const h = hist(); const e = h[id] || { seen: 0, correct: 0, wrong: 0, ts: 0, bank };
    e.seen++; e.correct += correct ? 1 : 0; e.wrong += correct ? 0 : 1;
    e.ts = Date.now(); e.bank = bank; h[id] = e; setHist(h);
    if (correct) removeWrong(id); else addWrong(id, bank);
  }
  function qStat(id) { return hist()[id] || { seen: 0, correct: 0, wrong: 0 }; }
  function doneIds() { return Object.keys(hist()).map(Number); }
  function isDone(id) { return !!hist()[id]; }

  // 全局统计
  function globalStats() {
    const h = hist();
    let answered = 0, correct = 0;
    for (const id in h) { answered++; correct += h[id].correct; }
    return { answered, correct, rate: answered ? Math.round(correct / answered * 100) : 0,
             wrong: wrongCount(), total: 0 };
  }

  // 按题库统计
  function bankStats(bank) {
    const h = hist(); let a = 0, c = 0;
    for (const id in h) if (h[id].bank === bank) { a++; c += h[id].correct; }
    return { answered: a, correct: c, rate: a ? Math.round(c / a * 100) : 0 };
  }

  // ---- 智能练题权重 ----
  function smartWeights(allIds) {
    const h = hist(); const w = wrong();
    const weights = allIds.map(id => {
      if (w[id]) return 10;
      const s = h[id];
      if (!s) return 5;
      const r = s.correct / s.seen;
      if (r < 0.6) return 8;
      if (r < 0.85) return 4;
      return 1;
    });
    return weights;
  }

  function pickWeighted(allIds, n) {
    const w = smartWeights(allIds);
    const pool = allIds.map((id, i) => ({ id, w: w[i] }));
    const picked = [];
    while (picked.length < n && pool.length) {
      let r = Math.random() * (pool.reduce((a, p) => a + p.w, 0));
      let idx = 0;
      for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
      picked.push(pool[idx].id); pool.splice(idx, 1);
    }
    return picked;
  }

  // ============== 导入 / 导出（用于跨设备迁移） ==============
  const NS_PREFIX = 'sdzj_';
  const NS_KEYS = [K_USERS, K_REMEMBER, 'current-user']; // 账号相关固定 key

  /** 导出所有账号 + 各账号的错题/历史/设置。返回可 JSON.stringify 的对象 */
  function exportAll() {
    const dump = { version: 1, exportedAt: Date.now(), users: {}, data: {}, remember: null };
    // 1. 全量用户表（含 pwdHash/salt，保证导入后密码能校验）
    dump.users = getUsers();
    // 2. 记住的账号信息
    dump.remember = load(K_REMEMBER, null);
    // 3. 对每个账号分别导出 wrong/hist/set 命名空间数据
    for (const u of Object.keys(dump.users)) {
      const ns = NS_PREFIX + u + '_';
      const dataOfUser = {};
      for (const suffix of Object.values(K)) {
        const fullKey = ns + suffix;
        const v = localStorage.getItem(fullKey);
        if (v != null) { try { dataOfUser[suffix] = JSON.parse(v); } catch (_) {} }
      }
      dump.data[u] = dataOfUser;
    }
    // 4. 访客也顺手导出（可选，不强求）
    const guestNs = NS_PREFIX + NS_GUEST + '_';
    const guestData = {};
    for (const suffix of Object.values(K)) {
      const fullKey = guestNs + suffix;
      const v = localStorage.getItem(fullKey);
      if (v != null) { try { guestData[suffix] = JSON.parse(v); } catch (_) {} }
    }
    if (Object.keys(guestData).length) dump.data[NS_GUEST] = guestData;
    return dump;
  }

  /**
   * 导入 exportAll 导出的对象
   * @param {*} dump 
   * @param {object} opts
   *   mode: 'merge'  默认：同名账号双方的数据合并（错题并集、统计取 max(seen/correct/wrong)）
   *         'replace'：同名账号本地旧数据被导入覆盖
   * @returns { importedUsers: string[], failed: string[] } 导入了哪些账号
   */
  function importAll(dump, opts) {
    opts = opts || { mode: 'merge' };
    if (!dump || typeof dump !== 'object' || !dump.users || typeof dump.users !== 'object') {
      throw new Error('文件格式不合法：缺少 users 字段');
    }
    const imported = []; const failed = [];
    const oldUsers = getUsers();
    const newUsers = Object.assign({}, oldUsers);
    // 先合并用户表：新账号直接加，同名账号保留密码不变（导入的密码也可能不一样，都保留本地的密码为准，
    // 因为用户通常自己记得自己的密码；如果本地无此账号，就用导入的 pwdHash/salt）
    for (const u of Object.keys(dump.users)) {
      if (!newUsers[u]) newUsers[u] = dump.users[u];
    }
    setUsers(newUsers);

    // 再合并每个账号的数据
    for (const u of Object.keys(dump.data || {})) {
      try {
        const dataOfUser = dump.data[u];
        const ns = NS_PREFIX + u + '_';
        for (const suffix of Object.values(K)) {
          if (!(suffix in dataOfUser)) continue;
          const fullKey = ns + suffix;
          if (opts.mode === 'replace') {
            save(fullKey, dataOfUser[suffix]);
            continue;
          }
          // merge 模式：不同类型分别合并
          const local = load(fullKey, null) || {};
          const remote = dataOfUser[suffix];
          if (suffix === K.wrong) {
            // 错题：并集，取更高的 count / 更晚的 ts
            const merged = Object.assign({}, local);
            for (const id of Object.keys(remote)) {
              const l = merged[id], r = remote[id];
              if (!l) merged[id] = r;
              else merged[id] = { count: Math.max(+l.count|0, +r.count|0), ts: Math.max(+l.ts|0, +r.ts|0), bank: l.bank || r.bank };
            }
            save(fullKey, merged);
          } else if (suffix === K.hist) {
            // hist：逐题取 max(seen/correct/wrong/ts)
            const merged = Object.assign({}, local);
            for (const id of Object.keys(remote)) {
              const l = merged[id], r = remote[id];
              if (!l) merged[id] = r;
              else merged[id] = {
                seen: Math.max(+l.seen|0, +r.seen|0),
                correct: Math.max(+l.correct|0, +r.correct|0),
                wrong: Math.max(+l.wrong|0, +r.wrong|0),
                ts: Math.max(+l.ts|0, +r.ts|0),
                bank: l.bank || r.bank
              };
            }
            save(fullKey, merged);
          } else if (suffix === K.set) {
            save(fullKey, Object.assign({}, remote, local)); // 本地优先
          } else {
            save(fullKey, Object.assign({}, local || {}, remote || {}));
          }
        }
        imported.push(u);
      } catch (e) {
        failed.push(u + '(' + (e.message || e) + ')');
      }
    }
    // 导入 remember：只导入当前本地没有记住任何账号时才写，避免覆盖用户自己选中的"记住"
    if (dump.remember && !load(K_REMEMBER, null)) save(K_REMEMBER, dump.remember);
    return { imported, failed };
  }

  function toJSONFile(dump) {
    return JSON.stringify(dump, null, 2);
  }

  // ========== 云端同步对外 API ==========
  function cloudEnabled() { return !!CLOUD.ENABLED; }

  /** 把当前登录用户的本地进度推一次到云端（每 60s 会被 app.js 调用） */
  async function cloudPushNow() {
    if (!CLOUD.ENABLED) return { ok: false, reason: 'cloud disabled' };
    const u = who();
    if (!u) return { ok: false, reason: 'guest' };
    try {
      const wrongBlob = load('sdzj_' + u + '_wrong', {});
      const histBlob = load('sdzj_' + u + '_hist', {});
      const settingsBlob = load('sdzj_' + u + '_set', {});
      return await cloudPushProgress(u, wrongBlob, histBlob, settingsBlob);
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  /** 手动拉一次云端进度并合并 */
  async function cloudPullNow() {
    if (!CLOUD.ENABLED) return { ok: false, reason: 'cloud disabled' };
    const u = who();
    if (!u) return { ok: false, reason: 'guest' };
    try {
      const cloudProg = await cloudGetProgress(u);
      if (!cloudProg) return { ok: true, nothing: true };
      const ns = 'sdzj_' + u + '_';
      mergeRemoteBlob(ns + 'wrong', cloudProg.wrong, mergeWrong);
      mergeRemoteBlob(ns + 'hist', cloudProg.hist, mergeHist);
      mergeRemoteBlob(ns + 'set', cloudProg.settings, (l, r) => Object.assign({}, r || {}, l || {}));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ========== 挂到 window.Store ==========
  window.Store = {
    // 用户
    register, login, autoLogin, rememberUsername, logout, who, isGuest, switchUser, listAccounts, sha256,
    // 业务
    getWrongIds, isWrong, addWrong, removeWrong, clearWrong, wrongCount,
    recordAnswer, qStat, doneIds, isDone, globalStats, bankStats,
    smartWeights, pickWeighted,
    settings, setSettings,
    // 跨设备迁移
    exportAll, importAll, toJSONFile,
    // 云端同步
    cloudEnabled, cloudPushNow, cloudPullNow,
  };
})();
