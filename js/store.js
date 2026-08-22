/* store.js — localStorage 状态：错题/统计/设置 */
const Store = (() => {
  const K = { wrong: 'stb_wrong', hist: 'stb_hist', set: 'stb_set', smart: 'stb_smart' };

  function load(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  // 错题: { id: {count, ts, bank} }
  const wrong = () => load(K.wrong, {});
  const setWrong = o => save(K.wrong, o);

  // 历史: { id: {seen, correct, wrong, ts} }
  const hist = () => load(K.hist, {});
  const setHist = o => save(K.hist, o);

  // 设置
  const settings = () => load(K.set, {});
  const setSettings = o => save(K.set, Object.assign(settings(), o));

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
  // 错题权重最高，其次看过但错的，未做的次之，已掌握最低
  function smartWeights(allIds) {
    const h = hist(); const w = wrong();
    const weights = allIds.map(id => {
      if (w[id]) return 10;                 // 当前错题：最高
      const s = h[id];
      if (!s) return 5;                     // 未做过
      const r = s.correct / s.seen;
      if (r < 0.6) return 8;                // 错得多
      if (r < 0.85) return 4;
      return 1;                             // 已掌握
    });
    return weights;
  }

  function pickWeighted(allIds, n) {
    const w = smartWeights(allIds);
    const pool = allIds.map((id, i) => ({ id, w: w[i] }));
    const picked = [];
    const total = w.reduce((a, b) => a + b, 0);
    while (picked.length < n && pool.length) {
      let r = Math.random() * (pool.reduce((a, p) => a + p.w, 0));
      let idx = 0;
      for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
      picked.push(pool[idx].id); pool.splice(idx, 1);
    }
    return picked;
  }

  return {
    getWrongIds, isWrong, addWrong, removeWrong, clearWrong, wrongCount,
    recordAnswer, qStat, doneIds, isDone, globalStats, bankStats,
    smartWeights, pickWeighted,
    settings: () => settings(), setSettings
  };
})();
