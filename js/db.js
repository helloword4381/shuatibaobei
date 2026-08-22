/* db.js — 题库数据层
 * 职责：
 *   1) 用 sql.js（SQLite WASM）加载题库，数据库文件缓存于 IndexedDB
 *   2) 提供题目查询接口（抽题 / 按 id 取题 / 统计）
 *   3) 从 GitHub 检测并下载题库更新（多 URL 容错 + 下载进度）
 */
const DB = (() => {
  const IDB_NAME = 'shuatibaobei', IDB_STORE = 'kv';
  const KEY_DB = 'question_db', KEY_VER = 'version';
  const GITHUB_MANIFEST = 'https://raw.githubusercontent.com/helloword4381/shuatibaobei/main/manifest.json';
  const GITHUB_DB = 'https://raw.githubusercontent.com/helloword4381/shuatibaobei/main/shuatibaobei.db';
  const LOCAL_DB = 'shuatibaobei.db';

  let SQL = null;      // sql.js 模块
  let sqlite = null;   // 当前打开的 SQLite 数据库实例
  let ready = false;
  let curVersion = null;
  let curMeta = null;

  // ==================== IndexedDB 简易封装（仅 kv 存取） ====================
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(IDB_STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(val, key);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
  }
  async function idbDel(key) {
    const db = await idb();
    return new Promise((res) => {
      const t = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(key);
      t.onsuccess = () => res(); t.onerror = () => res();
    });
  }

  // ==================== sql.js 初始化与装载 ====================
  async function initSql() {
    if (SQL) return SQL;
    SQL = await initSqlJs({ locateFile: f => 'js/' + f });
    return SQL;
  }

  function loadIntoSql(bytes) {
    if (sqlite) { try { sqlite.close(); } catch (e) {} }
    sqlite = new SQL.Database(bytes);
    ready = true;
  }

  /** 读取 meta 表为 {key: value} */
  function readMeta() {
    try {
      const r = sqlite.exec("SELECT key,value FROM meta");
      if (!r.length) return {};
      const m = {};
      for (const row of r[0].values) m[row[0]] = row[1];
      return m;
    } catch (e) { return {}; }
  }

  // ==================== 初始化（缓存优先，回退本地打包 DB） ====================
  async function init(onStatus) {
    const say = m => onStatus && onStatus(m);
    say('正在加载题库…');
    await initSql();

    // 1. IndexedDB 缓存的数据库
    let buf = await idbGet(KEY_DB);
    if (buf) {
      loadIntoSql(new Uint8Array(buf));
      curMeta = readMeta();
      curVersion = curMeta.version || (await idbGet(KEY_VER)) || 'local';
      say('题库已就绪');
      return { source: 'cache', version: curVersion, meta: curMeta };
    }

    // 2. 回退到本地打包的 DB
    try {
      const resp = await fetch(LOCAL_DB);
      buf = await resp.arrayBuffer();
      loadIntoSql(new Uint8Array(buf));
      curMeta = readMeta();
      curVersion = curMeta.version || 'local';
      await idbSet(KEY_VER, curVersion);
      say('题库已就绪');
      return { source: 'local', version: curVersion, meta: curMeta };
    } catch (e) {
      say('题库加载失败');
      throw e;
    }
  }

  // ==================== 更新检测与下载 ====================

  /** 依次尝试多个 URL 取远端 manifest（同源优先，GitHub raw 兜底） */
  async function fetchWithFallback(urls) {
    let lastErr;
    for (const u of urls) {
      try {
        const resp = await fetch(u, { cache: 'no-store' });
        if (resp.ok) return resp;
        lastErr = new Error('HTTP ' + resp.status);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('网络失败');
  }

  async function fetchManifest() {
    const resp = await fetchWithFallback([
      'manifest.json',                                          // Pages 同源优先（最快、不跨域）
      (new URL('manifest.json', location.href)).href,           // 兼容带 base 的环境
      GITHUB_MANIFEST,                                          // GitHub main 分支 raw
      GITHUB_MANIFEST.replace('raw.githubusercontent.com', 'raw.gitmirror.com'), // 镜像容错
    ]);
    return await resp.json();
  }

  /** 版本号比较：远端严格大于本地才判定有更新（防止本地版本更新后还被旧 manifest 诱导降级）。
   *  新格式 YYYYMMDD-HHMM 字典序即时间序；对旧格式（纯日期或带 -vN 后缀）先归一化再比。 */
  function cmpVer(a, b) {
    const norm = s => String(s || '')
      .replace(/-\d+$/, m => m.padStart(6, '0'))         // -0120 → -0120 (保证 4 位时分足够对齐)
      .replace(/-v(\d+)/, (_m, n) => '.' + String(n).padStart(3, '0')); // -v2 → .002
    return norm(a).localeCompare(norm(b));
  }

  /** 检查更新：返回 {hasUpdate, remote, local}。hasUpdate 仅在远端严格更新时为 true */
  async function checkUpdate() {
    const remote = await fetchManifest();
    const local = curVersion || (await idbGet(KEY_VER));
    const hasUpdate = cmpVer(String(remote.version), String(local)) > 0;
    return { hasUpdate, remote, local };
  }

  /** 读取响应体，onProgress(percent) 汇报下载进度 */
  async function readBody(resp, onProgress) {
    if (!resp.body || !onProgress) return resp.arrayBuffer();
    const total = +(resp.headers.get('content-length') || 0);
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(total ? Math.round(got / total * 100) : 0);
    }
    const blob = new Blob(chunks);
    // 老浏览器（无 Blob.arrayBuffer）走 Response 兜底
    return blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer();
  }

  /** 下载并应用新题库，返回新版本号 */
  async function downloadUpdate(remote, onProgress) {
    const base = remote && remote.db_url ? remote.db_url : LOCAL_DB;
    const resp = await fetchWithFallback([
      base,
      (new URL(base, location.href)).href,
      GITHUB_DB,
      GITHUB_DB.replace('raw.githubusercontent.com', 'raw.gitmirror.com'),
    ]);
    const buf = await readBody(resp, onProgress);
    loadIntoSql(new Uint8Array(buf));
    curMeta = readMeta();
    curVersion = curMeta.version;
    await idbSet(KEY_DB, buf);
    await idbSet(KEY_VER, curVersion);
    return curVersion;
  }

  // ==================== 查询接口 ====================

  /** 执行 SQL，返回对象数组（自动释放语句） */
  function exec(sql, params = []) {
    if (!ready) throw new Error('DB not ready');
    let stmt;
    try {
      stmt = sqlite.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      if (stmt) try { stmt.free(); } catch (e) {}
    }
  }

  function total() { return exec("SELECT COUNT(*) c FROM questions")[0].c; }

  function listBanks() {
    const r = exec("SELECT DISTINCT bank, bank_title FROM questions ORDER BY bank");
    return r.map(x => ({ bank: x.bank, title: x.bank_title }));
  }

  /** id 数组规整为安全整数列表（防止脏数据注入 SQL） */
  function idList(ids) {
    return (ids || []).map(Number).filter(Number.isInteger);
  }

  /**
   * 抽题
   * @param {object} o bank: 题库编号；types: source_type 列表；
   *                   order: 'seq'|'rand'；limit: 题量；ids: 指定题目 id（优先）
   */
  function pickQuestions({ bank = null, types = null, order = 'seq', limit = 20, ids = null }) {
    ids = idList(ids);
    let sql = "SELECT * FROM questions WHERE 1=1";
    const p = [];
    if (ids.length) {
      sql += " AND id IN (" + ids.join(',') + ")";
    } else {
      if (bank) { sql += " AND bank=?"; p.push(bank); }
      if (types && types.length) {
        sql += " AND source_type IN (" + types.map(() => '?').join(',') + ")";
        p.push(...types);
      }
    }
    sql += " ORDER BY " + (order === 'rand' ? 'RANDOM()' : 'id');
    if (!ids.length) sql += " LIMIT ?";
    const rows = exec(sql, p.concat(ids.length ? [] : [limit]));
    return rows.map(normalizeRow);
  }

  function byIds(ids) {
    ids = idList(ids);
    if (!ids.length) return [];
    return exec("SELECT * FROM questions WHERE id IN (" + ids.join(',') + ") ORDER BY id").map(normalizeRow);
  }

  /** 行数据规范化：options/answer 字段从 JSON 字符串解析为数组 */
  function normalizeRow(r) {
    let opts = [], ans = [];
    try { opts = JSON.parse(r.options); } catch (e) {}
    try { ans = JSON.parse(r.answer); } catch (e) {}
    return {
      id: r.id, bank: r.bank, bank_title: r.bank_title,
      type: r.type, source_type: r.source_type,
      question: r.question, options: opts, answer: ans, analysis: r.analysis || ''
    };
  }

  function meta() { return curMeta; }
  function version() { return curVersion; }

  return { init, checkUpdate, downloadUpdate, total, listBanks,
           pickQuestions, byIds, meta, version, exec };
})();
