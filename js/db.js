/* db.js — sql.js 本地 SQLite + GitHub 更新检测 */
const DB = (() => {
  const IDB_NAME = 'shuatibaobei', IDB_STORE = 'kv', KEY_DB = 'question_db', KEY_VER = 'version';
  const GITHUB_MANIFEST = 'https://raw.githubusercontent.com/helloword4381/shuatibaobei/main/manifest.json';
  const GITHUB_DB = 'https://raw.githubusercontent.com/helloword4381/shuatibaobei/main/shuatibaobei.db';
  const LOCAL_DB = 'shuatibaobei.db';

  let SQL = null, sqlite = null, ready = false;
  let curVersion = null, curMeta = null;

  // ---- IndexedDB 简易封装 ----
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

  // ---- sql.js 初始化 ----
  async function initSql() {
    if (SQL) return SQL;
    SQL = await initSqlJs({ locateFile: f => 'js/' + f });
    return SQL;
  }

  function loadIntoSql(bytes) {
    if (sqlite) { try { sqlite.close(); } catch(e){} }
    sqlite = new SQL.Database(bytes);
    ready = true;
  }

  // 读取 meta 表
  function readMeta() {
    try {
      const r = sqlite.exec("SELECT key,value FROM meta");
      if (!r.length) return {};
      const m = {};
      for (const row of r[0].values) m[row[0]] = row[1];
      return m;
    } catch (e) { return {}; }
  }

  // ---- 公开 API ----
  async function init(onStatus) {
    const say = m => onStatus && onStatus(m);
    say('正在加载题库…');
    await initSql();

    // 1. 优先用 IndexedDB 缓存的 DB
    let buf = await idbGet(KEY_DB);
    if (buf) {
      loadIntoSql(new Uint8Array(buf));
      curMeta = readMeta();
      curVersion = (curMeta.version) || (await idbGet(KEY_VER)) || 'local';
      say('题库已就绪');
      return { source: 'cache', version: curVersion, meta: curMeta };
    }

    // 2. 回退到本地打包 DB
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

  // 获取远端 manifest（同源优先，其次 GitHub raw + 镜像容错）
  async function fetchManifest() {
    const urls = [
      // 1) Pages 同源优先（最快，不跨域）
      'manifest.json',
      // 2) 本地开发时 http 路径也尝试加上 base
      (new URL('manifest.json', location.href)).href,
      // 3) GitHub main 分支 raw
      GITHUB_MANIFEST,
      // 4) 镜像
      GITHUB_MANIFEST.replace('raw.githubusercontent.com', 'raw.gitmirror.com'),
    ];
    let lastErr;
    for (const u of urls) {
      try {
        const resp = await fetch(u, { cache: 'no-store' });
        if (resp.ok) return await resp.json();
        lastErr = new Error('HTTP ' + resp.status);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('网络失败');
  }

  // 检查更新：返回 {hasUpdate, remote, local}
  async function checkUpdate() {
    const remote = await fetchManifest();
    const local = curVersion || (await idbGet(KEY_VER));
    const hasUpdate = String(remote.version) !== String(local);
    return { hasUpdate, remote, local };
  }

  // 下载并应用新题库
  async function downloadUpdate(remote, onProgress) {
    const base = remote && remote.db_url ? remote.db_url : LOCAL_DB;
    const urls = [
      // 同源优先
      base,
      (new URL(base, location.href)).href,
      // 回退到 GitHub raw
      GITHUB_DB,
      GITHUB_DB.replace('raw.githubusercontent.com', 'raw.gitmirror.com'),
    ];
    let buf, lastErr;
    for (const u of urls) {
      try {
        const resp = await fetch(u, { cache: 'no-store' });
        if (!resp.ok) { lastErr = new Error('HTTP ' + resp.status); continue; }
        const reader = resp.body && resp.body.getReader();
        if (reader && onProgress) {
          const total = +(resp.headers.get('content-length') || 0);
          let got = 0, chunks = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); got += value.length;
            onProgress(total ? Math.round(got / total * 100) : 0);
          }
          buf = new Blob(chunks).arrayBuffer ? await new Blob(chunks).arrayBuffer() : await new Response(new Blob(chunks)).arrayBuffer();
        } else {
          buf = await resp.arrayBuffer();
        }
        break;
      } catch (e) { lastErr = e; }
    }
    if (!buf) throw lastErr || new Error('下载失败');
    loadIntoSql(new Uint8Array(buf));
    curMeta = readMeta();
    curVersion = curMeta.version;
    await idbSet(KEY_DB, buf);
    await idbSet(KEY_VER, curVersion);
    return curVersion;
  }

  // ---- 查询接口 ----
  function exec(sql, params = []) {
    if (!ready) throw new Error('DB not ready');
    let stmt;
    try {
      stmt = sqlite.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { if (stmt) try { stmt.free(); } catch (e) {} }
  }

  function total() { return exec("SELECT COUNT(*) c FROM questions")[0].c; }

  function banks() {
    return exec("SELECT bank, bank_title, type, COUNT(*) c, SUM(CASE WHEN source_type='short' THEN 1 ELSE 0 END) sc FROM questions GROUP BY bank, bank_title, type");
  }

  function listBanks() {
    const r = exec("SELECT DISTINCT bank, bank_title FROM questions ORDER BY bank");
    return r.map(x => ({ bank: x.bank, title: x.bank_title }));
  }

  function pickQuestions({ bank = null, types = null, order = 'seq', limit = 20, ids = null }) {
    let sql = "SELECT * FROM questions WHERE 1=1";
    const p = [];
    if (ids && ids.length) {
      sql += " AND id IN (" + ids.join(',') + ")";
    } else {
      if (bank) { sql += " AND bank=?"; p.push(bank); }
      if (types && types.length) {
        sql += " AND source_type IN (" + types.map(() => '?').join(',') + ")";
        p.push(...types);
      }
    }
    sql += " ORDER BY " + (order === 'rand' ? 'RANDOM()' : 'id');
    if (!ids) sql += " LIMIT ?";
    const rows = exec(sql, p.concat(ids ? [] : [limit]));
    return rows.map(normalizeRow);
  }

  function byIds(ids) {
    if (!ids.length) return [];
    return exec("SELECT * FROM questions WHERE id IN (" + ids.join(',') + ") ORDER BY id").map(normalizeRow);
  }

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

  return { init, checkUpdate, downloadUpdate, total, banks, listBanks,
    pickQuestions, byIds, meta, version, exec };
})();
