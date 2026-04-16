const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DB setup：有 DATABASE_URL 用 pg，没有用内存降级 ──────────
let pool = null;
const memStore = []; // 内存降级存储

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function dbQuery(sql, params = []) {
  if (!pool) throw new Error('no-db');
  return pool.query(sql, params);
}

async function initDB() {
  if (!pool) {
    console.log('No DATABASE_URL — running in memory mode');
    return;
  }
  // 重试最多 5 次，每次等 3s
  for (let i = 0; i < 5; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS results (
          id SERIAL PRIMARY KEY,
          suite TEXT NOT NULL,
          type_code TEXT NOT NULL,
          type_cn TEXT NOT NULL,
          dim_scores JSONB,
          answers JSONB,
          ip TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('DB ready');
      return;
    } catch (err) {
      console.warn(`DB init attempt ${i + 1} failed:`, err.message);
      if (i < 4) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('DB init failed after retries — running in memory mode');
  pool = null; // 降级
}

app.use(express.json());

// ── 静态文件：每套子路径 ──────────────────────────────────
app.use('/ppti', express.static(path.join(__dirname, 'ppti')));
app.use('/lpti', express.static(path.join(__dirname, 'lpti')));
app.use('/fbti', express.static(path.join(__dirname, 'fbti')));

// ── 首页：导航页 ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── API：通用 submit/stats，suite 参数区分 ─────────────────
function makeSubmit(suite) {
  return async (req, res) => {
    try {
      const { type_code, type_cn, dim_scores, answers } = req.body;
      if (!type_code || !type_cn) return res.status(400).json({ error: 'Missing fields' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
      if (pool) {
        const result = await pool.query(
          'INSERT INTO results (suite, type_code, type_cn, dim_scores, answers, ip) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [suite, type_code, type_cn, dim_scores || {}, answers || {}, ip]
        );
        res.json({ ok: true, id: result.rows[0].id });
      } else {
        // 内存降级
        const id = memStore.length + 1;
        memStore.push({ suite, type_code, type_cn, ip, created_at: new Date() });
        res.json({ ok: true, id });
      }
    } catch (err) {
      console.error('submit error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

function makeStats(suite) {
  return async (req, res) => {
    try {
      if (pool) {
        const totalResult = await pool.query('SELECT COUNT(*) as count FROM results WHERE suite=$1', [suite]);
        const total = parseInt(totalResult.rows[0].count, 10);
        const distResult = await pool.query(
          'SELECT type_code, type_cn, COUNT(*) as count FROM results WHERE suite=$1 GROUP BY type_code, type_cn ORDER BY count DESC',
          [suite]
        );
        const distribution = {};
        distResult.rows.forEach(r => { distribution[r.type_code] = { count: parseInt(r.count), cn: r.type_cn }; });
        res.json({ total, distribution });
      } else {
        // 内存降级
        const rows = memStore.filter(r => r.suite === suite);
        const distribution = {};
        rows.forEach(r => {
          if (!distribution[r.type_code]) distribution[r.type_code] = { count: 0, cn: r.type_cn };
          distribution[r.type_code].count++;
        });
        res.json({ total: rows.length, distribution });
      }
    } catch (err) {
      console.error('stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

app.post('/api/ppti/submit', makeSubmit('ppti'));
app.post('/api/lpti/submit', makeSubmit('lpti'));
app.post('/api/fbti/submit', makeSubmit('fbti'));
app.get('/api/ppti/stats', makeStats('ppti'));
app.get('/api/lpti/stats', makeStats('lpti'));
app.get('/api/fbti/stats', makeStats('fbti'));

// ── Admin 面板 ─────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  try {
    const suites = ['ppti','lpti','fbti'];
    const suiteNames = { ppti:'👨‍👩‍👧 PPTI 父母版', lpti:'💘 LPTI 恋爱版', fbti:'🤝 FBTI 朋友版' };
    const suiteColors = { ppti:'#c2410c', lpti:'#be185d', fbti:'#065f46' };

    let html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>人格鉴定系列 · 后台</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#f5f5f5;margin:0;padding:24px;color:#1a1a1a}
.shell{max-width:1000px;margin:0 auto}
h1{font-size:26px;margin:0 0 8px;letter-spacing:-.02em}
.sub{color:#666;font-size:14px;margin:0 0 28px}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:18px;padding:24px;margin-bottom:20px}
.suite-title{font-size:18px;font-weight:800;margin:0 0 12px}
.stat{font-size:40px;font-weight:900;margin:0 0 16px}
table{width:100%;border-collapse:collapse}
th{padding:8px 12px;text-align:left;font-size:12px;color:#888;border-bottom:2px solid #f0f0f0}
td{padding:8px 12px}tr:hover td{background:#fafafa}
.bar-bg{background:#f0f0f0;border-radius:999px;height:8px;overflow:hidden;flex:1}
.bar-fill{height:100%;border-radius:999px}
a{color:#555;font-size:13px;text-decoration:none;padding:6px 14px;border:1px solid #ddd;border-radius:999px;float:right}
a:hover{background:#f5f5f5}
</style></head><body><div class="shell">
<a href="/admin">↻ 刷新</a>
<h1>🔬 人格鉴定系列 · 后台</h1>
<p class="sub">PPTI 父母版 · LPTI 恋爱版 · FBTI 朋友版</p>`;

    for (const suite of suites) {
      const tr = await pool.query('SELECT COUNT(*) as count FROM results WHERE suite=$1', [suite]);
      const total = parseInt(tr.rows[0].count);
      const dr = await pool.query(
        'SELECT type_code, type_cn, COUNT(*) as count FROM results WHERE suite=$1 GROUP BY type_code,type_cn ORDER BY count DESC LIMIT 10',
        [suite]
      );
      const color = suiteColors[suite];
      const maxC = dr.rows.length ? Math.max(...dr.rows.map(r=>parseInt(r.count))) : 1;
      const rows = dr.rows.map(r => {
        const pct = Math.round(parseInt(r.count)/maxC*100);
        return `<tr><td style="font-weight:600;white-space:nowrap">${r.type_code}</td>
<td style="color:#666">${r.type_cn}</td>
<td style="width:100%"><div style="display:flex;align-items:center;gap:10px">
<div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
<span style="font-weight:700;color:${color};min-width:20px">${r.count}</span>
</div></td></tr>`;
      }).join('');
      html += `<div class="card">
<div class="suite-title" style="color:${color}">${suiteNames[suite]}</div>
<div class="stat" style="color:${color}">${total}</div>
<div style="color:#888;font-size:13px;margin-bottom:16px">总测评人数</div>
${dr.rows.length ? `<table><thead><tr><th>代码</th><th>人格</th><th>分布</th></tr></thead><tbody>${rows}</tbody></table>` : '<p style="color:#aaa;text-align:center;padding:16px">暂无数据</p>'}
</div>`;
    }

    html += `</div></body></html>`;
    res.send(html);
  } catch (err) {
    console.error('admin error:', err);
    res.status(500).send('error');
  }
});

// 先启动服务，再初始化 DB（healthcheck 不会因 DB 慢而失败）
app.listen(PORT, () => {
  console.log(`personality-tests running on port ${PORT}`);
  initDB().catch(err => console.error('initDB error:', err));
});
