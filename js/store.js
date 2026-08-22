/* store.js — localStorage 状态：用户/错题/统计/设置（按账号命名空间隔离） */
const Store = (() => {
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
    return await login(username, password, true);
  }

  async function login(username, password, remember) {
    username = (username || '').trim();
    const users = getUsers();
    const u = users[username];
    if (!u) throw new Error('用户不存在');
    const pwdHash = await sha256(u.salt + '::' + password);
    if (pwdHash !== u.pwdHash) throw new Error('密码错误');
    currentUser = username;
    // 记住账号
    const prev = load(K_REMEMBER, null);
    if (remember) save(K_REMEMBER, { username, autoLogin: true });
    else if (prev && prev.username === username) save(K_REMEMBER, { username, autoLogin: false });
    return { username };
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

  return {
    // 用户
    register, login, autoLogin, rememberUsername, logout, who, isGuest, switchUser, listAccounts, sha256,
    // 业务
    getWrongIds, isWrong, addWrong, removeWrong, clearWrong, wrongCount,
    recordAnswer, qStat, doneIds, isDone, globalStats, bankStats,
    smartWeights, pickWeighted,
    settings, setSettings
  };
})();
