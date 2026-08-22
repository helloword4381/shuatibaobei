/* store.js — 本地状态层
 * 职责：
 *   1) 账号系统：注册 / 登录（SHA-256+盐）/ 记住账号 / 切换 / 导入导出
 *   2) 业务数据：错题、做题历史、设置（按账号命名空间隔离，访客用 _guest_）
 *   3) Supabase 云端同步：云端注册、进度推送 / 拉取合并
 * 存储：localStorage，键规则 sdzj_<用户名>_<wrong|hist|set>
 */
(function () {
  'use strict';

  // ==================== Supabase 云端配置 ====================
  // anon key 本身是公开的客户端密钥（配合 RLS 策略使用），允许出现在前端代码中
  const CLOUD = {
    ENABLED: true,
    URL: 'https://tbdvkitjtcswwxthxbft.supabase.co',
    ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiZHZraXRqdGNzd3d4dGh4YmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczOTMzMzAsImV4cCI6MjEwMjk2OTMzMH0.DvOLX14AHrUMCjSHGfN9VDsyARM0i66FkrDZJpEOc30'
  };

  function cloudHeaders(extra) {
    return Object.assign({
      'apikey': CLOUD.ANON_KEY,
      'Authorization': 'Bearer ' + CLOUD.ANON_KEY,
    }, extra || {});
  }

  /** 调用 Postgres 存储过程（RPC） */
  async function cloudRPC(name, params) {
    const res = await fetch(CLOUD.URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: cloudHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
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

  /** 查询 public.users 表，返回 {username, pwd_hash, salt} 或 null */
  async function cloudGetUserRecord(username) {
    const u = encodeURIComponent(String(username || '').toLowerCase());
    const res = await fetch(CLOUD.URL + '/rest/v1/users?username=eq.' + u + '&select=username,pwd_hash,salt&limit=1', {
      method: 'GET',
      headers: cloudHeaders({ 'Accept': 'application/json' })
    });
    if (!res.ok) {
      if (res.status === 404) return null; // 没建表也不报硬错
      throw new Error('云端查询用户失败：HTTP ' + res.status);
    }
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  /** 查询 public.progress 表，返回 {wrong, hist, settings, updated_at} 或 null */
  async function cloudGetProgress(username) {
    const u = encodeURIComponent(String(username || '').toLowerCase());
    const res = await fetch(CLOUD.URL + '/rest/v1/progress?username=eq.' + u + '&select=wrong,hist,settings,updated_at&limit=1', {
      method: 'GET',
      headers: cloudHeaders({ 'Accept': 'application/json' })
    });
    if (!res.ok) return null;
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  /** 云端注册（失败返回 {ok:false, error}，不抛出） */
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

  /** 云端推送进度（失败返回 {ok:false, error}，不抛出） */
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

  // ==================== localStorage 基础封装 ====================
  function load(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /** 简易 SHA-256（Web Crypto 原生，不依赖外部库） */
  async function sha256(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ==================== 账号模块 ====================
  const K_USERS = 'sdzj_users';      // 全量用户表 { username: { pwdHash, salt, createdAt } }
  const K_REMEMBER = 'sdzj_remember'; // 记住的账号 { username, autoLogin }
  const NS_GUEST = '_guest_';        // 访客命名空间
  const NS_PREFIX = 'sdzj_';

  let currentUser = NS_GUEST;

  /** 拼出某用户的业务数据键：sdzj_<user>_<k> */
  function nsKeyFor(user, k) { return NS_PREFIX + user + '_' + k; }
  function nsKey(k) { return nsKeyFor(currentUser, k); }

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

    // 云端注册：失败不阻断本地流程（离线/表未建），仅控制台记录
    if (CLOUD.ENABLED) {
      try {
        const r = await cloudRegisterUser(username, pwdHash, salt);
        if (!r.ok) console.warn('云端注册失败（本地已注册成功）：', r.error);
      } catch (_) {}
    }
    return await login(username, password, true); // 注册后直接登录（默认记住）
  }

  async function login(username, password, remember) {
    username = (username || '').trim();
    const users = getUsers();
    let u = users[username];

    // 本地无此账号时尝试从云端拉回（"先在电脑注册→手机直接登录"场景）
    if (!u && CLOUD.ENABLED) {
      try {
        const cloudUser = await cloudGetUserRecord(username);
        if (cloudUser) {
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

    // 登录后拉取云端进度并合并到本地（离线时跳过，本地进度照常可用）
    if (CLOUD.ENABLED) {
      try {
        const cloudProg = await cloudGetProgress(username);
        if (cloudProg) {
          mergeRemoteBlob(nsKeyFor(username, K.wrong), cloudProg.wrong, mergeWrong);
          mergeRemoteBlob(nsKeyFor(username, K.hist), cloudProg.hist, mergeHist);
          mergeRemoteBlob(nsKeyFor(username, K.set), cloudProg.settings, (l, r) => Object.assign({}, r || {}, l || {}));
        }
      } catch (e) {
        console.warn('拉取云端进度失败（离线也能正常用本地进度）：', e);
      }
    }

    // 记住账号：勾选则下次自动登录；取消勾选只保留用户名
    const prev = load(K_REMEMBER, null);
    if (remember) save(K_REMEMBER, { username, autoLogin: true });
    else if (prev && prev.username === username) save(K_REMEMBER, { username, autoLogin: false });
    return { username };
  }

  /** 自动登录：本地记住且 autoLogin 时直接信任本机（不重输密码） */
  function autoLogin() {
    const r = load(K_REMEMBER, null);
    if (r && r.username && r.autoLogin && getUsers()[r.username]) {
      currentUser = r.username;
      return { username: r.username, auto: true };
    }
    return null;
  }

  function rememberUsername() {
    const r = load(K_REMEMBER, null);
    return r ? r.username : '';
  }

  function logout() {
    const r = load(K_REMEMBER, null);
    if (r) save(K_REMEMBER, { username: r.username, autoLogin: false }); // 保留用户名填充
    currentUser = NS_GUEST;
  }

  function who() { return currentUser === NS_GUEST ? null : currentUser; }
  function isGuest() { return currentUser === NS_GUEST; }

  /** 切换到本地已存在的账号（免密，信任本机）；username 为 null 时切到访客 */
  function switchUser(username) {
    if (username === null || username === undefined) { currentUser = NS_GUEST; return; }
    if (!getUsers()[username]) throw new Error('用户不存在');
    currentUser = username;
    const r = load(K_REMEMBER, null) || {};
    save(K_REMEMBER, Object.assign(r, { username, autoLogin: false }));
  }

  function listAccounts() { return Object.keys(getUsers()); }

  // ==================== 业务数据（按账号命名空间） ====================
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
  function getWrongIds() {
    const w = wrong();
    return Object.keys(w)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => ((w[b] && w[b].ts) || 0) - ((w[a] && w[a].ts) || 0));
  }
  function isWrong(id) { return !!wrong()[id]; }
  function addWrong(id, bank) {
    const o = wrong();
    const e = o[id] || { count: 0, ts: 0, bank };
    e.count++; e.ts = Date.now(); e.bank = bank;
    o[id] = e;
    setWrong(o);
  }
  function removeWrong(id) { const o = wrong(); delete o[id]; setWrong(o); }
  function clearWrong() { setWrong({}); }
  function wrongCount() { return Object.keys(wrong()).length; }

  // ---- 做题历史 API ----
  function recordAnswer(id, correct, bank) {
    const h = hist();
    const e = h[id] || { seen: 0, correct: 0, wrong: 0, ts: 0, bank };
    e.seen++; e.correct += correct ? 1 : 0; e.wrong += correct ? 0 : 1;
    e.ts = Date.now(); e.bank = bank;
    h[id] = e;
    setHist(h);
    if (correct) removeWrong(id); else addWrong(id, bank);
  }
  function qStat(id) { return hist()[id] || { seen: 0, correct: 0, wrong: 0 }; }
  function doneIds() { return Object.keys(hist()).map(Number); }
  function isDone(id) { return !!hist()[id]; }

  // ---- 统计 ----
  function globalStats() {
    const h = hist();
    let answered = 0, correct = 0;
    for (const id in h) { answered++; correct += h[id].correct; }
    return { answered, correct, rate: answered ? Math.round(correct / answered * 100) : 0,
             wrong: wrongCount(), total: 0 };
  }

  function bankStats(bank) {
    const h = hist();
    let a = 0, c = 0;
    for (const id in h) if (h[id].bank === bank) { a++; c += h[id].correct; }
    return { answered: a, correct: c, rate: a ? Math.round(c / a * 100) : 0 };
  }

  // ---- 智能练题权重 ----
  // 权重规则：错题 10；未做过 5；正确率<60% 8；<85% 4；其余 1
  function smartWeights(allIds) {
    const h = hist();
    const w = wrong();
    return allIds.map(id => {
      if (w[id]) return 10;
      const s = h[id];
      if (!s) return 5;
      const r = s.correct / s.seen;
      if (r < 0.6) return 8;
      if (r < 0.85) return 4;
      return 1;
    });
  }

  /** 按权重不放回抽取 n 个 id */
  function pickWeighted(allIds, n) {
    const w = smartWeights(allIds);
    const pool = allIds.map((id, i) => ({ id, w: w[i] }));
    const picked = [];
    while (picked.length < n && pool.length) {
      let r = Math.random() * pool.reduce((a, p) => a + p.w, 0);
      let idx = 0;
      for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
      picked.push(pool[idx].id);
      pool.splice(idx, 1);
    }
    return picked;
  }

  // ==================== 云端进度合并（错题/历史取并集与最大值） ====================
  function mergeWrong(local, remote) {
    const merged = Object.assign({}, local || {});
    for (const id of Object.keys(remote || {})) {
      const l = merged[id], r = remote[id];
      if (!l) merged[id] = r;
      else merged[id] = { count: Math.max(+l.count | 0, +r.count | 0), ts: Math.max(+l.ts | 0, +r.ts | 0), bank: l.bank || r.bank };
    }
    return merged;
  }
  function mergeHist(local, remote) {
    const merged = Object.assign({}, local || {});
    for (const id of Object.keys(remote || {})) {
      const l = merged[id], r = remote[id];
      if (!l) merged[id] = r;
      else merged[id] = {
        seen: Math.max(+l.seen | 0, +r.seen | 0),
        correct: Math.max(+l.correct | 0, +r.correct | 0),
        wrong: Math.max(+l.wrong | 0, +r.wrong | 0),
        ts: Math.max(+l.ts | 0, +r.ts | 0),
        bank: l.bank || r.bank
      };
    }
    return merged;
  }

  /** 把云端拉回的 blob 按 mergeFn 合并写入 localStorage */
  function mergeRemoteBlob(key, remoteBlob, mergeFn) {
    const local = load(key, null);
    const merged = mergeFn(local, remoteBlob);
    save(key, merged || {});
  }

  // ==================== 导入 / 导出（跨设备迁移） ====================

  /** 导出所有账号 + 各账号的错题/历史/设置 */
  function exportAll() {
    const dump = { version: 1, exportedAt: Date.now(), users: {}, data: {}, remember: null };
    dump.users = getUsers();
    dump.remember = load(K_REMEMBER, null);
    const users = Object.keys(dump.users).concat(NS_GUEST); // 访客数据也导出
    for (const u of users) {
      const dataOfUser = {};
      for (const suffix of Object.values(K)) {
        const v = localStorage.getItem(nsKeyFor(u, suffix));
        if (v != null) { try { dataOfUser[suffix] = JSON.parse(v); } catch (_) {} }
      }
      if (Object.keys(dataOfUser).length) dump.data[u] = dataOfUser;
    }
    return dump;
  }

  /**
   * 导入 exportAll 导出的对象
   * @param {*} dump
   * @param {object} opts mode: 'merge'（默认，同名账号数据合并）
   *                      | 'replace'（同名账号本地旧数据被覆盖）
   * @returns { importedUsers: string[], failed: string[] }
   */
  function importAll(dump, opts) {
    opts = opts || { mode: 'merge' };
    if (!dump || typeof dump !== 'object' || !dump.users || typeof dump.users !== 'object') {
      throw new Error('文件格式不合法：缺少 users 字段');
    }
    const imported = [], failed = [];
    const newUsers = Object.assign({}, getUsers());
    // 合并用户表：新账号直接加；同名账号保留本地密码
    for (const u of Object.keys(dump.users)) {
      if (!newUsers[u]) newUsers[u] = dump.users[u];
    }
    setUsers(newUsers);

    for (const u of Object.keys(dump.data || {})) {
      try {
        const dataOfUser = dump.data[u];
        for (const suffix of Object.values(K)) {
          if (!(suffix in dataOfUser)) continue;
          const fullKey = nsKeyFor(u, suffix);
          if (opts.mode === 'replace') {
            save(fullKey, dataOfUser[suffix]);
            continue;
          }
          const local = load(fullKey, null) || {};
          const remote = dataOfUser[suffix];
          if (suffix === K.wrong) save(fullKey, mergeWrong(local, remote));
          else if (suffix === K.hist) save(fullKey, mergeHist(local, remote));
          else save(fullKey, Object.assign({}, remote, local)); // 设置：本地优先
        }
        imported.push(u);
      } catch (e) {
        failed.push(u + '(' + (e.message || e) + ')');
      }
    }
    // 只在本地没有记住任何账号时才导入 remember，避免覆盖用户自己的选择
    if (dump.remember && !load(K_REMEMBER, null)) save(K_REMEMBER, dump.remember);
    return { imported, failed };
  }

  // ==================== 云端同步对外 API ====================

  function cloudEnabled() { return !!CLOUD.ENABLED; }

  /** 把当前登录用户的本地进度推一次到云端（app.js 每 60s 调用） */
  async function cloudPushNow() {
    if (!CLOUD.ENABLED) return { ok: false, reason: 'cloud disabled' };
    const u = who();
    if (!u) return { ok: false, reason: 'guest' };
    try {
      const wrongBlob = load(nsKeyFor(u, K.wrong), {});
      const histBlob = load(nsKeyFor(u, K.hist), {});
      const settingsBlob = load(nsKeyFor(u, K.set), {});
      return await cloudPushProgress(u, wrongBlob, histBlob, settingsBlob);
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  /** 手动拉一次云端进度并合并到本地 */
  async function cloudPullNow() {
    if (!CLOUD.ENABLED) return { ok: false, reason: 'cloud disabled' };
    const u = who();
    if (!u) return { ok: false, reason: 'guest' };
    try {
      const cloudProg = await cloudGetProgress(u);
      if (!cloudProg) return { ok: true, nothing: true };
      mergeRemoteBlob(nsKeyFor(u, K.wrong), cloudProg.wrong, mergeWrong);
      mergeRemoteBlob(nsKeyFor(u, K.hist), cloudProg.hist, mergeHist);
      mergeRemoteBlob(nsKeyFor(u, K.set), cloudProg.settings, (l, r) => Object.assign({}, r || {}, l || {}));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ==================== 挂到 window.Store ====================
  window.Store = {
    // 用户
    register, login, autoLogin, rememberUsername, logout, who, isGuest, switchUser, listAccounts,
    // 业务
    getWrongIds, isWrong, addWrong, removeWrong, clearWrong, wrongCount,
    recordAnswer, qStat, doneIds, isDone, globalStats, bankStats,
    smartWeights, pickWeighted,
    settings, setSettings,
    // 跨设备迁移
    exportAll, importAll,
    // 云端同步
    cloudEnabled, cloudPushNow, cloudPullNow,
  };
})();
