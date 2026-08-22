# -*- coding: utf-8 -*-
"""
将三份题库 txt 解析为统一结构，并生成 SQLite 题库数据库 + JSON 预览。
处理格式：
  ZS1: 内联答案（？（A）），判断题（√/×），多选内联（？（ABD））
  ZS2: 编号+空白答案（N. 题（ ））+ 末尾答案区；简答题+参考答案
  ZS3: 编号+内联答案（N. 题（D））
简答题 -> 多选题（参考答案拆成正确项，从其它题选项中抽取干扰项）
"""
import os, re, json, sqlite3, random, datetime

random.seed(42)
BASE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(BASE, "extracted")

FILES = {
    "ZS1": ("ZS1工地试验室日常工作标准化运行管理题库.txt", "工地试验室日常工作标准化运行管理"),
    "ZS2": ("ZS2交竣工验收及专项检测质量控制题库.txt", "交竣工验收及专项检测质量控制"),
    "ZS3": ("ZS3路床及路面基层、底基层施工技术和质量管理题库.txt", "路床及路面基层、底基层施工技术和质量管理"),
}

LET = "ABCDEFGHIJ"
OPT_RE = re.compile(r'^([A-E])[\.、\．]?\s*(.*)$')
NUM_RE = re.compile(r'^(\d{1,3})[\.、]\s*(.*)$')
PAREN_RE = re.compile(r'[（(]\s*([^)）]*?)\s*[)）]')   # any (...) group


def read_lines(name):
    p = os.path.join(EXT, name)
    with open(p, encoding="utf-8") as f:
        return [l.rstrip("\n") for l in f]


def clean(s):
    return re.sub(r'\s+', '', s)


def extract_inline_ans(qtext):
    """在题干中找最后一个'像答案'的括号组（A-E字母/√×/空白）。
    返回 (answer_str, span)。answer_str 为空表示空白答案（需答案区）。"""
    for m in reversed(list(PAREN_RE.finditer(qtext))):
        c = clean(m.group(1))
        if not c:
            return '', m.span()
        if all(ch in 'ABCDE' for ch in c):
            return c, m.span()
        if c in ('√', '×', 'X'):
            return '√' if c == '√' else '×', m.span()
    return None, None


def strip_ans_marker(q):
    """去掉题干中的答案括号标记及尾部标点"""
    ans, span = extract_inline_ans(q)
    if span:
        q = q[:span[0]] + q[span[1]:]
    return q.rstrip('。.，,；;:：*＊ ').strip()


def parse_options(lines, i, n):
    """从第 i 行开始收集选项，返回 (options_list, next_i)。
    options_list: [(letter, text), ...] 若行无字母前缀则按顺序补字母。"""
    opts = []
    while i < n:
        line = lines[i].strip()
        if not line:
            i += 1
            # 允许选项间空一行后继续，但若下一段是题号则停
            # 向前看：若后面还有选项行则继续，否则停
            j = i
            while j < n and not lines[j].strip():
                j += 1
            if j < n:
                nxt = lines[j].strip()
                if OPT_RE.match(nxt) and len(opts) > 0 and not NUM_RE.match(nxt):
                    i = j
                    continue
                else:
                    break
            else:
                break
        m = OPT_RE.match(line)
        if m:
            opts.append((m.group(1), m.group(2).strip()))
            i += 1
        else:
            # 无字母前缀的续行：可能是缺前缀的选项（如 ZS3 Q129）或题干续行
            # 遇到章节标题/题号/部分则停止
            is_header = (line.startswith(('第', '一、', '二、', '三、', '四、'))
                         or '题' in line[:8] or '部分' in line)
            if opts and len(opts) < 6 and not NUM_RE.match(line) and not is_header:
                opts.append((LET[len(opts)], line))
                i += 1
            else:
                break
    return opts, i


def parse_inline_question(lines, i, n):
    """解析一道内联答案题：题行(含（A）/（ABD）) + 选项。返回 dict or None, next_i"""
    line = lines[i].strip()
    m = NUM_RE.match(line) if not line.startswith(('A', 'B', 'C', 'D', 'E')) else None
    if m:
        qtext = m.group(2)
        num = int(m.group(1))
    else:
        qtext = line
        num = None
    ans_clean, _ = extract_inline_ans(qtext)
    if ans_clean is None:
        ans_clean = ''
    opts, ni = parse_options(lines, i + 1, n)
    return qtext, ans_clean, opts, ni, num


# ---------------- ZS1 ----------------
def parse_zs1(lines):
    n = len(lines)
    out = []
    i = 0
    section = None
    while i < n:
        raw = lines[i].strip()
        if not raw:
            i += 1; continue
        if '单项选择题' in raw and raw.startswith('一'):
            section = 'single'; i += 1; continue
        if '判断题' in raw:
            section = 'judge'; i += 1; continue
        if '多项选择题' in raw:
            section = 'multiple'; i += 1; continue
        if raw.startswith('第') and '部分' in raw:
            i += 1; continue
        if section == 'judge':
            ans, _ = extract_inline_ans(raw)
            if ans in ('√', '×'):
                stmt = strip_ans_marker(raw)
                out.append(dict(bank='ZS1', type='judge', question=stmt,
                                options=[], answer=['T' if ans == '√' else 'F'],
                                source_type='judge', analysis=''))
            i += 1
            continue
        if section in ('single', 'multiple'):
            qtext, ans, opts, ni, num = parse_inline_question(lines, i, n)
            if not opts:
                i += 1; continue
            opts2 = [(k, v) for k, v in opts if v]
            if not opts2:
                i = ni; continue
            qclean = strip_ans_marker(qtext)
            letters = ''.join(sorted(set(c for c in ans if c in LET)))
            if not letters:
                i = ni; continue
            out.append(dict(bank='ZS1', type=section, question=qclean,
                            options=opts2, answer=list(letters),
                            source_type=section, analysis=''))
            i = ni
            continue
        i += 1
    return out


# ---------------- ZS3 ----------------
def parse_zs3(lines):
    n = len(lines)
    out = []
    i = 0
    section = None
    while i < n:
        raw = lines[i].strip()
        if not raw:
            i += 1; continue
        if raw.startswith('一') and '单选' in raw:
            section = 'single'; i += 1; continue
        if raw.startswith('二') and '多选' in raw:
            section = 'multiple'; i += 1; continue
        if section in ('single', 'multiple'):
            qtext, ans, opts, ni, num = parse_inline_question(lines, i, n)
            if not opts:
                i += 1; continue
            opts2 = [(k, v) for k, v in opts if v]
            if not opts2:
                i = ni; continue
            qclean = strip_ans_marker(qtext)
            letters = ''.join(sorted(set(c for c in ans if c in LET)))
            if not letters:
                i = ni; continue
            out.append(dict(bank='ZS3', type=section, question=qclean,
                            options=opts2, answer=list(letters),
                            source_type=section, analysis=''))
            i = ni
            continue
        i += 1
    return out


# ---------------- ZS2 ----------------
def parse_zs2(lines):
    n = len(lines)
    questions = []  # (section, num, qtext, opts)
    short_qs = []   # (num, qtext)
    section = None
    answer_zone = False
    single_ans = {}
    multi_ans = {}
    short_ans = {}
    i = 0
    while i < n:
        raw = lines[i].strip()
        if not raw:
            i += 1; continue
        if raw.startswith('参考答案'):
            answer_zone = True; i += 1; continue
        if not answer_zone:
            if raw.startswith('一') and '单项选择题' in raw:
                section = 'single'; i += 1; continue
            elif raw.startswith('二') and '多项选择题' in raw:
                section = 'multiple'; i += 1; continue
            elif raw.startswith('三') and '简答题' in raw:
                section = 'short'; i += 1; continue
            if section in ('single', 'multiple'):
                m = NUM_RE.match(raw)
                if m:
                    num = int(m.group(1))
                    qtext = m.group(2)
                    opts, ni = parse_options(lines, i + 1, n)
                    opts2 = [(k, v) for k, v in opts if v]
                    if opts2:
                        questions.append((section, num, strip_ans_marker(qtext), opts2))
                    i = ni; continue
            if section == 'short':
                m = NUM_RE.match(raw)
                if m:
                    num = int(m.group(1))
                    qtext = m.group(2)
                    short_qs.append((num, qtext))
                    i += 1; continue
            i += 1; continue
        # answer zone
        if raw.startswith('一') and '单项选择题答案' in raw:
            section = 'single_ans'; i += 1; continue
        if raw.startswith('二') and '多项选择题答案' in raw:
            section = 'multi_ans'; i += 1; continue
        if raw.startswith('三') and '简答题答案' in raw:
            section = 'short_ans'; i += 1; continue
        if section == 'single_ans':
            for tok in re.split(r'\s+', raw):
                tm = re.match(r'(\d{1,3})[\.、]([A-E])$', tok)
                if tm:
                    single_ans[int(tm.group(1))] = tm.group(2)
        elif section == 'multi_ans':
            for tok in re.split(r'\s+', raw):
                tm = re.match(r'(\d{1,3})[\.、]([A-E]+)$', tok)
                if tm:
                    multi_ans[int(tm.group(1))] = tm.group(2)
        elif section == 'short_ans':
            # 简答题答案：多行文本，按 "N. xxx" 分题
            m = NUM_RE.match(raw)
            if m:
                cur_num = int(m.group(1))
                short_ans[cur_num] = m.group(2)
            else:
                if 'cur_num' in dir() and short_ans:
                    last = max(short_ans.keys())
                    short_ans[last] = short_ans[last] + '\n' + raw
        i += 1

    out = []
    for sec, num, qtext, opts in questions:
        if sec == 'single':
            a = single_ans.get(num)
            if not a:
                continue
            out.append(dict(bank='ZS2', type='single', question=qtext, options=opts,
                            answer=[a], source_type='single', analysis=''))
        else:
            a = multi_ans.get(num)
            if not a:
                continue
            letters = list(a)
            out.append(dict(bank='ZS2', type='multiple', question=qtext, options=opts,
                            answer=letters, source_type='multiple', analysis=''))
    # 简答题答案收集
    short_answers_text = {n: short_ans.get(n, '') for n, _ in short_qs}
    return out, short_qs, short_answers_text


# ---------------- 简答题 -> 多选题 ----------------
DISTRACTOR_POOL = [
    "混凝土抗压强度试件", "沥青针入度", "弯沉值", "压实度", "平整度",
    "构造深度", "摩擦系数", "渗透系数", "筛分级配", "含水率",
    "水泥终凝时间", "集料压碎值", "钢筋保护层厚度", "锚杆抗拔力",
    "注浆饱满度", "衬砌厚度", "净空宽度", "标线厚度", "反光膜逆反射系数",
    "苗木存活率", "边坡坡度", "路面横向力系数", "车辙深度", "相邻板高差",
    "外观检查", "荷载试验", "成桥状态测量", "回弹强度", "结构尺寸",
    "仰拱填充厚度", "衬砌强度", "立柱竖直度", "波形梁板厚度", "混凝土护栏断面尺寸",
    "高程", "横坡", "宽度", "路床破检", "骨料级配",
]


def split_points(text):
    """把参考答案文本拆成知识点"""
    text = text.replace('。', '、').replace('；', '、').replace('\n', '、')
    # 去掉 "答：xxx如下：" 之类前缀
    text = re.sub(r'^答[:：]', '', text)
    parts = re.split(r'[①②③④⑤⑥⑦⑧⑨⑩、,，]+', text)
    pts = []
    for p in parts:
        p = p.strip()
        p = re.sub(r'^[（(]?[0-9一二三四五六七八九十]+[)）、\.]?', '', p)
        p = p.strip()
        if 3 <= len(p) <= 60:
            pts.append(p)
    # 去重保序
    seen = set(); out = []
    for p in pts:
        if p not in seen:
            seen.add(p); out.append(p)
    return out


def convert_short_to_multi(short_qs, short_ans_text, all_multi_opts):
    """简答题保留为简答题（short_multi），不转多选题。
    选项为空，answer 字段存参考答案全文，供背题模式直接展示。"""
    out = []
    for num, qtext in short_qs:
        ref = short_ans_text.get(num, '')
        if not ref:
            continue
        out.append(dict(bank='ZS2', type='short_multi', question=qtext,
                        options=[], answer=ref, source_type='short',
                        analysis=''))
    return out


def main():
    all_qs = []
    zs1 = parse_zs1(read_lines(FILES['ZS1'][0]))
    zs3 = parse_zs3(read_lines(FILES['ZS3'][0]))
    zs2, short_qs, short_ans_text = parse_zs2(read_lines(FILES['ZS2'][0]))

    all_multi_opts = [q['options'] for q in (zs1 + zs2 + zs3) if q['type'] == 'multiple']
    short_multi = convert_short_to_multi(short_qs, short_ans_text, all_multi_opts)

    all_qs = zs1 + zs2 + short_multi + zs3

    # 按题干去重（跨题库重复），保留首次出现
    seen = set()
    deduped = []
    for q in all_qs:
        key = q['question']
        if key in seen:
            continue
        seen.add(key)
        deduped.append(q)
    if len(deduped) < len(all_qs):
        print(f"去重: {len(all_qs)} -> {len(deduped)}")
    all_qs = deduped

    # 编号 + bank_title
    for idx, q in enumerate(all_qs, 1):
        q['id'] = idx
        q['bank_title'] = FILES[q['bank']][1]

    # 统计
    stat = {}
    for q in all_qs:
        stat[q['source_type']] = stat.get(q['source_type'], 0) + 1
    print("题目统计:", stat, "总数:", len(all_qs))

    # 写 JSON 预览
    jp = os.path.join(BASE, "questions.json")
    with open(jp, 'w', encoding='utf-8') as f:
        json.dump(all_qs, f, ensure_ascii=False, indent=2)
    print("JSON:", jp)

    # 写 SQLite
    dbp = os.path.join(BASE, "shuatibaobei.db")
    if os.path.exists(dbp):
        os.remove(dbp)
    con = sqlite3.connect(dbp)
    cur = con.cursor()
    cur.execute("""CREATE TABLE questions(
        id INTEGER PRIMARY KEY, bank TEXT, bank_title TEXT, type TEXT,
        source_type TEXT, chapter TEXT, question TEXT, options TEXT,
        answer TEXT, analysis TEXT)""")
    cur.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
    for q in all_qs:
        cur.execute(
            "INSERT INTO questions(id,bank,bank_title,type,source_type,chapter,question,options,answer,analysis) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (q['id'], q['bank'], q['bank_title'], q['type'], q['source_type'], '',
             q['question'],
             json.dumps(q['options'], ensure_ascii=False),
             json.dumps(q['answer'], ensure_ascii=False),
             q.get('analysis', '')))
    version = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    meta = {
        "version": version,
        "question_count": str(len(all_qs)),
        "banks": "|".join(FILES[k][1] for k in FILES),
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    for k, v in meta.items():
        cur.execute("INSERT INTO meta(key,value) VALUES(?,?)", (k, v))
    con.commit()
    con.close()
    print("DB:", dbp)

    # 自动生成 manifest.json（version 与数据库 meta 表保持一致，避免每次打开都提示更新）
    manifest_path = os.path.join(BASE, "manifest.json")
    stats = {}
    for q in all_qs:
        t = q['type']
        stats[t] = stats.get(t, 0) + 1
    manifest = {
        "version": version,
        "question_count": len(all_qs),
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "db_file": "shuatibaobei.db",
        "db_url": "https://raw.githubusercontent.com/helloword4381/shuatibaobei/main/shuatibaobei.db",
        "manifest_url": "https://raw.githubusercontent.com/helloword4381/shuatibaobei/main/manifest.json",
        "banks": [FILES[k][1] for k in FILES],
        "stats": stats,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"Manifest: {manifest_path} (version={version})")

    # 抽样打印
    for q in all_qs[:2] + all_qs[-2:]:
        print(q['id'], q['bank'], q['type'], q['question'][:30], '=>', q['answer'])


if __name__ == '__main__':
    main()
