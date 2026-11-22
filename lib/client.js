window.__ModuleLoader__.load({
  id: 'dsh-ai-team-console',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useCallback = react.useCallback
    var useMemo = react.useMemo

    var name = 'dsh-ai-team-console'
    /* 两个入口：
     * - sidebar.panellist（左侧栏「全局面板」入口，官方机制）
     * - main（该面板的正文，key 与 PANEL_ID 相同）
     * 二者都以 PANEL_ID = 'ai-team' 串起来。
     */
    var inject = ['slots']

    var PANEL_ID = 'ai-team'
    var NS = 'dsh-ai-team-console'

    /* ── 数据获取 ──────────────────────────────────────────────── */
    function useSnapshot(pollMs, teamId) {
      var s = useState(null); var snap = s[0], setSnap = s[1]
      var e = useState(null); var err = e[0], setErr = e[1]
      var l = useState(true); var loading = l[0], setLoading = l[1]

      // teamId 非空时按该团队取快照（「切到此团队」用）。
      // 为空时走默认：当前场景绑的那个团队。
      var load = useCallback(function () {
        var url = '/ai-team/api?op=snapshot'
        if (teamId) url += '&team=' + encodeURIComponent(teamId)
        fetch(url, { headers: { accept: 'application/json' } })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          })
          .then(function (d) { setSnap(d); setErr(null); setLoading(false) })
          .catch(function (x) { setErr(String(x && x.message ? x.message : x)); setLoading(false) })
      }, [teamId])

      useEffect(function () {
        load()
        if (!pollMs) return undefined
        var t = setInterval(load, pollMs)
        return function () { clearInterval(t) }
      }, [load, pollMs])

      return { snap: snap, err: err, loading: loading, reload: load }
    }

    /* ── 小工具 ────────────────────────────────────────────────── */
    function fmtBytes(n) {
      if (!n && n !== 0) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(2) + ' MB'
    }
    function fmtAgo(ms) {
      if (!ms) return '—'
      var d = Date.now() - ms
      if (d < 60000) return Math.max(1, Math.round(d / 1000)) + ' 秒前'
      if (d < 3600000) return Math.round(d / 60000) + ' 分钟前'
      if (d < 86400000) return Math.round(d / 3600000) + ' 小时前'
      return Math.round(d / 86400000) + ' 天前'
    }
    function statusTone(st) {
      var s = String(st || '').toLowerCase()
      if (s === 'running') return 'run'
      if (s === 'failed' || s === 'blocked') return 'bad'
      if (s === 'queued' || s === 'provisioning') return 'warn'
      return 'idle'
    }
    /** 风格B：inline SVG 图标（渲染环境无 emoji 字体，不用字符画勾叉）。
     * kind=ok 勾 / bad 叉；保留 atc- 前缀 class，不改任何文案与逻辑。 */
    function atcIcon(kind) {
      var bad = kind === 'bad'
      var d = bad ? 'M4 4l8 8M12 4l-8 8' : 'M3 8.5l3.2 3.2L13 5'
      return h('svg', {
        className: 'atc-icon ' + (bad ? 'atc-icon-bad' : 'atc-icon-ok'),
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true',
      }, h('path', { d: d, stroke: 'currentColor', strokeWidth: 2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /* ── 样式（顶层窗口面板，用 .atc- 前缀避免污染宿主） ─────────── */
    /* 风格 B「暖纸晨光」浅色主题：色板逐值照搬权威设计稿
        设计规格见项目文档，不自创色值。旧别名变量保留，
       JS 里既有 var(--accent/--ok/--danger/--warn/--border/--radius/...) 引用自动对齐。
       class 名一律 atc- 前缀不变；动效全部包在 prefers-reduced-motion 内。 */
    var CSS = [
      /* 权威色板 + 旧别名兼容 */
      '.atc-root{--bg:#eef0f3;--base:#f7f8fa;--raised:#ffffff;--sunken:#e4e7ec;--border:rgba(16,24,40,.10);--border-strong:rgba(16,24,40,.20);--text:#16181d;--dim:#5b6470;--accent:#2563eb;--accent-2:#1d4ed8;--warn:#b45309;--danger:#dc2626;--ok:#15803d;--focus:#2563eb;--inset-hi:rgba(255,255,255,.90);--head-grad:linear-gradient(180deg,rgba(16,24,40,.025),transparent);--hover-tint:rgba(16,24,40,.05);--shadow:0 1px 2px rgba(16,24,40,.06),0 10px 28px rgba(16,24,40,.10);--shadow-hover:0 2px 8px rgba(16,24,40,.10),0 16px 40px rgba(16,24,40,.15),0 0 0 1px rgba(37,99,235,.22);--r:12px;--r-sm:8px;--gap:20px;--gap-sm:10px;--ease-out:cubic-bezier(.22,1,.36,1);--ease-spring:cubic-bezier(.34,1.56,.64,1);--ease-in-out:cubic-bezier(.4,0,.2,1);--panel:var(--base);--radius:var(--r);--text-dim:.88;color-scheme:light dark;background:var(--bg);color:var(--text);display:flex;flex-direction:column;height:100%;min-height:0;font:13px/1.62 system-ui,"Microsoft YaHei","PingFang SC",sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}',
      /* 深色：三级表面递进的冷色板
         bg #0d0e11 → surface-1 #16181d → surface-2 #1e2127 三级表面递进，
         边框用半透明白（玻璃感），强调蓝 #3b82f6，焦点天蓝 #7dd3fc。 */
      'html[data-atc-theme="dark"] .atc-root{--bg:#0d0e11;--base:#16181d;--raised:#1e2127;--sunken:#0a0b0e;--border:rgba(255,255,255,.10);--border-strong:rgba(255,255,255,.22);--text:#f2f4f7;--dim:#a8b0bd;--accent:#3b82f6;--accent-2:#2563eb;--warn:#f59e0b;--danger:#ef4444;--ok:#22c55e;--focus:#7dd3fc;--inset-hi:rgba(255,255,255,.04);--head-grad:linear-gradient(180deg,rgba(255,255,255,.04),transparent);--hover-tint:rgba(255,255,255,.06);--shadow:0 1px 2px rgba(0,0,0,.40),0 8px 24px rgba(0,0,0,.50);--shadow-hover:0 2px 8px rgba(0,0,0,.50),0 16px 40px rgba(0,0,0,.60),0 0 0 1px rgba(125,211,252,.30)}',
      '@keyframes atc-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}',
      '@keyframes atc-shimmer{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}',
      '@keyframes atc-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
      /* 面板外壳与标题栏 */
      '.atc-head{flex:none;display:flex;align-items:center;gap:var(--gap-sm);padding:15px 20px;background:var(--head-grad);border-bottom:1px solid var(--border);animation:atc-rise .5s var(--ease-out) both}',
      '.atc-title{font-weight:700;font-size:15px;letter-spacing:.01em}',
      '.atc-sub{font-size:11px;color:var(--dim)}',
      '.atc-spacer{flex:1}',
      /* 按钮：回弹过渡 + :active 缩放 */
      '.atc-btn{appearance:none;border:1px solid var(--border-strong);border-radius:var(--r-sm);padding:8px 14px;font:600 12px/1.5 inherit;cursor:pointer;white-space:nowrap;background:var(--raised);color:var(--text);box-shadow:inset 0 1px 0 var(--inset-hi),0 2px 5px rgba(0,0,0,.12);transition:transform .18s var(--ease-spring),box-shadow .18s var(--ease-out),border-color .18s var(--ease-out),filter .18s var(--ease-out)}',
      '.atc-btn:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:inset 0 1px 0 var(--inset-hi),var(--shadow-hover)}',
      '.atc-btn:active{transform:scale(.97)}',
      '.atc-btn.on{background:color-mix(in srgb,var(--accent) 14%,transparent);border-color:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--accent)}',
      '.atc-btn.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 50%,transparent);background:color-mix(in srgb,var(--danger) 14%,transparent)}',
      '.atc-btn.danger:hover{filter:brightness(1.06)}',
      /* 页签 */
      '.atc-tabs{flex:none;display:flex;gap:var(--gap-sm);padding:0 20px;border-bottom:1px solid var(--border);flex-wrap:wrap;overflow-x:auto}',
      '.atc-tab{appearance:none;border:0;border-bottom:2.5px solid transparent;background:transparent;color:var(--dim);padding:11px 15px 12px;margin-bottom:-1px;cursor:pointer;font:600 12px/1.5 inherit;white-space:nowrap;transition:color .2s var(--ease-out),border-color .2s var(--ease-out),background .2s var(--ease-out)}',
      '.atc-tab:hover{color:var(--text);background:var(--hover-tint)}',
      '.atc-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      /* 主体：grid 双列，summary 跨列 */
      '.atc-body{flex:1;min-height:0;overflow:auto;padding:var(--gap);background:var(--base);border-top:1px solid var(--border)}',
      '.atc-sec{margin-bottom:var(--gap)}',
      '.atc-sec-h{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);font-weight:700;margin:0 0 12px;display:flex;align-items:center;gap:var(--gap-sm)}',
      /* 卡片浮起：raised 底 + shadow + inset 内高光，对比度 1.52:1 */
      '.atc-card{background:var(--raised);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--inset-hi);padding:15px 17px;margin-bottom:var(--gap-sm);transition:transform .2s var(--ease-out),box-shadow .2s var(--ease-out);animation:atc-rise .55s var(--ease-out) both}',
      '.atc-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover),inset 0 1px 0 var(--inset-hi)}',
      '.atc-card:nth-child(1){animation-delay:.06s}',
      /* 双列信息区（≥1200 双列 / <1200 单列堆叠） */
      '.atc-cols{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--gap);align-items:start}',
      /* 通道表 4 列 */
      '.atc-chan{display:grid;grid-template-columns:1.2fr 1.4fr .8fr 1.4fr;gap:8px 12px;align-items:center;padding:9px 4px;border-bottom:1px solid var(--border);font-size:12px}',
      '.atc-chan:last-child{border-bottom:0}',
      /* 行/名称/等宽/胶囊 */
      '.atc-row{display:flex;align-items:center;gap:var(--gap-sm);flex-wrap:wrap}',
      '.atc-row+.atc-row{margin-top:4px}',
      '.atc-name{font-weight:650;color:var(--text)}',
      '.atc-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dim);word-break:break-all}',
      '.atc-pill{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:600;padding:6px 11px;border-radius:999px;border:1px solid var(--border);box-shadow:inset 0 1px 0 var(--inset-hi);transition:transform .2s var(--ease-spring)}',
      '.atc-pill:hover{transform:translateY(-2px)}',
      '.atc-pill.run{background:color-mix(in srgb,var(--ok) 14%,transparent);border-color:color-mix(in srgb,var(--ok) 50%,transparent);color:var(--ok)}',
      '.atc-pill.bad{background:color-mix(in srgb,var(--danger) 14%,transparent);border-color:color-mix(in srgb,var(--danger) 50%,transparent);color:var(--danger)}',
      '.atc-pill.warn{background:color-mix(in srgb,var(--warn) 14%,transparent);border-color:color-mix(in srgb,var(--warn) 50%,transparent);color:var(--warn)}',
      '.atc-pill.idle{opacity:.6}',
      '.atc-ok{color:var(--ok)}',
      '.atc-no{color:var(--danger)}',
      '.atc-icon{display:inline-block;vertical-align:-2px;width:13px;height:13px;flex:none}',
      '.atc-icon-ok{color:var(--ok)}',
      '.atc-icon-bad{color:var(--danger)}',
      '.atc-dim{color:var(--dim);font-size:11px}',
      '.atc-list{margin:0;padding-left:20px}',
      '.atc-list li{margin:4px 0}',
      '.atc-empty{padding:20px 14px;text-align:center;color:var(--dim);font-size:11.5px}',
      '.atc-gap{border-left:4px solid var(--warn);padding-left:12px}',
      '.atc-gap.ok{border-left-color:var(--ok)}',
      '.atc-persona{white-space:pre-wrap;font-size:11px;line-height:1.55;color:var(--dim);max-height:260px;overflow:auto;border:1px dashed var(--border);border-radius:var(--r-sm);padding:8px 12px;margin-top:8px}',
      '.atc-hire{border:1px dashed var(--border-strong);border-radius:var(--r-sm);padding:12px;margin-top:8px;background:var(--sunken)}',
      '.atc-code{font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;background:var(--sunken);color:var(--text);border-radius:var(--r-sm);padding:8px 12px;margin-top:4px}',
      '.atc-mini{font-size:11px;color:var(--dim)}',
      '.atc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--gap)}',
      '.atc-input{flex:1;min-width:0;appearance:none;border:1px solid var(--border-strong);background:var(--sunken);color:var(--text);border-radius:var(--r-sm);padding:11px 14px;font:12px/1.5 inherit;outline:none;transition:border-color .2s var(--ease-out),box-shadow .2s var(--ease-out)}',
      '.atc-input:focus{border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 28%,transparent)}',
      '.atc-input::placeholder{color:var(--dim);opacity:.8}',
      /* 加载呼吸条（shimmer 扫光） */
      '.atc-loader{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--dim)}',
      '.atc-loader .bar{height:5px;width:150px;border-radius:99px;background:var(--sunken);overflow:hidden;position:relative}',
      '.atc-loader .bar::after{content:"";position:absolute;inset:0;width:45%;border-radius:99px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:atc-shimmer 1.8s var(--ease-in-out) infinite}',
      /* 折叠区浮起感 */
      '.atc-fold{border:1px dashed var(--border-strong);border-radius:var(--r-sm);background:var(--sunken);overflow:hidden}',
      '.atc-fold summary{cursor:pointer;list-style:none;padding:10px 13px;font-size:11.5px;color:var(--dim);animation:atc-breathe 2s var(--ease-in-out) infinite}',
      '.atc-fold summary::-webkit-details-marker{display:none}',
      /* focus 可见 */
      '.atc-root :focus-visible{outline:2px solid var(--focus);outline-offset:2px}',
      /* 会话预设描述：最多两行，超出省略 */
      '.atc-preset-desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px;color:var(--dim);line-height:1.5}',
      /* 目录浏览器（内置浮层，不用 window.prompt）：elevation + rise 进入动效 + 主题变量 */
      '.atc-dir-overlay{position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:rgba(16,24,40,.45)}',
      '.atc-dir-panel{width:min(560px,92vw);max-height:80vh;display:flex;flex-direction:column;background:var(--raised);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow-hover),inset 0 1px 0 var(--inset-hi);overflow:hidden;animation:atc-rise .3s var(--ease-out) both}',
      '.atc-dir-crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border);font-size:11.5px}',
      '.atc-dir-crumb{border:0;background:transparent;color:var(--accent);cursor:pointer;padding:2px 4px;font:inherit;border-radius:var(--r-sm)}',
      '.atc-dir-crumb:hover{background:var(--sunken)}',
      '.atc-dir-sep{color:var(--dim);opacity:.6}',
      '.atc-dir-list{flex:1;min-height:120px;overflow:auto;padding:8px}',
      '.atc-dir-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:var(--text);cursor:pointer;padding:8px 10px;border-radius:var(--r-sm);font:12px/1.5 inherit}',
      '.atc-dir-item:hover{background:var(--sunken)}',
      '.atc-dir-item.hl{background:color-mix(in srgb,var(--accent) 12%,transparent);border-color:var(--accent)}',
      '.atc-dir-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--border)}',
      /* 响应式：<1200 单列堆叠；更窄进一步收敛内边距 */
      '@media (max-width:1199px){.atc-cols{grid-template-columns:minmax(0,1fr)}}',
      '@media (max-width:640px){.atc-body{padding:var(--gap-sm)}.atc-head,.atc-tabs{padding-left:var(--gap-sm);padding-right:var(--gap-sm)}.atc-chan{grid-template-columns:1.2fr 1.4fr}.atc-btn{padding:8px 10px}}',
      /* 无障碍：所有动效统一关闭 */
      '@media (prefers-reduced-motion:reduce){.atc-root *,.atc-root *::before,.atc-root *::after{animation:none!important;transition:none!important;transform:none!important}}',
    ].join('\n')

    function useCss() {
      useEffect(function () {
        var id = 'atc-style-v1'
        if (!document.getElementById(id)) {
          var el = document.createElement('style')
          el.id = id
          el.textContent = CSS
          document.head.appendChild(el)
        }
        /* 跟随 DSH 的「外观」设置（浅色/深色/跟随系统），而不是只看操作系统。
           DSH 在 body 上 toggleAttribute('data-ds-dark-theme', dark) 表示实际生效的深色；
           html.dataset.dsThemeSource 保存用户的偏好值（light|dark|system）。
           本机 Windows 可能没设置明暗，此时 prefers-color-scheme 不可靠。 */
        function syncTheme() {
          var dark = false
          if (document.body && document.body.hasAttribute('data-ds-dark-theme')) {
            dark = true
          } else if (typeof matchMedia !== 'undefined' &&
                     matchMedia('(prefers-color-scheme: dark)').matches) {
            dark = true
          }
          document.documentElement.dataset.atcTheme = dark ? 'dark' : 'light'
        }
        syncTheme()
        var mo = typeof MutationObserver !== 'undefined'
          ? new MutationObserver(syncTheme)
          : null
        if (mo && document.body) {
          mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        }
        var mq = typeof matchMedia !== 'undefined'
          ? matchMedia('(prefers-color-scheme: dark)')
          : null
        if (mq && mq.addEventListener) mq.addEventListener('change', syncTheme)
        return function () {
          if (mo) mo.disconnect()
          if (mq && mq.removeEventListener) mq.removeEventListener('change', syncTheme)
        }
      }, [])
    }

    /* ── 各页签 ────────────────────────────────────────────────── */

    function TabOverview(p) {
      var mut = useMutate()
      var snap = p.snap
      var checks = snap.checks
      var team = snap.team
      var tone = checks.passed === checks.total ? 'run' : checks.passed >= checks.total - 2 ? 'warn' : 'bad'
      var reRes = mut.result && mut.result.op === 'refresh-snap' ? mut.result.data : null
      return h('div', null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, '工作项 ' + snap.scenario),
            h('span', { className: 'atc-pill ' + tone }, '验收自检 ' + checks.passed + '/' + checks.total),
            h('span', { className: 'atc-spacer' }),
            h('button', {
              className: 'atc-btn', disabled: !!mut.busy,
              onClick: function () {
                // P1a：重跑验收自检 —— 重取 snapshot 并由外层刷新（返回新时间戳）
                mut.send('refresh-snap', { scenario: snap.scenario, _: Date.now() }).then(function (d) {
                  if (d && d.ok && typeof p.onSnapshot === 'function') p.onSnapshot(d.snapshot)
                })
              },
            }, mut.busy === 'refresh-snap' ? '自检中…' : '重跑验收自检'),
          ),
          reRes ? h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            reRes.ok ? '✓ 已刷新 · ' + (reRes.generatedAt || '') : '✗ ' + (reRes.error || '刷新失败')) : null,
          h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            '后台服务（sidecar）' + (team.sidecar.reachable ? '可达' : '不可达') + ' · ' + team.sidecar.base +
            (team.teamId ? ' · 团队 ' + team.teamId : '')),
        ),
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '验收自检明细'),
          checks.items.map(function (it) {
            return h('div', { key: it.id, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: it.pass ? 'atc-ok' : 'atc-no' }, it.pass ? atcIcon('ok') : atcIcon('bad')),
                h('span', { className: 'atc-name', style: { fontSize: 13 } }, it.label),
              ),
              h('div', { className: 'atc-dim' }, it.detail),
            )
          }),
        ),
        (team.warnings && team.warnings.length) ? h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '通道告警'),
          h('ul', { className: 'atc-list' }, team.warnings.map(function (w, i) {
            return h('li', { key: i, className: 'atc-dim' }, w)
          })),
        ) : null,
      )
    }

    /* ── 写操作辅助 ────────────────────────────────────────────── */
    function useMutate() {
      var s = useState(null); var busy = s[0], setBusy = s[1]
      var e = useState(null); var result = e[0], setResult = e[1]

      var send = useCallback(function (op, body) {
        setBusy(op); setResult(null)
        return fetch('/ai-team/api?op=' + encodeURIComponent(op), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body || {}),
        })
          .then(function (r) { return r.json() })
          .then(function (d) { setResult({ op: op, data: d }); setBusy(null); return d })
          .catch(function (x) { setResult({ op: op, data: { ok: false, error: String(x) } }); setBusy(null); return null })
      }, [])

      return { send: send, busy: busy, result: result, clear: function () { setResult(null) } }
    }

    /**
     * 团队编制总览。
     *
     * 设计取舍（v2，按反馈重做）：
     *   - 岗位职责**默认展开**。折叠起来等于没写——用户要的是"这团队有谁、干什么"，
     *     不是再点一次才看到。6 个岗位全文展开也就 20 行，不折叠。
     *   - 三级视觉层次：团队名(16px粗) / 岗位名(13px粗带色) / 职责(12px灰)。
     *     原来全用 atc-mini，一片同色，看不出重点。
     *   - 状态用颜色编码：绿=有人且可接、黄=有人但无会话、灰=缺人。
     */
    function TeamOverview(p) {
      var os = useState(null); var data = os[0], setData = os[1]
      var es = useState(null); var err = es[0], setErr = es[1]
      var ls = useState(true); var loading = ls[0], setLoading = ls[1]

      function load() {
        setLoading(true)
        fetch('/ai-team/api?op=team-overview', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.error) { setErr(d.error); setLoading(false); return }
            setData(d); setErr(null); setLoading(false)
          })
          .catch(function (x) { setErr(String(x && x.message ? x.message : x)); setLoading(false) })
      }
      useEffect(function () { load() }, [])

      var KIND_STYLE = {
        software: { color: '#3b82f6', label: '软件开发', icon: '⌨' },
        docs: { color: '#8b5cf6', label: '文档撰写', icon: '📄' },
        research: { color: '#06b6d4', label: '研究分析', icon: '🔬' },
        ecom: { color: '#f59e0b', label: '电商运营', icon: '🛒' },
        general: { color: '#64748b', label: '通用', icon: '⚙' },
      }

      var teams = (data && data.teams) || []

      return h('div', { className: 'atc-sec' },
        // 区块头
        h('div', { className: 'atc-row', style: { marginBottom: 10 } },
          h('div', null,
            h('div', { style: { fontSize: 14, fontWeight: 700, marginBottom: 2 } }, '团队编制'),
            h('div', { style: { fontSize: 11, color: 'var(--dim)', lineHeight: 1.5 } },
              '每个场景类型一套编制。绿=可接任务，黄=有人没会话，灰=缺人')),
          h('span', { className: 'atc-spacer' }),
          h('button', {
            className: 'atc-btn', style: { fontSize: 11, padding: '3px 10px' },
            onClick: load,
          }, loading ? '读取中…' : '刷新'),
        ),
        err ? h('div', { style: { color: 'var(--danger)', fontSize: 12 } }, '读取失败：' + err) : null,
        teams.map(function (t) {
          var ro = t.roster || {}
          var complete = ro.complete
          var ks = KIND_STYLE[t.kind] || KIND_STYLE.general
          var cur = Number(t.maxConcurrency || 0)
          var suggest = Math.max(2, Math.min(ro.total || 3, 6))
          var concOk = cur >= suggest
          var roles = ro.roles || []

          return h('div', {
            key: t.teamId,
            style: {
              marginTop: 10, padding: '12px 14px', borderRadius: 10,
              background: 'var(--raised)',
              borderLeft: '3px solid ' + (complete ? 'var(--ok)' : 'var(--warn)'),
            },
          },
            // ── 第一层：团队名 + 类型 + 状态 ──
            h('div', { className: 'atc-row', style: { marginBottom: 6 } },
              h('span', { style: { fontSize: 16, fontWeight: 700, color: 'var(--text)' } }, t.name),
              h('span', {
                style: {
                  fontSize: 10, padding: '2px 7px', borderRadius: 4,
                  background: ks.color + '22', color: ks.color, fontWeight: 600,
                },
              }, ks.label),
              h('span', {
                style: {
                  fontSize: 10, padding: '2px 7px', borderRadius: 4,
                  background: complete ? '#22c55e22' : '#f59e0b22',
                  color: complete ? 'var(--ok)' : 'var(--warn)', fontWeight: 600,
                },
              }, complete ? '编制齐全' : ('缺 ' + (ro.total - ro.filled) + ' 个')),
              h('span', { className: 'atc-spacer' }),
              h('span', { style: { fontSize: 11, color: 'var(--dim)' } },
                t.memberCount + '/' + t.maxMembers + ' 人 · 可派 ' + t.boundCount),
              h('span', {
                style: {
                  fontSize: 11, color: concOk ? 'var(--dim)' : 'var(--warn)',
                  marginLeft: 8, marginRight: 8,
                },
                title: '并行上限 = 能同时跑几个任务',
              }, '并发 ' + cur + (concOk ? '' : '→' + suggest)),
              h('button', {
                className: 'atc-btn',
                style: { fontSize: 11, padding: '3px 10px', borderColor: ks.color, color: ks.color },
                onClick: function () {
                  if (typeof p.onPickTeam === 'function') p.onPickTeam(t)
                },
              }, '切到此团队'),
            ),

            // ── 这个团队干什么（一句话）──
            h('div', { style: { fontSize: 12, color: 'var(--dim)', marginBottom: 10 } },
              ks.icon + ' ' + (t.describe || '')),

            // ── 第二层：岗位明细（默认展开，不折叠）──
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
              roles.map(function (r) {
                var has = r.present
                var canWork = has && r.bound
                var dotColor = canWork ? 'var(--ok)' : (has ? 'var(--warn)' : 'var(--dim)')
                var stateText = canWork ? '可接任务' : (has ? '无会话·派不进' : '待补齐')
                return h('div', {
                  key: r.name,
                  style: {
                    paddingLeft: 10, borderLeft: '2px solid ' + dotColor,
                    opacity: has ? 1 : 0.55,
                  },
                },
                  // 岗位名一行
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 } },
                    h('span', { style: { fontSize: 13, fontWeight: 600, color: has ? 'var(--text)' : 'var(--dim)' } },
                      r.title),
                    h('span', {
                      style: {
                        fontSize: 9, padding: '1px 5px', borderRadius: 3,
                        background: dotColor + '22', color: dotColor,
                      },
                    }, stateText),
                    has ? h('span', { style: { fontSize: 10, color: 'var(--dim)' } },
                      '· ' + r.memberName) : null,
                  ),
                  // 职责一行（正文，不是小字）
                  h('div', { style: { fontSize: 12, color: 'var(--dim)', lineHeight: 1.5 } },
                    r.duty),
                )
              }),
            ),

            // ── 第三层：并行上限解释 ──
            h('div', {
              style: {
                marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)',
                fontSize: 11, color: concOk ? 'var(--dim)' : 'var(--warn)',
              },
            },
              '并行上限 ' + cur + ' 个任务同时跑'
              + (concOk
                ? '（够用；编制 ' + (ro.total || 0) + ' 人，建议上限 2~' + suggest + '）'
                : '，建议提到 ' + suggest + '（= 编制人数，上限 6）')),
          )
        }),
        !loading && !teams.length
          ? h('div', { className: 'atc-empty' }, '还没有任何团队 · 在任务页跑一次流水线会按场景类型自动建队')
          : null,
      )
    }


    /**
     * 成员页 —— 三段式重做。
     *
     * 原版的问题（用户反馈「没重点」）：
     *   · 「成员编制」和「能力域覆盖」是同一件事说两遍
     *   · 每个缺口都摊开 YAML 配置块，占地方且没人看
     *   · 四块卡片同样大小同样颜色，看不出该先看哪
     *
     * 现在：
     *   ① 顶部一行指标（在编/可用/缺口），扫一眼知道状态
     *   ② 团队卡（编制 + 成员合体，一个岗位一行）
     *   ③ 缺口只在真缺时出现，用警示色，一键招募
     */
    function TabMembers(p) {
      var snap = p.snap
      var members = snap.team.members || []
      var gaps = snap.gaps || { rows: [], coveredCount: 0, total: 0 }
      var teamId = snap.team.teamId
      var mut = useMutate()
      var th = snap.teamHealth
      var hp = useState(null); var probe = hp[0], setProbe = hp[1]
      var teams = snap.team.teams || []
      var curTeam = teams.filter(function (t) { return t.id === teamId })[0] || {}
      var capNum = Number(curTeam.maxMembers || 8)
      var capIn = useState(''); var capEdit = capIn[0], setCapEdit = capIn[1]
      var capVal = Number(capEdit)
      var capValid = /^\d+$/.test(String(capEdit).trim()) && capVal >= 1 && capVal <= 64
      var overCap = members.length > capNum

      // 当前团队的编制模板（从 overview 拿，拿不到就用通用）
      var ov = useState(null); var overview = ov[0], setOverview = ov[1]
      useEffect(function () {
        fetch('/ai-team/api?op=team-overview', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) { setOverview(d) })
          .catch(function () { /* 拿不到不阻塞 */ })
      }, [teamId])
      var curOv = null
      if (overview && overview.teams) {
        for (var oi = 0; oi < overview.teams.length; oi++) {
          if (overview.teams[oi].teamId === teamId) { curOv = overview.teams[oi]; break }
        }
      }

      function hire(name) {
        mut.send('hire', { teamId: teamId, member: { name: name } })
      }
      function changeCap() {
        if (!capValid) return
        mut.send('team-cap', { teamId: teamId, maxMembers: capVal }).then(function (d) {
          if (d && d.ok) { setCapEdit(''); if (typeof p.onSnapshot === 'function') p.onSnapshot(true) }
        })
      }
      function checkHealth() {
        fetch('/ai-team/api?op=team-health', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ teamId: teamId }),
        }).then(function (r) { return r.json() }).then(function (d) { setProbe(d) }).catch(function (x) {
          setProbe({ ok: false, error: String(x && x.message ? x.message : x) })
        })
      }

      var healthOf = {}
      if (th && th.rows) th.rows.forEach(function (r) { healthOf[r.name] = r })

      var hireResult = mut.result && mut.result.op === 'hire' ? mut.result.data : null
      var capResult = mut.result && mut.result.op === 'team-cap' ? mut.result.data : null

      var unboundCount = th ? (th.counts.unbound || 0) : 0
      var staleCount = th ? (th.counts.stale || 0) : 0
      var gapMissing = (gaps.rows || []).filter(function (g) { return g.status !== 'covered' })

      // ── 指标条 ──
      function metric(label, value, tone, hint) {
        return h('div', {
          style: {
            flex: '1 1 0', minWidth: 96, padding: '10px 12px', borderRadius: 8,
            background: 'var(--raised)', borderLeft: '3px solid ' + tone,
          },
          title: hint || '',
        },
          h('div', { style: { fontSize: 20, fontWeight: 700, color: tone, lineHeight: 1.2 } }, String(value)),
          h('div', { style: { fontSize: 11, color: 'var(--dim)', marginTop: 2 } }, label),
        )
      }

      return h('div', null,
        // ══ ① 指标条 ══
        h('div', { className: 'atc-sec' },
          h('div', { style: { fontSize: 14, fontWeight: 700, marginBottom: 8 } }, '成员概览'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            metric('在编成员', members.length + '/' + capNum, 'var(--accent)', '当前团队人数 / 上限'),
            metric('会话可用', th ? (th.counts.usable + '/' + th.counts.total) : '—',
              th && th.counts.usable === th.counts.total ? 'var(--ok)' : 'var(--warn)',
              '能真派活的人数'),
            metric('能力域覆盖', gaps.coveredCount + '/' + gaps.total,
              gaps.coveredCount === gaps.total ? 'var(--ok)' : 'var(--warn)',
              '六个核心岗位有没有人'),
            (unboundCount + staleCount) > 0
              ? metric('需处理', unboundCount + staleCount, 'var(--danger)', '无会话或会话失效的成员数')
              : null,
          ),
          // 上限调整（收进一行，不单独占卡片）
          h('div', { className: 'atc-row', style: { marginTop: 8, gap: 6 } },
            h('span', { style: { fontSize: 11, color: 'var(--dim)' } }, '人数上限'),
            h('input', {
              className: 'atc-input', type: 'number', min: 1, max: 64, placeholder: String(capNum),
              value: capEdit, style: { maxWidth: 72, padding: '3px 8px', fontSize: 12 },
              onChange: function (e) { setCapEdit(e.target.value) },
            }),
            h('button', {
              className: 'atc-btn', disabled: !!mut.busy || !capValid,
              style: { fontSize: 11, padding: '3px 10px' },
              onClick: changeCap,
            }, '改上限'),
            capEdit !== '' && !capValid
              ? h('span', { style: { fontSize: 11, color: 'var(--warn)' } }, '须 1-64 整数') : null,
            overCap ? h('span', { style: { fontSize: 11, color: 'var(--danger)' } }, '已超上限') : null,
            capResult && capResult.ok === false
              ? h('span', { style: { fontSize: 11, color: 'var(--danger)' } }, String(capResult.error || '改上限失败')) : null,
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', style: { fontSize: 11, padding: '3px 10px' }, onClick: checkHealth },
              '查会话可用性'),
          ),
          probe ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--raised)', fontSize: 11 } },
            h('div', { className: 'atc-row' },
              h('span', { style: { fontWeight: 600 } }, probe.ok ? '探测结果' : '探测失败'),
              h('span', { className: 'atc-spacer' }),
              h('button', { className: 'atc-btn', style: { fontSize: 10, padding: '2px 8px' }, onClick: function () { setProbe(null) } }, '收起'),
            ),
            probe.health ? h('div', { style: { color: 'var(--dim)', marginTop: 3 } }, probe.health.summary) : null,
            probe.error ? h('div', { style: { color: 'var(--danger)', marginTop: 3 } }, String(probe.error)) : null,
          ) : null,
        ),

        // ══ ② 团队卡：编制 + 成员合体 ══
        h('div', { className: 'atc-sec' },
          h('div', { style: { fontSize: 14, fontWeight: 700, marginBottom: 8 } },
            '当前团队' + (curOv ? ' · ' + (curOv.kindLabel || '') : '')),
          curOv && curOv.describe
            ? h('div', { style: { fontSize: 12, color: 'var(--dim)', marginBottom: 10 } }, curOv.describe) : null,

          members.length === 0
            ? h('div', { className: 'atc-empty' }, '还没有成员 · 跑一次流水线会按场景类型自动建队')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              members.map(function (m) {
                var hh = healthOf[m.name]
                var canWork = !hh || hh.sessionState === 'ok'
                var dot = canWork ? 'var(--ok)' : (hh && hh.sessionState === 'stale-lineage' ? 'var(--danger)' : 'var(--warn)')
                var stateText = canWork ? '可接任务'
                  : (hh && hh.sessionState === 'stale-lineage' ? '会话失效' : '无会话')
                return h('div', {
                  key: m.id,
                  style: {
                    padding: '10px 12px', borderRadius: 8, background: 'var(--raised)',
                    borderLeft: '3px solid ' + dot, opacity: canWork ? 1 : 0.85,
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 } },
                    h('span', { style: { fontSize: 14, fontWeight: 600 } }, m.name),
                    h('span', {
                      style: {
                        fontSize: 9, padding: '1px 6px', borderRadius: 3,
                        background: dot + '22', color: dot,
                      },
                    }, stateText),
                    h('span', { style: { fontSize: 10, color: 'var(--dim)' } }, m.status || '?'),
                    h('span', { className: 'atc-spacer' }),
                    h('span', { style: { fontSize: 10, color: 'var(--dim)', fontFamily: 'monospace' } },
                      (m.agentProvider || '?') + '/' + (m.model || '?')),
                  ),
                  m.role ? h('div', { style: { fontSize: 12, color: 'var(--dim)', lineHeight: 1.5 } }, m.role) : null,
                  hh && hh.sessionAdvice
                    ? h('div', { style: { fontSize: 11, color: 'var(--warn)', marginTop: 4 } }, hh.sessionAdvice) : null,
                )
              })),
          th && (th.counts.unbound > 0 || th.counts.stale > 0)
            ? h('div', {
              style: {
                marginTop: 10, padding: '8px 10px', borderRadius: 6,
                background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
                borderLeft: '3px solid var(--warn)', fontSize: 11, color: 'var(--warn)',
              },
            },
              (th.counts.stale ? th.counts.stale + ' 个会话失效（绑在旧父会话上）' : '')
              + (th.counts.stale && th.counts.unbound ? '；' : '')
              + (th.counts.unbound ? th.counts.unbound + ' 个无会话（只有记录，派不进任务）' : '')
              + '。修复：retire 旧成员后由 Lead 重新 dsh_team_spawn。')
            : null,
        ),

        // ══ ③ 缺口（只在真缺时出现）══
        gapMissing.length
          ? h('div', { className: 'atc-sec' },
            h('div', { style: { fontSize: 14, fontWeight: 700, marginBottom: 8, color: 'var(--warn)' } },
              '缺 ' + gapMissing.length + ' 个岗位'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              gapMissing.map(function (g) {
                return h('div', {
                  key: g.id,
                  style: {
                    padding: '10px 12px', borderRadius: 8,
                    background: 'color-mix(in srgb, var(--warn) 8%, transparent)',
                    borderLeft: '3px solid var(--warn)',
                  },
                },
                  h('div', { className: 'atc-row', style: { marginBottom: 4 } },
                    h('span', { style: { fontSize: 13, fontWeight: 600 } }, g.label),
                    h('span', {
                      style: { fontSize: 9, padding: '1px 6px', borderRadius: 3, background: '#f59e0b22', color: 'var(--warn)' },
                    }, '缺人'),
                    h('span', { className: 'atc-spacer' }),
                    h('button', {
                      className: 'atc-btn',
                      style: { fontSize: 11, padding: '3px 10px', borderColor: 'var(--warn)', color: 'var(--warn)' },
                      disabled: mut.busy === 'hire',
                      onClick: function () { hire(g.suggest.name) },
                    }, mut.busy === 'hire' ? '招募中…' : '招募 ' + g.suggest.name),
                  ),
                  h('div', { style: { fontSize: 12, color: 'var(--dim)', lineHeight: 1.5 } }, g.covers),
                  h('div', { style: { fontSize: 11, color: 'var(--dim)', marginTop: 3 } },
                    '为什么需要：' + g.hireWhen),
                )
              })),
          )
          : null,

        // 招募回执
        hireResult ? h('div', {
          style: {
            marginTop: 10, padding: '10px 12px', borderRadius: 8,
            background: hireResult.ok ? 'color-mix(in srgb,var(--ok) 10%,transparent)' : 'color-mix(in srgb,var(--danger) 10%,transparent)',
            borderLeft: '3px solid ' + (hireResult.ok ? 'var(--ok)' : 'var(--danger)'),
          },
        },
          h('div', { className: 'atc-row' },
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, hireResult.ok ? '招募已受理' : '暂时招不了'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', style: { fontSize: 10, padding: '2px 8px' }, onClick: mut.clear }, '知道了'),
          ),
          hireResult.detail ? h('div', { style: { fontSize: 12, color: 'var(--dim)', marginTop: 3 } }, hireResult.detail) : null,
          hireResult.note ? h('div', { style: { fontSize: 11, color: 'var(--dim)', marginTop: 3 } }, hireResult.note) : null,
          hireResult.options ? h('div', { style: { fontSize: 11, color: 'var(--dim)', marginTop: 3 } },
            hireResult.options.join(' · ')) : null,
        ) : null,
      )
    }



    function TabHandbook(p) {
      var mut = useMutate()
      var snap = p.snap
      var hb = snap.handbook
      var skelRes = mut.result && mut.result.op === 'handbook-skeleton' ? mut.result.data : null
      var hasMissing = !hb.exists || (hb.files || []).some(function (f) { return !f.exists || f.emptySkeleton })
      return h('div', null,
        skelRes ? h('div', { className: 'atc-card', style: {
          borderColor: skelRes.ok ? 'color-mix(in srgb,var(--ok) 60%,transparent)' : 'color-mix(in srgb,var(--danger) 60%,transparent)',
          background: skelRes.ok ? 'color-mix(in srgb,var(--ok) 8%,transparent)' : 'color-mix(in srgb,var(--danger) 8%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name', style: { fontSize: 13 } }, skelRes.ok ? '✓ ' + (skelRes.note || '已重建') : '✗ 重建失败'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: mut.clear }, '收起'),
          ),
          (skelRes.rebuilt && skelRes.rebuilt.length) ? h('div', { className: 'atc-dim', style: { marginTop: 4 } },
            '重建：' + skelRes.rebuilt.join('、')) : null,
          skelRes.error ? h('div', { className: 'atc-dim', style: { marginTop: 4 } }, skelRes.error) : null,
        ) : null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-sec-h' }, '手册六件套（handbook）'),
            h('span', { className: 'atc-spacer' }),
            hasMissing ? h('button', {
              className: 'atc-btn', disabled: !!mut.busy,
              onClick: function () { mut.send('handbook-skeleton', { scenario: snap.scenario }) },
            }, mut.busy === 'handbook-skeleton' ? '重建中…' : '重建骨架') : null,
          ),
          h('div', { className: 'atc-mini atc-mono', style: { marginBottom: 8 } }, hb.dir),
          !hb.exists ? h('div', { className: 'atc-empty' }, '目录不存在') : hb.files.map(function (f) {
            return h('div', { key: f.file, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: f.exists ? 'atc-ok' : 'atc-no' }, f.exists ? atcIcon('ok') : atcIcon('bad')),
                h('span', { className: 'atc-name', style: { fontSize: 12 } }, f.file),
                h('span', { className: 'atc-spacer' }),
                h('span', { className: 'atc-mini' }, f.exists ? (f.emptySkeleton ? '空壳' : fmtBytes(f.size)) : '缺失'),
              ),
              h('div', { className: 'atc-dim' }, f.label + (f.exists && !f.emptySkeleton ? ' · ' + fmtAgo(f.mtime) : '')),
            )
          }),
        ),
        (hb.audits && hb.audits.length) ? h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '审计报告'),
          hb.audits.map(function (a) {
            return h('div', { key: a.file, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: 'atc-name', style: { fontSize: 12 } }, a.file),
                h('span', { className: 'atc-spacer' }),
                h('span', { className: 'atc-mini' }, fmtBytes(a.size) + ' · ' + fmtAgo(a.mtime)),
              ),
            )
          }),
        ) : null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '其它工作项目录'),
          h('div', { className: 'atc-dim' }, (snap.scenarios || []).join('、') || '无'),
        ),
      )
    }

    function TabPreset(p) {
      var mut = useMutate()
      var snap = p.snap
      var pr = snap.activePreset
      var all = snap.presets.presets || []
      var rb = mut.result && mut.result.op === 'preset-rebuild' ? mut.result.data : null
      var pid = useState(snap.scenario || ''); var presetId = pid[0], setPresetId = pid[1]
      return h('div', null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '当前工作项的预设组合（preset）'),
          !pr ? h('div', { className: 'atc-empty' }, '未找到 preset') : h('div', null,
            h('div', { className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: 'atc-name' }, pr.id),
                h('span', { className: 'atc-pill ' + (pr.hasPersona ? 'run' : 'bad') },
                  pr.hasPersona ? 'persona ' + pr.personaChars + ' 字' : '缺 persona'),
                h('span', { className: 'atc-pill' }, pr.pluginCount + ' 条插件'),
              ),
              h('div', { className: 'atc-dim', style: { marginTop: 4 } }, pr.description || ''),
              h('div', { className: 'atc-mini atc-mono', style: { marginTop: 4 } },
                snap.presets.dir + '\\' + pr.file),
            ),
            h('div', { className: 'atc-sec-h', style: { marginTop: 16 } }, 'plugins 清单'),
            h('ul', { className: 'atc-list atc-mono' }, pr.pluginNames.map(function (n, i) {
              return h('li', { key: i }, n)
            })),
            h('div', { className: 'atc-sec-h', style: { marginTop: 16 } }, 'persona.prefix 原文'),
            h('div', { className: 'atc-persona' }, pr.personaText || '（空）'),
          ),
        ),
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '全部预设组合（preset，共 ' + all.length + '）'),
          h('div', { className: 'atc-card', style: { marginBottom: 8 } },
            h('div', { className: 'atc-row' },
              h('input', {
                className: 'atc-input',
                placeholder: '要重建的 presetId（如 software）',
                value: presetId,
                onChange: function (e) { setPresetId(e.target.value) },
              }),
              h('button', {
                className: 'atc-btn',
                disabled: !!mut.busy || !presetId.trim(),
                onClick: function () { mut.send('preset-rebuild', { presetId: presetId.trim() }) },
              }, mut.busy === 'preset-rebuild' ? '重建中…' : '重建 preset'),
            ),
            h('div', { className: 'atc-mini', style: { marginTop: 4, opacity: 0.82 } },
              '只重建坏掉的（解析失败 / 清单缺 fs-search 或 todo）；健康的会拒绝覆盖，要强制重建须带 force。'),
            rb ? h('div', { style: { marginTop: 8 } },
              h('div', { className: 'atc-name', style: { fontSize: 13 } },
                rb.ok ? (rb.skipped ? '＝ 无需重建' : '✓ preset 已重建') : '✗ 重建失败'),
              h('div', { className: 'atc-mini atc-mono' },
                (rb.file || '') + (rb.backup ? ' · 备份 ' + rb.backup : '')),
              h('div', { className: 'atc-dim' }, rb.note || rb.error || rb.reason || ''),
            ) : null,
          ),
          all.map(function (x) {
            return h('div', { key: x.id, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: 'atc-name', style: { fontSize: 12 } }, x.id),
                x.parseError
                  ? h('span', { className: 'atc-pill bad' }, '解析失败')
                  : h('span', { className: 'atc-pill' }, x.pluginCount + ' 插件'),
                h('span', { className: 'atc-spacer' }),
                x.parseError ? h('button', {
                  className: 'atc-btn',
                  style: { marginRight: 8 },
                  disabled: !!mut.busy,
                  onClick: function () { mut.send('preset-rebuild', { presetId: x.id, force: true }) },
                }, '重建') : null,
                h('span', { className: 'atc-mini' }, fmtAgo(x.mtime)),
              ),
            )
          }),
        ),
      )
    }

    function TabLog(p) {
      var mut = useMutate()
      var snap = p.snap
      var t = snap.team
      var tasks = t.tasks || []
      var msgs = t.messages || []
      var mem = t.memory || []
      var abortRes = mut.result && mut.result.op === 'task-abort' ? mut.result.data : null
      return h('div', null,
        abortRes ? h('div', { className: 'atc-card', style: {
          borderColor: abortRes.ok ? 'color-mix(in srgb,var(--ok) 60%,transparent)' : 'color-mix(in srgb,var(--danger) 60%,transparent)',
          background: abortRes.ok ? 'color-mix(in srgb,var(--ok) 8%,transparent)' : 'color-mix(in srgb,var(--danger) 8%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name', style: { fontSize: 13 } }, abortRes.ok ? '✓ 任务已中断' : '✗ 中断失败'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: mut.clear }, '收起'),
          ),
          h('div', { className: 'atc-dim' }, (abortRes.taskId || '') + (abortRes.error ? ' · ' + abortRes.error : '')),
        ) : null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '任务（' + tasks.length + '）'),
          tasks.length === 0 ? h('div', { className: 'atc-empty' }, '无任务') : tasks.slice(0, 40).map(function (tk) {
            // P1b：卡住的活任务（running/ready/pending）才给中断按钮
            var live = tk.status === 'running' || tk.status === 'ready' || tk.status === 'pending'
            return h('div', { key: tk.id, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: 'atc-pill ' + statusTone(tk.status) }, tk.status || '?'),
                h('span', { className: 'atc-name', style: { fontSize: 12 } }, String(tk.subject || tk.id)),
                h('span', { className: 'atc-spacer' }),
                live ? h('button', {
                  className: 'atc-btn', disabled: !!mut.busy,
                  onClick: function () { mut.send('task-abort', { taskId: tk.id }) },
                }, mut.busy === 'task-abort' ? '中断中…' : '中断') : null,
              ),
              h('div', { className: 'atc-mini' },
                '已试（attempts）' + (tk.attempts || 0) + '/' + (tk.maxAttempts || '?') + ' · ' + (tk.assignee || '未指派')),
            )
          }),
        ),
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '消息通道（' + msgs.length + '）'),
          msgs.length === 0 ? h('div', { className: 'atc-empty' }, '无消息') : msgs.slice(0, 25).map(function (m) {
            return h('div', { key: m.id, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: 'atc-mini' }, (m.from === 'lead' ? 'Lead' : '成员') + ' → ' + (m.to === 'lead' ? 'Lead' : m.to)),
                h('span', { className: 'atc-spacer' }),
                h('span', { className: 'atc-pill ' + (m.deliveredAt ? 'run' : 'warn') },
                  m.deliveredAt ? '已送达' : (m.status || 'queued')),
              ),
              h('div', { className: 'atc-mini', style: { opacity: 0.6, marginTop: 4 } },
                String((m.payload && m.payload.text) || '').slice(0, 140) + '…'),
            )
          }),
        ),
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '记忆（' + mem.length + '）'),
          mem.length === 0 ? h('div', { className: 'atc-empty' }, '无记忆条目') : mem.map(function (mo) {
            return h('div', { key: mo.id, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: 'atc-name', style: { fontSize: 12 } }, mo.slot || mo.key || mo.id),
                h('span', { className: 'atc-pill' }, mo.kind || '?'),
                h('span', { className: 'atc-spacer' }),
                h('span', { className: 'atc-mini' }, fmtBytes(mo.size)),
              ),
            )
          }),
        ),
      )
    }

    function TabScenario(p) {
      var mut = useMutate()
      var s = useState(null); var scData = s[0], setScData = s[1]
      var st = useState(null); var steps = st[0], setSteps = st[1]
      var ld = useState(true); var loading = ld[0], setLoading = ld[1]
      var runRes = mut.result && mut.result.op === 'run' ? mut.result.data : null
      var del = useState(null); var delRes = del[0], setDelRes = del[1]
      // 蒸馏技能（op=distill）：due:false 时把 reason 原文显示出来
      var dr = useState(null); var distillRes = dr[0], setDistillRes = dr[1]
      // 蒸馏门槛从 op=evolve-config 读，拿不到回落 3（不写死在按钮判断里）
      var mr = useState(3); var minRounds = mr[0], setMinRounds = mr[1]
      // 手动「标记本轮完成」回执（成功显示第 N 轮，失败显示卡在哪一步）
      var rdn = useState(null); var roundDoneRes = rdn[0], setRoundDoneRes = rdn[1]

      var load = useCallback(function () {
        setLoading(true)
        Promise.all([
          fetch('/ai-team/api?op=scenarios').then(function (r) { return r.json() }),
          fetch('/ai-team/api?op=steps').then(function (r) { return r.json() }),
          fetch('/ai-team/api?op=evolve-config').then(function (r) { return r.json() }).catch(function () { return null }),
        ]).then(function (arr) {
          setScData(arr[0]); setSteps(arr[1].steps || [])
          var cfg = arr[2]
          var n = cfg && Number(cfg.distillMinRounds)
          setMinRounds(n >= 1 && n <= 10 ? n : 3)
          setLoading(false)
        })
          .catch(function () { setLoading(false) })
      }, [])

      useEffect(function () { load() }, [load])

      var scenarios = (scData && scData.scenarios) || []

      var STATE_LABEL = {
        idle: '未开团', opening: '开团中', running: '跑着', awaiting: '等拍板',
        revising: '返工中', closing: '收口中', done: '已收口',
      }
      function stateTone(s) {
        if (s === 'running') return 'run'
        if (s === 'awaiting') return 'warn'
        if (s === 'idle') return 'idle'
        if (s === 'done') return 'run'
        return 'warn'
      }

      function runIt(id, to) {
        mut.send('run', { scenarioId: id, to: to || 'S8' }).then(function () { load() })
      }

      /* ── 开团前四问（先进编排迭代 4）：L0 单干 / L1 流水线 / L2 扇出 ── */
      var rq = useState({ products: 1, predictable: true, verify: false, independent: false })
      var rl = useState(null); var routeRes = rl[0], setRouteRes = rl[1]
      function askRoute() {
        mut.send('complexity-route', { answers: rq0() }).then(function (d) { setRouteRes(d) })
      }
      function rq0() {
        var a = rq[0]
        return { products: Number(a.products) || 1, predictable: !!a.predictable, verify: !!a.verify, independent: !!a.independent }
      }

      function distillIt(id) {
        mut.send('distill', { scenarioId: id }).then(function (d) { setDistillRes(d) })
      }

      // 手动标记本轮完成：服务端走 running→closing→done 两步状态机，不绕过 rounds
      function roundDoneIt(id) {
        mut.send('round-done', { scenarioId: id }).then(function (d) {
          setRoundDoneRes(d)
          load() // 成功失败都刷新，状态/轮次以服务端为准
        })
      }

      // T17：删除工作项 —— 二次确认 + 刷新列表 + 结果反馈
      function deleteIt(id, name) {
        var label = name || id
        if (!window.confirm('确定删除工作项「' + label + '」？\n只删注册表记录，不删 handbook 目录。')) return
        mut.send('scenario-delete', { id: id }).then(function (d) {
          setDelRes(d)
          load() // 无论成败都刷新，成功能看到它消失，失败能拿到最新状态
        })
      }

      return h('div', null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '工作项（' + scenarios.length + '）· 点工作项跑 9 步流水线'),
          loading ? h('div', { className: 'atc-empty' }, '加载中…')
            : scenarios.length === 0
              ? h('div', { className: 'atc-empty' }, '还没有注册任何工作项')
              : scenarios.map(function (sc) {
                return h('div', { key: sc.id, className: 'atc-card' },
                  h('div', { className: 'atc-row' },
                    h('span', { className: 'atc-name' }, sc.name || sc.id),
                    h('span', { className: 'atc-pill ' + stateTone(sc.state) }, STATE_LABEL[sc.state] || sc.state),
                    h('span', { className: 'atc-pill' }, sc.kind),
                    h('span', { className: 'atc-spacer' }),
                    h('span', {
                      className: 'atc-mini',
                      title: '「已完成」的轮次。会话运行中不计入，需要在卡片上点「标记本轮完成」。',
                    }, '已跑 ' + (sc.rounds || 0) + ' 轮 ⓘ'),
                  ),
                  h('div', { className: 'atc-mini atc-mono', style: { marginTop: 4 } }, sc.id + ' · preset ' + (sc.presetId || '—')),
                  sc.workspace ? h('div', { className: 'atc-mini atc-mono', style: { opacity: 0.6 } }, sc.workspace) : null,
                  h('div', { className: 'atc-row', style: { marginTop: 8 } },
                    h('button', {
                      className: 'atc-btn on',
                      disabled: !!mut.busy,
                      onClick: function () { runIt(sc.id) },
                    }, mut.busy === 'run' ? '执行中…' : '跑流水线'),
                    h('button', {
                      className: 'atc-btn',
                      disabled: !!mut.busy,
                      onClick: function () { runIt(sc.id, 'S1') },
                    }, '只做前置检查'),
                    // 蒸馏技能：门槛读配置(minRounds)，不隐藏门槛，未达标禁用并说明还差几轮
                    h('button', {
                      className: 'atc-btn', style: { borderColor: 'var(--accent)', color: 'var(--accent)' },
                      disabled: !!mut.busy || (sc.rounds || 0) < minRounds,
                      title: (sc.rounds || 0) >= minRounds ? '从交接记录归纳操作手册' : '同一工作项跑满 ' + minRounds + ' 轮才能蒸馏',
                      onClick: function () { distillIt(sc.id) },
                    }, (sc.rounds || 0) >= minRounds ? '蒸馏技能' : '还差 ' + (minRounds - (sc.rounds || 0)) + ' 轮可蒸馏'),
                    // 手动标记本轮完成：running/awaiting 可用，idle 禁用并提示先跑流水线
                    h('button', {
                      className: 'atc-btn',
                      disabled: !!mut.busy || (sc.state !== 'running' && sc.state !== 'awaiting'),
                      title: sc.state === 'idle'
                        ? '先跑流水线开出会话'
                        : (sc.state === 'running' || sc.state === 'awaiting')
                          ? '标记这轮已完成：状态经收口中→已完成，轮次 +1'
                          : '仅跑着 / 等拍板的工作项可标记',
                      onClick: function () { roundDoneIt(sc.id) },
                    }, '标记本轮完成'),
                    h('span', { className: 'atc-spacer' }),
                    h('button', {
                      className: 'atc-btn danger',
                      disabled: !!mut.busy,
                      onClick: function () { deleteIt(sc.id, sc.name) },
                    }, mut.busy === 'scenario-delete' ? '删除中…' : '删除'),
                  ),
                )
              }),
        ),

        // 蒸馏回执：due:false 如实显示 reason 原文，due:true 提示去技能页批准
        distillRes ? h('div', { className: 'atc-card', style: {
          borderColor: 'color-mix(in srgb,' + (distillRes.due ? 'var(--ok)' : 'var(--warn)') + ' 55%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, distillRes.due ? '草稿已生成' : '暂不能蒸馏'),
            h('span', { className: 'atc-pill' }, '已跑 ' + (distillRes.rounds || 0) + ' 轮'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: function () { setDistillRes(null) } }, '收起'),
          ),
          distillRes.error ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)', marginTop: 4 } }, String(distillRes.error)) : null,
          !distillRes.due && distillRes.reason ? h('div', { className: 'atc-mini', style: { color: 'var(--warn)', marginTop: 4 } }, distillRes.reason) : null,
          distillRes.due ? h('div', { className: 'atc-mini', style: { marginTop: 4 } }, '草稿已生成，到「技能」页批准后才生效。') : null,
        ) : null,

        delRes ? h('div', { className: 'atc-card', style: {
          borderColor: delRes.ok ? 'color-mix(in srgb,var(--ok) 55%,transparent)' : 'color-mix(in srgb,var(--danger) 55%,transparent)',
          background: delRes.ok ? 'color-mix(in srgb,var(--ok) 9%,transparent)' : 'color-mix(in srgb,var(--danger) 9%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, delRes.ok ? '✓ 已删除' : '✗ 删除失败'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: function () { setDelRes(null) } }, '收起'),
          ),
          delRes.ok && delRes.removed ? h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            (delRes.removed.name || delRes.removed.id) + ' · handbook 目录已保留') : null,
          !delRes.ok ? h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            delRes.hint || (delRes.errors || []).join('；') || '未知错误') : null,
        ) : null,

        // 标记本轮回执：成功显示第 N 轮，失败说明卡在 closing / done 哪一步
        roundDoneRes ? h('div', { className: 'atc-card', style: {
          borderColor: roundDoneRes.ok ? 'color-mix(in srgb,var(--ok) 55%,transparent)' : 'color-mix(in srgb,var(--danger) 55%,transparent)',
          background: roundDoneRes.ok ? 'color-mix(in srgb,var(--ok) 9%,transparent)' : 'color-mix(in srgb,var(--danger) 9%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, roundDoneRes.ok ? '✓ 已完成第 ' + roundDoneRes.rounds + ' 轮' : '✗ 标记失败'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: function () { setRoundDoneRes(null) } }, '收起'),
          ),
          !roundDoneRes.ok ? h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            '卡在步骤：' + roundDoneRes.step + ' · ' + (roundDoneRes.hint || (roundDoneRes.errors || []).join('；') || '未知错误')
            + (roundDoneRes.note ? ' · ' + roundDoneRes.note : '')) : null,
        ) : null,

        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '开团前四问 · 按需定复杂度档位（L0 单干 / L1 流水线 / L2 扇出）'),
          h('div', { className: 'atc-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 6 } },
            h('label', { className: 'atc-mini' }, '产物几个？',
              h('input', {
                className: 'atc-input', style: { width: 60, marginLeft: 4 },
                type: 'number', min: 0, value: rq[0].products,
                onChange: function (e) { var v = rq[0]; rq[1]({ ...v, products: Number(e.target.value) || 0 }) },
              })),
            ['predictable', 'verify', 'independent'].map(function (k) {
              var LABEL = { predictable: '步骤可预判', verify: '需独立验收', independent: '路线独立' }
              return h('label', { key: k, className: 'atc-mini', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h('input', {
                  type: 'checkbox', checked: !!rq[0][k],
                  onChange: function (e) { var v = rq[0]; rq[1]({ ...v, [k]: e.target.checked }) },
                }), LABEL[k])
            }),
            h('button', { className: 'atc-btn', onClick: askRoute }, '定档'),
          ),
          routeRes ? (routeRes.ok ? h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            h('span', { className: 'atc-pill ' + (routeRes.level === 'L0' ? 'idle' : 'run') }, routeRes.level + ' · ' + (routeRes.levelDef ? routeRes.levelDef.label : '')),
            h('span', { style: { marginLeft: 8 } }, routeRes.trail ? routeRes.trail.join('；') : ''),
            h('div', { style: { opacity: 0.6, marginTop: 2 } }, routeRes.levelDef ? routeRes.levelDef.form : ''),
            routeRes.level === 'L0' ? h('div', { style: { color: 'var(--warn)', marginTop: 2 } },
              '按四问这是 L0：单一产物无需独立验收，Lead 会话直接做更划算——仍要开团的话点「跑流水线」，面板不拦。') : null,
          ) : h('div', { className: 'atc-mini', style: { color: 'var(--danger)' } }, String(routeRes.error || '定档失败'))) : null,
        ),

        runRes ? h('div', { className: 'atc-card', style: {
          borderColor: runRes.ok ? 'color-mix(in srgb,var(--ok) 60%,transparent)' : 'color-mix(in srgb,var(--danger) 60%,transparent)',
          background: runRes.ok ? 'color-mix(in srgb,var(--ok) 8%,transparent)' : 'color-mix(in srgb,var(--danger) 8%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, runRes.ok ? '流水线跑通' : '流水线卡住'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: mut.clear }, '收起'),
          ),
          h('div', { className: 'atc-dim', style: { marginTop: 4 } }, runRes.summary),
          runRes.steps ? h('div', { style: { marginTop: 8 } }, runRes.steps.map(function (s) {
            var GATE_LABEL2 = { continue: '继续门', halt: '终止门', human: '人工门', first: '首件门' }
            return h('div', { key: s.step, className: 'atc-row', style: { padding: '3px 0', alignItems: 'flex-start' } },
              h('span', { className: s.ok ? 'atc-ok' : 'atc-no', style: { flex: 'none', width: 14 } }, s.ok ? atcIcon('ok') : atcIcon('bad')),
              h('span', { className: 'atc-mini', style: { flex: 'none', width: 34, opacity: 0.6 } }, s.step),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'atc-row', style: { alignItems: 'center' } },
                  h('span', { className: 'atc-mini', style: { fontWeight: 600 } }, s.title + ' · ' + s.ms + 'ms'),
                  s.gate ? h('span', { className: 'atc-pill idle', style: { marginLeft: 6 } }, GATE_LABEL2[s.gate] || s.gate) : null,
                ),
                h('div', { className: 'atc-mini', style: { opacity: 0.65 } }, s.detail),
                s.fix ? h('div', { className: 'atc-mini atc-code', style: { marginTop: 4 } }, s.fix) : null,
              ),
            )
          })) : null,
          runRes.costLedgerLine ? h('div', { className: 'atc-mini atc-mono', style: { marginTop: 8, opacity: 0.65 } },
            '成本记账：' + (runRes.costLedgerLine.taskCount || 0) + ' 任务 / ' + (runRes.costLedgerLine.memberCount || 0) + ' 成员 / 路由 ' + (runRes.costLedgerLine.modelRoutes || 'unknown')) : null,
          runRes.routeLevel ? h('div', { className: 'atc-mini', style: { marginTop: 4 } }, '复杂度定档：' + runRes.routeLevel) : null,
        ) : null,

        steps ? h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '流水线 10 步（编排层定义 · 含 S6b 首件检查门）'),
          steps.map(function (s) {
            // 门类型列（先进编排迭代 3）：每个 S 步标注它过的是什么门
            var GATE_LABEL = { continue: '继续门', halt: '终止门', human: '人工门', first: '首件门' }
            var GATE_TONE = { continue: 'idle', halt: 'warn', human: 'warn', first: 'run' }
            return h('div', { key: s.id, className: 'atc-row', style: { padding: '3px 0', alignItems: 'flex-start' } },
              h('span', { className: 'atc-mono', style: { flex: 'none', width: 34, opacity: 0.55 } }, s.id),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'atc-row', style: { alignItems: 'center' } },
                  h('span', { className: 'atc-mini', style: { fontWeight: 600 } }, s.title),
                  s.gate ? h('span', { className: 'atc-pill ' + (GATE_TONE[s.gate] || ''), style: { marginLeft: 6 } }, GATE_LABEL[s.gate] || s.gate) : null,
                ),
                h('div', { className: 'atc-mini', style: { opacity: 0.55 } }, s.hint),
              ),
            )
          }),
        ) : null,
      )
    }

    /* ── 工作区 / 聊天 ───────────────────────────── */

    function TabWorkspace(p) {
      var mut = useMutate()
      var ws = useState(null); var roots = ws[0], setRoots = ws[1]
      var kinds = useState([]); var knownKinds = kinds[0], setKinds = kinds[1]
      var ds = useState(null); var det = ds[0], setDet = ds[1]
      var pin = useState(''); var manualPath = pin[0], setManualPath = pin[1]
      // 这次要做什么（工作项名）：可选，传 name 给 ephemeral/ephemeral-run；空值由服务端回落项目名，卡片上明确区分
      var wn = useState(''); var workName = wn[0], setWorkName = wn[1]
      var wnr = useState(''); var usedWorkName = wnr[0], setUsedWorkName = wnr[1]
      var eph = useState(null); var scene = eph[0], setScene = eph[1]
      var ld = useState(true); var loading = ld[0], setLoading = ld[1]
      var rr = useState(null); var runRes = rr[0], setRunRes = rr[1]
      var sv = useState(''); var saveId = sv[0], setSaveId = sv[1]
      var sn = useState(''); var saveName = sn[0], setSaveName = sn[1]
      var saved = useState(null); var savedRes = saved[0], setSavedRes = saved[1]
      // 内置目录浏览器状态
      var bd = useState(null); var browsing = bd[0], setBrowsing = bd[1]      // 是否打开浮层
      var dp = useState(''); var dirPath = dp[0], setDirPath = dp[1]          // 当前浏览路径
      var dl = useState(null); var dirList = dl[0], setDirList = dl[1]        // {path,parent,dirs,error}
      var dh = useState(0); var dirHi = dh[0], setDirHi = dh[1]               // 键盘高亮索引
      var de = useState(null); var dirErr = de[0], setDirErr = de[1]          // 浏览器内错误原文
      var ae = useState(null); var addErr = ae[0], setAddErr = ae[1]          // add/remove root 错误原文

      function loadRoots() {
        return fetch('/ai-team/api?op=workspace-suggest')
          .then(function (r) { return r.json() })
          .then(function (d) { setRoots(d.roots || []); setKinds(d.kinds || []); setLoading(false); return d })
          .catch(function () { setLoading(false) })
      }
      useEffect(function () { loadRoots() }, [])

      function openBrowser() {
        setBrowsing(true); setDirErr(null); setDirHi(0)
        loadDir(manualPath && manualPath.trim() ? manualPath.trim() : '')
      }
      function loadDir(path) {
        setDirPath(path); setDirHi(0); setDirErr(null)
        fetch('/ai-team/api?op=dir-list&path=' + encodeURIComponent(path || ''), { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) setDirList(d)
            else { setDirList(null); setDirErr(String((d && d.error) || '读不到目录')) }
          })
          .catch(function (x) { setDirList(null); setDirErr(String(x && x.message ? x.message : x)) })
      }
      function pickDir(path) {
        setManualPath(path); setBrowsing(false); probe(path)
      }
      function addRoot() {
        setAddErr(null)
        var path = (dirPath || '').trim()
        if (!path) { setAddErr('请先进入要添加的目录'); return }
        mut.send('workspace-add-root', { path: path }).then(function (d) {
          if (d && d.ok) loadRoots()
          else setAddErr(String((d && d.error) || '添加常用目录失败'))
        })
      }
      function removeRoot(path) {
        setAddErr(null)
        mut.send('workspace-remove-root', { path: path }).then(function (d) {
          if (d && d.ok) loadRoots()
          else setAddErr(String((d && d.error) || '删除常用目录失败'))
        })
      }
      function dirKey(e) {
        if (!browsing) return
        if (e.key === 'Escape') { setBrowsing(false); return }
        var n = dirList && dirList.dirs ? dirList.dirs.length : 0
        if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setDirHi((dirHi + 1) % n); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setDirHi((dirHi - 1 + n) % n); return }
        if (e.key === 'Enter') {
          e.preventDefault()
          if (dirList && dirList.dirs && dirList.dirs[dirHi]) loadDir(dirList.dirs[dirHi].path)
          else if (dirPath) pickDir(dirPath)
        }
      }

      function probe(dir) {
        if (!dir) return
        setDet(null); setScene(null)
        fetch('/ai-team/api?op=detect&dir=' + encodeURIComponent(dir))
          .then(function (r) { return r.json() })
          .then(function (d) {
            setDet(d)
            // 探测成功后，把「存为工作项」的默认值填上（可编辑）
            if (d && d.ok && d.dir) {
              var base = d.dir.split(/[\\/]/).filter(Boolean).pop() || 'proj'
              setSaveName(base)
              setSaveId(asciiId('proj-' + base))
            }
          })
          .catch(function () {})
      }

      // 生成 ASCII 短 id（与 index.js simpleHash 同源口径；这里本地再算一份，纯展示用）
      function asciiId(seed) {
        var h = 0x811c9dc5
        var s = String(seed || 'proj')
        for (var i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i)
          h = (h * 0x01000193) | 0
        }
        var hex = (h >>> 0).toString(16)
        while (hex.length < 8) hex = '0' + hex
        return 'proj-' + hex.slice(0, 8)
      }

      useEffect(function () {
        if (!browsing) return undefined
        document.addEventListener('keydown', dirKey)
        return function () { document.removeEventListener('keydown', dirKey) }
      }, [browsing, dirHi, dirList])

      function workBody(dir) {
        var nm = String(workName || '').trim()
        setUsedWorkName(nm)
        return nm ? { dir: dir, name: nm } : { dir: dir }
      }
      function openHere(dir) {
        mut.send('ephemeral', workBody(dir)).then(function (d) {
          if (d && d.ok) setScene(d)
          else setScene(d)
        })
      }

      // 一键开团并跑首轮 —— ephemeral→run 一次串完，steps trace 直接在本页展示
      function oneShot(dir) {
        mut.send('ephemeral-run', workBody(dir)).then(function (d) { setRunRes(d) })
      }

      // T15：探测成功后「存为工作项」——参数由探测结果自动填充，id/name 可编辑
      function saveAsScenario() {
        if (!det || !det.ok || !det.dir) return
        var kind = det.kind // 服务端会归一（dotnet-script→software 等）
        var body = {
          id: (saveId || '').trim() || asciiId('proj-' + det.dir),
          name: (saveName || '').trim() || (det.dir.split(/[\\/]/).filter(Boolean).pop() || 'proj'),
          kind: kind,
          workspace: det.dir,
          presetId: kind === 'docs' ? 'ai-team' : (kind === 'software' || kind === 'dotnet-script' || kind === 'dotnet' || kind === 'node' || kind === 'python' || kind === 'rust' || kind === 'go') ? 'software' : 'ai-team',
          constraints: det.constraints || {},
        }
        mut.send('scenario-add', body).then(function (d) {
          setSavedRes(d)
          if (d && d.ok) {
            // 保存成功：清探测态，切到「工作项 / 编排」页签看结果
            setDet(null); setScene(null)
            if (typeof p.setTab === 'function') p.setTab('scenario')
            if (typeof p.onSnapshot === 'function') p.onSnapshot(true)
          }
        })
      }

      return h('div', null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '选一个文件夹开团（不在面板里写死任何项目）'),
          h('div', { className: 'atc-row', style: { marginBottom: 8 } },
            h('input', {
              className: 'atc-input',
              placeholder: '项目文件夹的完整路径，或从下面点选',
              value: manualPath,
              onChange: function (e) { setManualPath(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') probe(manualPath) },
            }),
            h('button', { className: 'atc-btn', onClick: openBrowser }, '浏览…'),
            h('button', { className: 'atc-btn', onClick: function () { probe(manualPath) } }, '探测'),
          ),
          // 内置目录浏览器浮层
          browsing ? h('div', { className: 'atc-dir-overlay', onClick: function () { setBrowsing(false) } },
            h('div', { className: 'atc-dir-panel', onClick: function (e) { e.stopPropagation() } },
              // 顶部：面包屑 + 上一级 + 当前路径
              h('div', { className: 'atc-dir-crumbs' },
                h('button', { className: 'atc-dir-crumb', onClick: function () { loadDir('') } }, '根目录'),
                dirList && dirList.parent !== undefined && dirList.parent !== null ? h('span', null,
                  h('span', { className: 'atc-dir-sep' }, ' › '),
                  h('button', { className: 'atc-dir-crumb', onClick: function () { loadDir(dirList.parent) } }, '↑ 上一级'),
                ) : null,
                h('span', { className: 'atc-dir-sep' }, ' · '),
                h('span', { className: 'atc-mono' }, dirPath || '（根目录）'),
              ),
              // 中部：子目录列表（单击高亮/进入，双击确认选中）
              h('div', { className: 'atc-dir-list' },
                dirErr ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)' } }, dirErr)
                  : (dirList && dirList.dirs && dirList.dirs.length)
                    ? dirList.dirs.map(function (d0, i) {
                        return h('button', {
                          key: d0.path,
                          className: 'atc-dir-item' + (i === dirHi ? ' hl' : ''),
                          onClick: function () { setDirHi(i); loadDir(d0.path) },
                          onDoubleClick: function () { pickDir(d0.path) },
                        }, h('span', { className: 'atc-ok' }, '▸'), h('span', null, d0.name))
                      })
                    : h('div', { className: 'atc-mini atc-empty' }, '这里没有子目录'),
              ),
              // 底部：选这个 / 取消 / 添加为常用目录 / 错误
              h('div', { className: 'atc-dir-foot' },
                h('button', {
                  className: 'atc-btn', style: { borderColor: 'var(--accent)', color: 'var(--accent)' },
                  disabled: !dirPath, onClick: function () { pickDir(dirPath) },
                }, '选这个文件夹'),
                h('button', { className: 'atc-btn', onClick: function () { setBrowsing(false) } }, '取消'),
                h('span', { className: 'atc-spacer' }),
                h('button', { className: 'atc-btn', disabled: !dirPath, onClick: addRoot }, '+ 添加为常用目录'),
              ),
              addErr ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)', padding: '0 16px 12px' } }, addErr) : null,
            ),
          ) : null,
          loading ? h('div', { className: 'atc-mini' }, '加载候选…')
            : (roots || []).map(function (root) {
              return h('div', { key: root.path, className: 'atc-card' },
                h('div', { className: 'atc-row' },
                  h('span', { className: 'atc-name', style: { fontSize: 12 } }, root.label),
                  h('span', { className: 'atc-spacer' }),
                  h('span', { className: 'atc-mini' }, (root.children || []).length + ' 个子项'),
                  // 只有用户自加的根（source=user）才有可删除的 ×；默认/盘符根删了也会再出现，
                  // source 缺失（旧服务端）时不显示，避免出现点了没反应的按钮
                  root.source === 'user' ? h('button', {
                        className: 'atc-btn danger', title: '从常用目录删除',
                        style: { padding: '2px 8px' },
                        onClick: function () { removeRoot(root.path) },
                      }, '×') : null,
                ),
                h('div', { className: 'atc-row', style: { marginTop: 4, gap: '4px', flexWrap: 'wrap' } },
                  (root.children || []).map(function (c) {
                    return h('button', {
                      key: c.path, className: 'atc-btn', style: { fontSize: 11, padding: '2px 7px' },
                      onClick: function () { setManualPath(c.path); probe(c.path) },
                    }, c.name)
                  }),
                ),
              )
            }),
          addErr ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)', marginTop: 4 } }, addErr) : null,
        ),

        det ? h('div', { className: 'atc-card', style: {
          borderColor: det.kind ? 'color-mix(in srgb,var(--ok) 50%,transparent)' : 'color-mix(in srgb,var(--danger) 50%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, det.kind ? det.label : '未识别/不可用'),
            h('span', { className: 'atc-pill' }, det.kind || '—'),
            h('span', { className: 'atc-spacer' }),
            h('span', { className: 'atc-mini atc-mono' }, det.dir),
          ),
          det.evidence && det.evidence.length ? h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            '识别依据：' + det.evidence.slice(0, 5).join('、')) : null,
          det.stats ? h('div', { className: 'atc-mini', style: { marginTop: 4, opacity: 0.65 } },
            '文件 ' + det.stats.files + ' · git ' + (det.gitRepo ? '有' : '无') +
            (det.stats.csprojCount !== undefined ? ' · csproj ' + det.stats.csprojCount : '')) : null,
          det.reason ? h('div', { className: 'atc-dim', style: { marginTop: 4 } }, det.reason) : null,
          det.children && det.children.length ? h('div', { className: 'atc-row', style: { marginTop: 8, gap: '4px', flexWrap: 'wrap' } },
            det.children.map(function (c) {
              return h('button', {
                key: c.path, className: 'atc-btn on', style: { fontSize: 11 },
                onClick: function () { setManualPath(c.path); probe(c.path) },
              }, c.name)
            })) : null,
          det.ok && det.kind && det.kind !== 'container'
            ? h('div', { style: { marginTop: 8 } },
                // 可选工作项名：区分「这次要做什么」与项目目录名
                h('div', { className: 'atc-row', style: { marginBottom: 8 } },
                  h('span', { className: 'atc-mini', style: { flex: 'none' } }, '这次要做什么'),
                  h('input', {
                    className: 'atc-input',
                    placeholder: '例如：优化启动速度 / 修复登录报错（不填则用项目名）',
                    value: workName,
                    onChange: function (e) { setWorkName(e.target.value) },
                  }),
                ),
                h('div', { className: 'atc-row' },
                  h('button', {
                    className: 'atc-btn on', disabled: !!mut.busy,
                    onClick: function () { openHere(det.dir) },
                  }, mut.busy === 'ephemeral' ? '开团中…' : '就在这个文件夹开团'),
                  h('button', {
                    className: 'atc-btn on', disabled: !!mut.busy,
                    onClick: function () { oneShot(det.dir) },
                  }, mut.busy === 'ephemeral-run' ? '开团跑首轮中…' : '一键开团并跑首轮'),
                ),
                // T15：存为工作项 —— id/name 可编辑，参数由探测自动填充
                h('div', { className: 'atc-sec', style: { marginTop: 12, marginBottom: 0 } },
                  h('div', { className: 'atc-sec-h' }, '存为工作项（写进注册表，之后可复用）'),
                  h('div', { className: 'atc-row', style: { marginBottom: 8 } },
                    h('span', { className: 'atc-mini', style: { flex: 'none' } }, 'id'),
                    h('input', {
                      className: 'atc-input',
                      value: saveId,
                      onChange: function (e) { setSaveId(e.target.value) },
                      placeholder: 'proj-xxxxxxxx（ASCII，不含中文）',
                    }),
                  ),
                  h('div', { className: 'atc-row', style: { marginBottom: 8 } },
                    h('span', { className: 'atc-mini', style: { flex: 'none' } }, '名称'),
                    h('input', {
                      className: 'atc-input',
                      value: saveName,
                      onChange: function (e) { setSaveName(e.target.value) },
                      placeholder: '默认用目录 basename（可含中文）',
                    }),
                  ),
                  h('div', { className: 'atc-row' },
                    h('button', {
                      className: 'atc-btn on', disabled: !!mut.busy,
                      onClick: saveAsScenario,
                    }, mut.busy === 'scenario-add' ? '保存中…' : '存为工作项'),
                    h('span', { className: 'atc-mini' },
                      'kind ' + det.kind + ' · workspace ' + det.dir),
                  ),
                  savedRes ? h('div', {
                    className: 'atc-card',
                    style: {
                      marginTop: 8,
                      borderColor: savedRes.ok ? 'color-mix(in srgb,var(--ok) 55%,transparent)' : 'color-mix(in srgb,var(--danger) 55%,transparent)',
                      background: savedRes.ok ? 'color-mix(in srgb,var(--ok) 9%,transparent)' : 'color-mix(in srgb,var(--danger) 9%,transparent)',
                    },
                  },
                    savedRes.ok
                      ? h('div', null,
                          h('div', { className: 'atc-name' }, '✓ 已存为工作项'),
                          h('div', { className: 'atc-mini', style: { marginTop: 4 } },
                            savedRes.scenario.id + ' · ' + savedRes.scenario.name),
                        )
                      : h('div', null,
                          h('div', { className: 'atc-name' }, '✗ ' + (savedRes.reason === 'duplicate' ? 'id 已存在' : '保存失败')),
                          h('div', { className: 'atc-mini', style: { marginTop: 4 } },
                            savedRes.hint || (savedRes.errors || []).join('；') || '未知错误')),
                  ) : null,
                ),
              )
            : null,
        ) : null,

        runRes ? h('div', { className: 'atc-card', style: {
          borderColor: runRes.ok ? 'color-mix(in srgb,var(--ok) 60%,transparent)' : 'color-mix(in srgb,var(--danger) 60%,transparent)',
          background: runRes.ok ? 'color-mix(in srgb,var(--ok) 8%,transparent)' : 'color-mix(in srgb,var(--danger) 8%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, runRes.ok ? '一键开团 · 首轮流水线跑通' : '一键开团 · 卡住'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: function () { setRunRes(null) } }, '收起'),
          ),
          h('div', { className: 'atc-dim', style: { marginTop: 4 } }, runRes.summary || (runRes.errors || []).join('；') || ''),
          runRes.steps ? h('div', { style: { marginTop: 8 } }, runRes.steps.map(function (s) {
            return h('div', { key: s.step, className: 'atc-row', style: { padding: '3px 0', alignItems: 'flex-start' } },
              h('span', { className: s.ok ? 'atc-ok' : 'atc-no', style: { flex: 'none', width: 14 } }, s.ok ? atcIcon('ok') : atcIcon('bad')),
              h('span', { className: 'atc-mini', style: { flex: 'none', width: 34, opacity: 0.6 } }, s.step),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'atc-mini', style: { fontWeight: 600 } }, s.title + ' · ' + s.ms + 'ms'),
                h('div', { className: 'atc-mini', style: { opacity: 0.65 } }, s.detail),
                s.fix ? h('div', { className: 'atc-mini atc-code', style: { marginTop: 4 } }, s.fix) : null,
              ),
            )
          })) : null,
        ) : null,

        scene && scene.ok ? h('div', { className: 'atc-card', style: {
          background: 'color-mix(in srgb,var(--ok) 10%,transparent)',
          borderColor: 'color-mix(in srgb,var(--ok) 55%,transparent)',
        } },
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, usedWorkName || ('未命名工作项 · ' + (scene.scenario.name || '项目名'))),
            h('span', { className: 'atc-pill run' }, '临时工作项'),
            h('span', { className: 'atc-spacer' }),
            h('button', { className: 'atc-btn', onClick: function () { setScene(null); setDet(null) } }, '收起'),
          ),
          h('div', { className: 'atc-mini', style: { marginTop: 4 } },
            'kind ' + scene.scenario.kind + ' · preset ' + scene.scenario.presetId + ' · 未写入注册表'),
          h('div', { className: 'atc-code', style: { marginTop: 8 } },
            Object.keys(scene.scenario.constraints || {}).length
              ? Object.keys(scene.scenario.constraints).map(function (k) {
                  return k + ': ' + String(scene.scenario.constraints[k]).slice(0, 70)
                }).join('\n')
              : '（未推断出约束）'),
          h('div', { className: 'atc-mini', style: { marginTop: 8, opacity: 0.8 } },
            '下一步：到「工作项 / 编排」页跑流水线，或到「对话」页跟这支团队聊。'),
        ) : (scene && !scene.ok ? h('div', { className: 'atc-card' },
          h('div', { className: 'atc-no' }, '开不了团'),
          h('div', { className: 'atc-dim', style: { marginTop: 4 } }, (scene.errors || []).join('；')),
          scene.hint ? h('div', { className: 'atc-mini', style: { marginTop: 4 } }, scene.hint) : null,
        ) : null),
      )
    }

    /* ── ：chat-open 反馈的纯视图模型 ──────
     * 为什么提出来：面板是 React 闭包里的代码，node 侧没法渲染它。
     * 把「拿到回执后该说什么、该给哪些按钮」做成纯函数放在模块作用域，
     * 渲染层只负责摆出来，验证脚本（scripts\verify-chat-feedback.mjs）就能
     * 真跑这段代码 —— 不是读源码正则。
     * 判定逻辑（能不能用、被什么挡、有哪些替代）全在后端 chat.mjs/routes.mjs，
     * 这里只做「把结构化事实翻译成人话 + 给下一步动作」。
     */
    var ROUTE_SOURCE_LABEL = {
      'explicit': '显式指定',
      'config-chain': '配置链回落',
      'host-default': '宿主快照回落',
    }

    /** 通道来源 → 人话；null 说明没选到通道，别假装是某一档来源 */
    function sourceLabel(s) {
      if (!s) return '未选定（无可用通道）'
      return (ROUTE_SOURCE_LABEL[s] || s) + '（' + s + '）'
    }

    /** 'provider/model' → {provider, model}；形状不对给 null（不猜） */
    function splitRouteKey(key) {
      var k = String(key == null ? '' : key)
      var i = k.indexOf('/')
      if (i <= 0 || i >= k.length - 1) return null
      return { provider: k.slice(0, i), model: k.slice(i + 1) }
    }

    /**
     * 通道下拉的选项模型（验收④：被禁的**照样列出**，只标注原因，不藏）。
     * 藏起来用户会以为面板坏了；列出来他才明白为什么不能用。
     * @param {Array} cands op=routes 的 candidates（candidatePool 的形状）
     */
    function chatRouteOptions(cands) {
      var list = Array.isArray(cands) ? cands : []
      var byKey = {}
      for (var i = 0; i < list.length; i++) {
        var c = list[i]
        if (!c || !c.key || byKey[c.key]) continue
        byKey[c.key] = c
      }
      var keys = Object.keys(byKey).sort(function (a, b) {
        var ra = (byKey[a].providerRank || 99) - (byKey[b].providerRank || 99)
        if (ra) return ra
        var ma = byKey[a].multiplier == null ? 9e9 : byKey[a].multiplier
        var mb = byKey[b].multiplier == null ? 9e9 : byKey[b].multiplier
        if (ma !== mb) return ma - mb
        return a.localeCompare(b)
      })
      var groups = []
      var cur = null
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j]
        var r = byKey[k]
        var pv = r.provider || '?'
        if (!cur || cur.provider !== pv) {
          // 整条通道停用 = 该 provider 一条可用都没有（比「有一条被挡」更该在标题上说清楚）
          var anyOk = list.some(function (x) { return x && x.provider === pv && x.allowed === true })
          cur = { provider: pv, wholeOff: !anyOk, options: [] }
          groups.push(cur)
        }
        var why = null
        if (!r.allowed) {
          why = r.blockedBy === 'provider-disabled'
            ? (r.disabledReason || r.gateReason || '已停用')
            : (r.gateReason || r.blockedBy || '不可用')
        }
        cur.options.push({
          key: k,
          provider: pv,
          allowed: r.allowed === true,
          multiplier: r.multiplier == null ? null : r.multiplier,
          blockedBy: r.blockedBy || null,
          why: why,
          // 禁用项带 ⛔ 前缀 + 原因：看得见、也知道为什么不能选
          label: r.allowed
            ? (k + ' · x' + (r.multiplier == null ? '未知' : r.multiplier))
            : ('⛔ ' + k + ' — 已禁用：' + why),
        })
      }
      return { groups: groups, byKey: byKey }
    }

    /**
     * chat-open 回执 → 可读反馈模型（验收①②③）。
     * 关键纪律：**任何失败分支都必须有 title + 至少一条可读说明**，
     * 不许出现只有「失败」两个字或一张空白红卡的情况；
     * 被禁通道给 alternatives 按钮 + 可复制字符串。
     */
    function chatOpenVM(info) {
      var d = info && typeof info === 'object' ? info : {}
      var blocked = d.blocked || null
      var alts = Array.isArray(d.alternatives) ? d.alternatives : []
      var gated = Array.isArray(d.gatedOut) ? d.gatedOut : []
      var tried = Array.isArray(d.tried) ? d.tried : []
      var vm = {
        tone: d.ok ? 'ok' : 'bad',
        // 默认标题：后端一个字段都没给时也不能是空串（否则面板是一张空白红卡）
        title: d.ok ? '' : '开启线程失败',
        sourceText: sourceLabel(d.routeSource || null),
        warning: d.warning || d.routeWarning || null,
        errorText: d.error || null,
        blocked: blocked,
        blockedPills: [],
        altButtons: [],
        hint: d.hint || null,
        gatedRows: [],
        tried: tried,
        copyKeys: [],
        nextStep: null,
        rateText: null,
      }
      if (d.ok) {
        vm.title = '线程已建立'
        return vm
      }
      vm.title = d.reason === 'explicit-blocked'
        ? '指定的通道已被禁用，未创建会话'
        : (d.reason === 'no-route' ? '没有可用通道，未创建会话' : '开启线程失败')
      if (blocked && blocked.blockedBy) vm.blockedPills.push(blocked.blockedBy)
      if (d.reason) vm.blockedPills.push(d.reason)
      // 倍率类拦截：把「多少 vs 上限多少」讲出来，用户才知道要调哪里
      if (blocked && blocked.multiplier != null && blocked.cap != null) {
        vm.rateText = '倍率 x' + blocked.multiplier + ' ／ 生效上限 x' + blocked.cap
          + (blocked.capSource === 'provider' ? '（通道级上限 provider cap）' : '（全局上限）')
      }
      // no-route 时后端给的是 gatedOut[]：逐条翻成「谁被什么挡」
      for (var g = 0; g < gated.length && g < 8; g++) {
        var x = gated[g] || {}
        vm.gatedRows.push(
          (x.provider || '?') + '/' + (x.model || '?') + ' — ' + (x.blockedBy || '?')
          + (x.disabledReason ? '（' + x.disabledReason + '）' : ''))
      }
      // 替代通道 → 可点按钮（每条自带 provider/model，点击直接重开）
      for (var i = 0; i < alts.length; i++) {
        var a = alts[i] || {}
        var sp = splitRouteKey(a.key)
        if (!sp) continue
        vm.altButtons.push({
          key: a.key,
          provider: sp.provider,
          model: sp.model,
          reasoningEffort: a.reasoningEffort || null,
          multText: 'x' + (a.multiplier == null ? '未知' : a.multiplier),
          fromText: a.from || null,
        })
        vm.copyKeys.push(a.key)
      }
      if (blocked && blocked.key) vm.copyKeys.unshift(blocked.key)
      // 没替代时给一条明确的下一步（指到能改的地方，不甩锅给用户）
      if (!vm.altButtons.length && d.reason === 'explicit-blocked') {
        vm.nextStep = '配置链上也没有可用替代：到「模型配置」页（页签「模型」）放开一条通道（启用整条通道 / 调高倍率上限），再回来点开启线程。'
      }
      return vm
    }

    function TabChat(p) {
      var mut = useMutate()
      var cap = useState(null); var capability = cap[0], setCapability = cap[1]
      var th = useState(null); var thread = th[0], setThread = th[1]
      var sd = useState([]); var sends = sd[0], setSends = sd[1]
      var txt = useState(''); var input = txt[0], setInput = txt[1]
      var sid = useState(''); var sceneId = sid[0], setSceneId = sid[1]
      var mg = useState([]); var msgs = mg[0], setMsgs = mg[1]
      var re = useState(null); var readErr = re[0], setReadErr = re[1]
      var rm = useState(null); var readMeta = rm[0], setReadMeta = rm[1]
      // chat-open 的完整回执（成功或失败都要「看得到」）。
      // 修复前 openIt 只处理 d.ok，失败被整个丢掉——点了被禁通道就是静默失败。
      var oi = useState(null); var openInfo = oi[0], setOpenInfo = oi[1]
      // 显式通道下拉的选择值；候选来自只读 op=routes（含被禁项，不藏——见验收④）
      var pk = useState(''); var pickRoute = pk[0], setPickRoute = pk[1]
      var cd = useState([]); var candRows = cd[0], setCandRows = cd[1]
      var cp = useState(null); var copiedKey = cp[0], setCopiedKey = cp[1]

      useEffect(function () {
        fetch('/ai-team/api?op=chat-capability')
          .then(function (r) { return r.json() })
          .then(function (d) { setCapability(d) })
          .catch(function () {})
      }, [])

      // 候选通道表（挂载时读一次：面板里改门槛后切回本页会重新挂载）
      useEffect(function () {
        fetch('/ai-team/api?op=routes', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) { setCandRows((d && d.candidates) || []) })
          .catch(function () {})
      }, [])

      // 读真实转录（chat-read）：followup 只回报「已投递」，回答得从会话日志读
      function chatRead(scene, sessionId) {
        var body = { limit: 80 }
        if (scene) body.sceneId = scene
        if (sessionId) body.sessionId = sessionId
        return fetch('/ai-team/api?op=chat-read', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json() })
      }

      function applyRead(d) {
        if (d && d.ok) {
          setMsgs(d.messages || [])
          setReadMeta(d)
          setReadErr(null)
        } else {
          setReadErr((d && (d.error || d.reason)) || '读取失败')
        }
      }

      function remember(scene, sessionId) {
        try {
          localStorage.setItem('atc.lastThread', JSON.stringify({ sceneId: scene, sessionId: sessionId }))
        } catch (e) { /* 隐私模式下写不了就算了 */ }
      }

      // 线程一开就轮询：用户的提问和 AI 的回答都从转录里回来
      var activeSid = thread && thread.sessionId
      useEffect(function () {
        if (!activeSid || !sceneId) return undefined
        var alive = true
        function tick() {
          chatRead(sceneId, activeSid).then(function (d) {
            if (alive) applyRead(d)
          }).catch(function (x) {
            if (alive) setReadErr(String(x && x.message ? x.message : x))
          })
        }
        tick()
        var t = setInterval(tick, 2000)
        return function () { alive = false; clearInterval(t) }
      }, [activeSid, sceneId])

      /* chat-open 回执的翻译逻辑在模块级（sourceLabel / chatOpenVM / chatRouteOptions），
       * 这里只留「拿回执 → 存进 state」与「把 VM 摆出来」。 */
      function openIt() {
        if (!sceneId) return
        var body = { sceneId: sceneId }
        // 用户在下拉里显式点了某条通道 → 拆成 provider/model 传上去；
        // 被禁 / 被 cap 挡的会拿到 explicit-blocked，正是本组反馈要展示的东西。
        if (pickRoute) {
          var sp = splitRouteKey(pickRoute)
          if (sp) { body.provider = sp.provider; body.model = sp.model }
        }
        // 失败时把后端给的结构化字段**原样**存下来（字段名一个都不重排，
        // 免得前端「自己洗掉」接线错误 —— 这一点被变异检验抓过一次）。
        var fail = function (patch) {
          setOpenInfo(Object.assign({
            ok: false, reason: null, error: null, routeSource: null,
            blocked: null, alternatives: [], hint: null, tried: [], gatedOut: [], hostRoute: null,
          }, patch))
        }
        mut.send('chat-open', body).then(function (d) {
          if (!d) { fail({ error: '请求没走通（宿主没回包）' }); return }
          if (d.ok) {
            setThread(d.thread)
            remember(sceneId, d.thread && d.thread.sessionId)
            setOpenInfo({ ok: true, routeSource: d.routeSource || null, warning: d.routeWarning || null })
          } else {
            fail({
              reason: d.reason || null,
              error: d.error || null,
              routeSource: d.routeSource || null,
              blocked: d.blocked || null,
              alternatives: d.alternatives || [],
              hint: d.hint || null,
              tried: d.tried || [],
              gatedOut: d.gatedOut || [],
              hostRoute: d.hostRoute || null,
            })
          }
        })
      }

      // 点替代通道 → 用它重开本工作项的线程（不用用户自己抄字符串）
      function openWithRoute(key, effort) {
        if (!sceneId || !key) return
        var sp = splitRouteKey(key)
        if (!sp) return
        setPickRoute(key)
        mut.send('chat-open', {
          sceneId: sceneId,
          provider: sp.provider,
          model: sp.model,
          reasoningEffort: effort || undefined,
        }).then(function (d) {
          if (d && d.ok) {
            setThread(d.thread)
            remember(sceneId, d.thread && d.thread.sessionId)
            setOpenInfo({ ok: true, routeSource: d.routeSource || null, warning: d.routeWarning || null })
          } else if (d) {
            setOpenInfo({
              ok: false, reason: d.reason || null, error: d.error || null,
              routeSource: d.routeSource || null, blocked: d.blocked || null,
              alternatives: d.alternatives || [], hint: d.hint || null,
              tried: d.tried || [], gatedOut: d.gatedOut || [], hostRoute: d.hostRoute || null,
            })
          } else {
            setOpenInfo({ ok: false, error: '请求没走通（宿主没回包）' })
          }
        })
      }

      // 剪贴板兜底：execCommand 这条路不依赖安全上下文（侧栏里常是 http://127.0.0.1）
      function copyRoute(key) {
        var done = function () { setCopiedKey(key); setTimeout(function () { setCopiedKey(null) }, 1600) }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(key).then(done, function () { fallbackCopy(key); done() })
            return
          }
        } catch (e) { /* 走兜底 */ }
        fallbackCopy(key); done()
      }
      function fallbackCopy(text) {
        try {
          var ta = document.createElement('textarea')
          ta.value = text
          ta.setAttribute('readonly', '')
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          try { document.execCommand('copy') } catch (e) { /* 忽略：下面仍会把原文显示出来 */ }
          document.body.removeChild(ta)
        } catch (e) { /* 复制不了也要能看见字符串 */ }
      }

      // 宿主重启后内存线程表已失：用上次记下的 sessionId 直接把历史读回来
      function loadHistory() {
        var last = null
        try { last = JSON.parse(localStorage.getItem('atc.lastThread') || 'null') } catch (e) { last = null }
        if (!last || !last.sessionId) {
          setReadErr('没有可载入的历史会话（本机还没开过线程）')
          return
        }
        var scene = last.sceneId || sceneId
        if (last.sceneId) setSceneId(last.sceneId)
        chatRead(scene, last.sessionId).then(function (d) {
          if (d && d.ok) {
            setThread({ sessionId: last.sessionId, turns: (d.messages || []).length, restored: true })
          }
          applyRead(d)
        }).catch(function (x) { setReadErr(String(x && x.message ? x.message : x)) })
      }

      function sendIt() {
        var t = input.trim()
        if (!t || !sceneId) return
        setSends(sends.concat([{ role: 'user', text: t, at: Date.now() }]))
        setInput('')
        mut.send('chat-send', { sceneId: sceneId, text: t }).then(function (d) {
          if (!d || !d.ok) {
            setSends(function (prev) {
              return prev.concat([{
                role: 'agent',
                text: '发送失败：' + ((d && (d.error || d.reason)) || '未知'),
                ok: false,
                at: Date.now(),
              }])
            })
            return
          }
          var got = (d.thread && d.thread.sessionId) || (thread && thread.sessionId)
          if (got) remember(sceneId, got)
          // 投递成功：700ms 后读一次，让提问立刻进气泡；回答由 2s 轮询补上
          setTimeout(function () {
            var useSid = got || (thread && thread.sessionId)
            if (!useSid) return
            chatRead(sceneId, useSid).then(function (r) {
              if (r && r.ok) applyRead(r)
            }).catch(function () {})
          }, 700)
        })
      }

      // 气泡数据源：优先真实转录（含 AI 回答），还没读到就用本地乐观消息
      var bubbles = (msgs && msgs.length)
        ? msgs.map(function (m) {
          return { role: m.role === 'user' ? 'user' : 'agent', text: m.text, at: m.at, ok: true }
        })
        : sends

      var usable = capability && capability.usable

      return h('div', { className: 'atc-root', style: { padding: 0 } },
        h('div', { className: 'atc-sec', style: { padding: '12px 16px 0' } },
          h('div', { className: 'atc-sec-h' }, '对话（每个工作项一个独立线程，互不串）'),
          !capability ? h('div', { className: 'atc-mini' }, '探测中…')
            : !usable
              ? h('div', { className: 'atc-card', style: {
                  borderColor: 'color-mix(in srgb,var(--danger) 55%,transparent)',
                  background: 'color-mix(in srgb,var(--danger) 9%,transparent)',
                } },
                  h('div', { className: 'atc-name' }, '聊天通道当前不可用'),
                  h('div', { className: 'atc-dim', style: { marginTop: 4 } },
                    '宿主没暴露需要的服务，所以没法在这里建会话。'),
                  h('ul', { className: 'atc-list', style: { marginTop: 4 } },
                    (capability.detail || []).map(function (x, i) { return h('li', { key: i, className: 'atc-mini' }, x) })),
                  h('div', { className: 'atc-mini', style: { marginTop: 8, opacity: 0.8 } },
                    '面板其余功能（编排、验收、缺口、preset）不受影响。对话可以暂时在主会话里进行。'),
                )
              : h('div', null,
                  h('div', { className: 'atc-row', style: { marginBottom: 8 } },
                    h('input', {
                      className: 'atc-input',
                      placeholder: '工作项 id（自定义名称，或用临时工作项的 id）',
                      value: sceneId,
                      onChange: function (e) { setSceneId(e.target.value) },
                    }),
                    // 通道选择：留空＝不显式传（按配置链回落）；被禁 / 被 cap 挡的通道
                    // **照样列出来**，只在文案上标「已禁用：原因」——藏起来用户会以为面板坏了。
                    (function () {
                      var opts = chatRouteOptions(candRows)
                      var nodes = [h('option', { key: '__auto', value: '' }, '自动回落（不显式指定通道）')]
                      for (var gi = 0; gi < opts.groups.length; gi++) {
                        var gp = opts.groups[gi]
                        nodes.push(h('optgroup', {
                          key: 'g-' + gp.provider,
                          label: gp.provider + (gp.wholeOff ? '（停用整条通道）' : ''),
                        }, gp.options.map(function (o) {
                          return h('option', { key: o.key, value: o.key }, o.label)
                        })))
                      }
                      return h('select', {
                        className: 'atc-input',
                        style: { maxWidth: 300 },
                        title: '选「自动回落」＝不显式传模型，按配置链取；选具体通道＝显式传（被禁的会给出原因与替代）',
                        value: pickRoute,
                        disabled: !!mut.busy,
                        onChange: function (e) { setPickRoute(e.target.value) },
                      }, nodes)
                    })(),
                    h('button', { className: 'atc-btn', disabled: !!mut.busy, onClick: openIt },
                      mut.busy === 'chat-open' ? '开启中…' : '开启线程'),
                  ),
                  // chat-open 回执：成功显示来源档，失败把 blocked/hint/可点替代全说出来，
                  // 绝不只显示「失败」两个字，也绝不静默。
                  (function () {
                    if (!openInfo) return null
                    var vm = chatOpenVM(openInfo)
                    var okTone = vm.tone === 'ok'
                    return h('div', {
                      className: 'atc-card', style: {
                        marginBottom: 8,
                        borderColor: 'color-mix(in srgb,' + (okTone ? 'var(--ok) 45%' : 'var(--danger) 50%') + ',transparent)',
                        background: 'color-mix(in srgb,' + (okTone ? 'var(--ok) 8%' : 'var(--danger) 8%') + ',transparent)',
                      },
                    },
                      h('div', { className: 'atc-row' },
                        h('span', { className: okTone ? 'atc-ok' : 'atc-no' }, okTone ? atcIcon('ok') : atcIcon('bad')),
                        h('span', { className: 'atc-name' }, vm.title),
                        vm.blockedPills.map(function (pb, i) {
                          return h('span', { key: i, className: 'atc-pill ' + (i === 0 ? 'bad' : 'idle') }, pb)
                        }),
                        h('span', { className: 'atc-pill' }, vm.sourceText),
                      ),
                      // 到底被什么挡：blockedBy 中文标签 + 原始 reason + 停用原因 + 倍率
                      vm.blocked ? h('div', { style: { marginTop: 4 } },
                        vm.blocked.key ? h('div', { className: 'atc-mono' }, vm.blocked.key) : null,
                        vm.blocked.blockedLabel ? h('div', { className: 'atc-mini' }, '挡在：' + vm.blocked.blockedLabel) : null,
                        vm.blocked.reason ? h('div', { className: 'atc-dim', style: { marginTop: 4 } }, vm.blocked.reason) : null,
                        vm.blocked.disabledReason ? h('div', {
                          className: 'atc-mini', style: { marginTop: 4, color: 'var(--warn)' },
                        }, '停用原因：' + vm.blocked.disabledReason) : null,
                        vm.rateText ? h('div', { className: 'atc-mini', style: { marginTop: 4 } }, vm.rateText) : null,
                      ) : null,
                      // no-route 时后端给的是 gatedOut[]：逐条说清哪条被什么挡
                      vm.gatedRows.length ? h('ul', { className: 'atc-list', style: { marginTop: 4 } },
                        vm.gatedRows.map(function (s, i) { return h('li', { key: i, className: 'atc-mini' }, s) })) : null,
                      vm.errorText ? h('div', { className: 'atc-mini', style: { marginTop: 4 } }, vm.errorText) : null,
                      vm.hint ? h('div', { className: 'atc-dim', style: { marginTop: 4 } }, vm.hint) : null,
                      vm.warning ? h('div', { className: 'atc-mini', style: { marginTop: 4, color: 'var(--warn)' } }, vm.warning) : null,
                      // 可点替代：点一条就用它重开本工作项线程（验收②）
                      vm.altButtons.length ? h('div', { style: { marginTop: 8 } },
                        h('div', { className: 'atc-mini' }, '可点的替代通道（点了就用它重开）：'),
                        h('div', { className: 'atc-row', style: { marginTop: 4, flexWrap: 'wrap', gap: '8px' } },
                          vm.altButtons.map(function (a, i) {
                            return h('span', { key: a.key || i, style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
                              h('button', {
                                className: 'atc-btn',
                                disabled: !!mut.busy || !sceneId,
                                title: '用 ' + a.key + ' 重新开启本工作项线程',
                                onClick: function () { openWithRoute(a.key, a.reasoningEffort) },
                              }, (mut.busy === 'chat-open' && pickRoute === a.key) ? '开启中…' : a.key),
                              h('span', { className: 'atc-pill' }, a.multText),
                              a.fromText ? h('span', { className: 'atc-mini' }, a.fromText) : null,
                              h('button', {
                                className: 'atc-btn',
                                title: '复制 ' + a.key,
                                onClick: function () { copyRoute(a.key) },
                              }, copiedKey === a.key ? '已复制' : '复制'),
                            )
                          })),
                      ) : null,
                      // 没替代时明确说下一步（指到能改的地方，不甩锅）
                      vm.nextStep ? h('div', {
                        className: 'atc-mini', style: { marginTop: 8, color: 'var(--warn)' },
                      }, vm.nextStep) : null,
                      // 兜底：被点通道字符串本身也给一份可复制的（验收②「至少可复制」）
                      (vm.blocked && vm.blocked.key) ? h('div', { className: 'atc-row', style: { marginTop: 8, gap: '8px' } },
                        h('span', { className: 'atc-mono', style: { flex: 1 } }, vm.blocked.key),
                        h('button', { className: 'atc-btn', onClick: function () { copyRoute(vm.blocked.key) } },
                          copiedKey === vm.blocked.key ? '已复制' : '复制被禁通道名'),
                      ) : null,
                      vm.tried.length ? h('details', { style: { marginTop: 8 } },
                        h('summary', { className: 'atc-mini', style: { cursor: 'pointer' } },
                          '判定过程（' + vm.tried.length + ' 条）'),
                        h('ul', { className: 'atc-list' }, vm.tried.map(function (x, i) {
                          return h('li', { key: i, className: 'atc-mini atc-mono' }, String(x))
                        })),
                      ) : null,
                    )
                  })(),
                  h('div', { className: 'atc-row', style: { marginBottom: 8 } },
                    h('button', { className: 'atc-btn', onClick: loadHistory }, '载入历史对话'),
                    readMeta ? h('span', { className: 'atc-mini' },
                      '已读 ' + ((readMeta.messages || []).length) + ' / ' + (readMeta.total || 0) + ' 条'
                      + (readMeta.cached ? '（命中缓存）' : '')) : null,
                  ),
                  thread ? h('div', { className: 'atc-mini', style: { marginBottom: 8 } },
                    (thread.restored ? '已恢复历史线程：' : '线程已开：') + thread.sessionId
                    + ' · ' + (thread.turns || 0) + ' 轮'
                    // 当前这条线程用的是哪档来源（验收③）。重启恢复的老线程没这信息，
                    // 就明说「未知（历史恢复）」，不拿 null 冒充「未选定通道」。
                    + ' · 通道来源：' + (function () {
                      var src = (openInfo && openInfo.ok) ? openInfo.routeSource : null
                      if (src) return sourceLabel(src)
                      return thread.restored ? '未知（历史恢复）' : sourceLabel(null)
                    })()
                  ) : null,
                  readErr ? h('div', { className: 'atc-mini', style: { marginBottom: 8, color: 'var(--danger)' } },
                    '读取转录：' + readErr) : null,
                ),
        ),

        usable ? h('div', {
          style: {
            flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 16px',
            display: 'flex', flexDirection: 'column', gap: '8px',
          },
        },
          bubbles.length === 0
            ? h('div', { className: 'atc-empty' }, '还没有消息。输入工作项 id 开启线程后就能聊。')
            : bubbles.map(function (m, i) {
              var mine = m.role === 'user'
              return h('div', {
                key: i,
                style: {
                  alignSelf: mine ? 'flex-end' : 'flex-start',
                  maxWidth: '86%',
                  padding: '8px 11px',
                  borderRadius: 8,
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: mine
                    ? 'color-mix(in srgb,var(--ok) 22%,transparent)'
                    : m.ok === false
                      ? 'color-mix(in srgb,var(--danger) 16%,transparent)'
                      : 'color-mix(in srgb,currentColor 7%,transparent)',
                  border: '1px solid ' + (mine
                    ? 'color-mix(in srgb,var(--ok) 45%,transparent)'
                    : m.ok === false
                      ? 'color-mix(in srgb,var(--danger) 45%,transparent)'
                      : 'color-mix(in srgb,currentColor 14%,transparent)'),
                },
              }, m.text)
            }),
        ) : null,

        usable ? h('div', { style: { flex: 'none', padding: '10px 16px', borderTop: '1px solid color-mix(in srgb,currentColor 12%,transparent)' } },
          h('div', { className: 'atc-row' },
            h('input', {
              className: 'atc-input',
              placeholder: '跟这支团队说什么…（Enter 发送）',
              value: input,
              onChange: function (e) { setInput(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt() } },
            }),
            h('button', {
              className: 'atc-btn on',
              disabled: !!mut.busy || !input.trim(),
              onClick: sendIt,
            }, mut.busy === 'chat-send' ? '发送中…' : '发送'),
          ),
        ) : null,
      )
    }

    /* ── 模型配置（倍率门槛 / provider 优先级 / 指挥模型） ────────
     * 用户口径（2026-11-21）：**别烧 WorkBuddy 积分、要养号**，不是「一分钱不花」。
     * 所以这一页要说清三件事：
     * 1. 每条候选现在多少钱（倍率 x0.00 / x0.11 …）；
     * 2. 被哪一级门槛挡住（provider 级 cap / 全局上限 / 倍率未知 / 手动拉黑）；
     * 3. 想放开时改哪个数字（provider 级 cap 优先于全局 maxMultiplier）。
     * 只读用 op=routes，改配置用 op=route-config / op=provider-toggle。
     */
    /* ── 模型页（普通用户视角）──────────────────────────────────────
     * 信息架构（2026-11-21 重构）：顶部一句话摘要 → 可用通道一行一条 →
     * 已停用折叠（点开看原因，原因只在此处出现一次）→ 高级设置折叠。
     * 开发者术语不在界面出现；所有真实数据都保留在展开区，不删不藏。
     * 静态断言依赖的字符串（停用整条通道/启用整条通道/免费池（实测可用）仍在折叠区。
     */
    /** 价格白话：免费 / x0.11 / 价格未标注（不含开发者术语） */
    function priceTextOf(r) {
      var m = r && r.multiplier
      if (m == null) return '价格未标注'
      if (m === 0) return '免费'
      return 'x' + m
    }
    /** 用途一句话（纯中文白话，按档位/稳定性/视觉专精生成） */
    function purposeOf(r) {
      if (!r) return ''
      var key = r.key || ((r.provider || '') + '/' + (r.model || ''))
      if (/^modlens-|-modlens\//i.test(key)) return '看图与界面判断'
      if (r.tier === 'paid') return '主力干活'
      if (r.tier === 'free') return r.stability === 'flakey' ? '免费·时快时慢，补位用' : '免费·日常首选'
      if (r.tier === 'backup') return '省钱，快速小活'
      if (r.tier === 'last') return '视觉兜底'
      return '备用通道'
    }
    /** 停用/不可用原因清洗：去掉括号里写给排查看的英文键，只留中文白话 */
    function cleanReasonOf(s) {
      return String(s == null ? '' : s).replace(/（[^）]*[a-z][^）]*）/gi, '').trim()
    }
    /** 原因文案（只在一处显示：已停用折叠区里每条一行） */
    function reasonOf(r) {
      if (!r) return '暂时不可用'
      return cleanReasonOf(r.disabledReason || r.gateReason || r.reason) || '暂时不可用'
    }
    /** 通道显示名：优先后端给的人读名，回落通道标识 */
    function channelNameOf(r, lanes) {
      if (!r) return ''
      var pv = r.provider || ''
      if (lanes && lanes[pv] && lanes[pv].name) return lanes[pv].name
      return pv
    }
    /** 配置来源白话文案：只说状态，不渲染后端绝对路径 */
    function configSourceTextOf(cs) {
      if (!cs) return ''
      var src = String(cs.source || '')
      if (src === 'file') return '配置来源：本地配置文件（已生效）'
      if (src === 'default') return '配置来源：默认配置（未找到本地文件）'
      if (src === 'injected') return '配置来源：本次传入的配置（已生效）'
      return '配置来源：本地配置（已生效）'
    }

    function TabModels(p) {
      var mut = useMutate()
      var st = useState(null); var data = st[0], setData = st[1]
      var er = useState(null); var err = er[0], setErr = er[1]
      var ld = useState(true); var loading = ld[0], setLoading = ld[1]
      var mmIn = useState(''); var maxMult = mmIn[0], setMaxMult = mmIn[1]
      var capIn = useState({}); var capEdits = capIn[0], setCapEdits = capIn[1]

      var load = useCallback(function () {
        return fetch('/ai-team/api?op=routes', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) { setData(d); setErr(null); setLoading(false); return d })
          .catch(function (x) { setErr(String(x && x.message ? x.message : x)); setLoading(false) })
      }, [])

      useEffect(function () { load() }, [load])

      function after(res) { if (res && res.ok) load() }
      function toggleProvider(provider, enabled) {
        mut.send('provider-toggle', { provider: provider, enabled: enabled }).then(after)
      }
      function setCap(provider) {
        var v = Number(capEdits[provider])
        if (!isFinite(v) || v < 0) return
        mut.send('provider-toggle', { provider: provider, cap: v }).then(after)
      }
      function setGlobalCap() {
        var v = Number(maxMult)
        if (!isFinite(v) || v < 0) return
        mut.send('provider-toggle', { maxMultiplier: v }).then(after)
      }
      function saveLead(cands) {
        mut.send('route-config', {
          config: { leadRoute: { provider: cands.provider, model: cands.model, reasoningEffort: cands.reasoningEffort || null } },
        }).then(after)
      }

      if (loading && !data) return h('div', { className: 'atc-empty' }, '读模型配置…')
      if (err && !data) return h('div', { className: 'atc-empty' }, h('div', { className: 'atc-no' }, '读不到模型配置'), h('div', { className: 'atc-mini' }, err))

      var cfg = (data && data.config) || {}
      var caps = cfg.providerMultiplierCap || {}
      var cands = (data && data.candidates) || []
      var pools = (data && data.freePool) || []
      var lanes = (data && data.lanes) || {}
      var okRows = cands.filter(function (r) { return r && r.allowed })
      var offRows = cands.filter(function (r) { return r && !r.allowed })
      // 最便宜的可用通道：倍率升序，未标注价格排最后
      var cheapest = okRows.slice().sort(function (a, b) {
        var ma = a.multiplier == null ? Infinity : a.multiplier
        var mb = b.multiplier == null ? Infinity : b.multiplier
        return ma - mb
      })[0] || null
      var lead = cfg.leadRoute || {}
      var leadText = lead.provider && lead.model ? (lead.provider + '/' + lead.model) : '未设置'
      var laneN = data && data.laneCount ? data.laneCount : (Object.keys(lanes).length || 14)

      // 按通道聚合（只在高级设置里用于设上限/开关）
      var byProvider = {}
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i]
        var pv = c.provider || '?'
        if (!byProvider[pv]) byProvider[pv] = { provider: pv, rows: [], allowed: 0, blocked: 0, hasCap: Object.prototype.hasOwnProperty.call(caps, pv), cap: caps[pv] }
        byProvider[pv].rows.push(c)
        if (c.allowed) byProvider[pv].allowed += 1
        else byProvider[pv].blocked += 1
      }
      var provList = Object.keys(byProvider).sort(function (a, b) { return (byProvider[a].rows[0].providerRank || 99) - (byProvider[b].rows[0].providerRank || 99) })
      // 高级设置按启用状态分组：用户手动停用（disabledProviders）的收进折叠区，其余正常列出
      function isProvDisabled(pk) {
        return (cfg.disabledProviders || []).map(function (x) { return String(x).toLowerCase() }).indexOf(pk.toLowerCase()) >= 0
      }
      var enabledProvs = provList.filter(function (pk) { return !isProvDisabled(pk) })
      var disabledProvs = provList.filter(isProvDisabled)

      return h('div', null,
        // ④ 顶部一句话摘要：现在能用几条、最便宜的是谁、当前指挥模型
        h('div', { className: 'atc-card' },
          h('div', { className: 'atc-name' },
            '现在能用 ' + okRows.length + ' 条通道，最便宜的是 '
            + (cheapest ? (channelNameOf(cheapest, lanes) + '/' + cheapest.model) : '暂无可用')
            + '（' + (cheapest ? priceTextOf(cheapest) : '—') + '）'),
          h('div', { className: 'atc-mini', style: { marginTop: 4 } }, '当前指挥模型：' + leadText),
        ),

        // ⑤ 主列表：只列可用通道，一行一条；免费池合并进来（价格列写「免费」）
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '可用通道（共 ' + okRows.length + ' 条）'),
          h('div', { className: 'atc-card' },
            okRows.length ? okRows.map(function (r) {
              return h('div', { key: r.key, className: 'atc-row', style: { fontSize: 12, gap: '8px' } },
                h('span', { className: 'atc-name' }, channelNameOf(r, lanes)),
                h('span', { className: 'atc-mono', style: { flex: 1 } }, r.model),
                h('span', { className: 'atc-pill ' + (r.multiplier === 0 ? 'run' : '') }, priceTextOf(r)),
                h('span', { className: 'atc-mini' }, purposeOf(r)),
              )
            }) : h('div', { className: 'atc-empty' }, '当前没有可用通道，展开下方「已停用」看原因。'),
          ),
        ),

        // ③ 已停用的通道默认折叠，原因只在此处每条显示一次
        h('div', { className: 'atc-sec' },
          h('details', null,
            h('summary', { className: 'atc-mini', style: { cursor: 'pointer' } },
              '已停用 ' + offRows.length + ' 条 ▸ 点开看原因'),
            h('div', { className: 'atc-card', style: { marginTop: 8 } },
              offRows.length ? offRows.map(function (r) {
                return h('div', { key: r.key, className: 'atc-row', style: { fontSize: 12 } },
                  h('span', { className: 'atc-mono' }, r.key),
                  h('span', { className: 'atc-mini' }, reasonOf(r)),
                )
              }) : h('div', { className: 'atc-mini' }, '没有停用的通道。'),
            ),
          ),
        ),

        // ⑦ 高级设置折叠：价格上限与通道开关、层级说明都收进来，不占主视野
        h('div', { className: 'atc-sec' },
          h('details', null,
            h('summary', { className: 'atc-mini', style: { cursor: 'pointer' } }, '高级设置 ▸ 价格上限与通道开关'),
            h('div', { style: { marginTop: 8 } },
              // 层级说明：白话讲清"同一插件、不同上游"，保留"不是N家独立"的纠错价值
              h('div', { className: 'atc-card' },
                h('div', { className: 'atc-mini' },
                  '这些通道都来自同一个模型插件，背后接不同的上游服务，不是 ' + laneN + ' 家独立厂商。'),
              ),
              // 全局上限
              h('div', { className: 'atc-card', style: { marginTop: 8 } },
                h('div', { className: 'atc-row' },
                  h('span', { className: 'atc-name' }, '全局价格上限'),
                  h('span', { className: 'atc-pill' }, 'x' + (cfg.maxMultiplier === undefined ? '—' : cfg.maxMultiplier)),
                  h('span', { className: 'atc-spacer' }),
                  h('input', {
                    className: 'atc-input', placeholder: '如 0.6', value: maxMult,
                    style: { maxWidth: 100 },
                    onChange: function (e) { setMaxMult(e.target.value) },
                  }),
                  h('button', {
                    className: 'atc-btn', disabled: !!mut.busy || !String(maxMult).trim(),
                    onClick: setGlobalCap,
                  }, '改全局上限'),
                ),
                h('div', { className: 'atc-mini', style: { marginTop: 4 } },
                  '每条通道自己的价格线优先于全局；价格未标注的通道不会自动选用，你手动点名时仍可用。'),
                h('div', { className: 'atc-mini' },
                  configSourceTextOf(data && data.configSource)),
              ),
              // 按通道的价格上限与开关：启用中逐卡列出；已停用折叠，展开后仍是完整通道卡
              (function () {
                // 单张通道卡：通道行精简（紧凑设上限控件 + 启停行尾 + 关键标签）+ 模型行紧凑
                function renderProvCard(pk) {
                  var g = byProvider[pk]
                  var disabled = isProvDisabled(pk)
                  return h('div', { key: pk, className: 'atc-card', style: { marginTop: 8 } },
                    h('div', { className: 'atc-row' },
                      h('span', { className: 'atc-name' }, channelNameOf(g.rows[0], lanes)),
                      h('span', { className: 'atc-pill ' + (g.allowed ? 'run' : 'bad') }, '可用 ' + g.allowed),
                      g.hasCap ? h('span', { className: 'atc-pill warn' }, '上限 x' + g.cap) : null,
                      disabled ? h('span', { className: 'atc-pill bad' }, '这条通道已停用') : null,
                      h('span', { className: 'atc-spacer' }),
                      h('input', {
                        className: 'atc-input', placeholder: g.hasCap ? String(g.cap) : '上限',
                        value: capEdits[pk] === undefined ? '' : capEdits[pk],
                        style: { maxWidth: 64, padding: '4px 8px' },
                        onChange: function (e) {
                          var nx = {}; nx[pk] = e.target.value; setCapEdits(Object.assign({}, capEdits, nx))
                        },
                      }),
                      h('button', { className: 'atc-btn', style: { padding: '4px 8px' }, disabled: !!mut.busy, onClick: function () { setCap(pk) } }, '设上限'),
                      h('button', {
                        className: 'atc-btn' + (disabled ? '' : ' danger'), style: { padding: '4px 8px' },
                        disabled: !!mut.busy,
                        onClick: function () { toggleProvider(pk, disabled) },
                      }, disabled ? '启用整条通道' : '停用整条通道'),
                    ),
                    // 模型行紧凑：降行高/padding，价格与用途用 mini 小字，模型名等宽占主位；含停用不删数据
                    h('div', { style: { marginTop: 4 } }, g.rows.map(function (r) {
                      return h('div', { key: r.key, className: 'atc-row', style: { fontSize: 11, gap: '8px', padding: '2px 0' } },
                        h('span', { className: r.allowed ? 'atc-ok' : 'atc-no' }, r.allowed ? atcIcon('ok') : atcIcon('bad')),
                        h('span', { className: 'atc-mono', style: { flex: 1 } }, r.model),
                        h('span', { className: 'atc-mini' }, priceTextOf(r)),
                        h('span', { className: 'atc-mini' }, purposeOf(r)),
                      )
                    })),
                  )
                }
                return [
                  enabledProvs.map(renderProvCard),
                  disabledProvs.length ? h('details', { style: { marginTop: 8 } },
                    h('summary', { className: 'atc-mini', style: { cursor: 'pointer' } },
                      '已停用 ' + disabledProvs.length + ' 条通道 ▸ 点开展开'),
                    h('div', { style: { marginTop: 8 } }, disabledProvs.map(renderProvCard)),
                  ) : null,
                ]
              })(),
              // 指挥模型推荐值（保留全部信息）
              h('div', { className: 'atc-card', style: { marginTop: 8 } },
                h('div', { className: 'atc-sec-h' }, '指挥模型推荐'),
                h('div', { className: 'atc-row' },
                  h('span', { className: 'atc-name atc-mono' }, leadText),
                  h('span', { className: 'atc-pill' }, '思考强度：' + (lead.reasoningEffort || '—')),
                ),
                h('div', { className: 'atc-mini', style: { marginTop: 4 } },
                  '这是推荐值，改它不会立刻换掉正在跑的会话。'),
              ),
            ),
          ),
        ),

        // 写操作回执（保留）
        (mut.result && mut.result.data) ? h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '上次操作'),
          h('div', { className: 'atc-card' },
            h('div', { className: 'atc-row' },
              h('span', { className: mut.result.data.ok ? 'atc-ok' : 'atc-no' }, mut.result.data.ok ? atcIcon('ok') : atcIcon('bad')),
              h('span', { className: 'atc-name' }, mut.result.data.changed || mut.result.op),
            ),
            h('div', { className: 'atc-mini atc-mono' }, mut.result.data.file || ''),
            h('div', { className: 'atc-dim' }, mut.result.data.note || mut.result.data.error || ''),
          ),
        ) : null,
      )
    }

    /* ── ：中文标签表 ─────────────────────
     * 与 routes.mjs 里的 BLOCK_LABEL 同义，但这一份是「给人看的主文案」：
     * 中文打头，英文键名放括号里留给排查（验收④）。
     * 改任一条都要同步 scripts\verify-tabs-cn.mjs 的断言。
     */
    var TIER_LABEL_CN = {
      free: '免费（free）',
      paid: '付费（paid）',
      backup: '备选（backup）',
      last: '兜底（last）',
    }
    var BLOCKED_LABEL_CN = {
      'provider-disabled': '通道已停用（provider-disabled）',
      'provider-cap': '通道花费上限（provider-cap）',
      'route-disabled': '通道已禁用（route-disabled）',
      'global-cap': '全局花费上限（global-cap）',
      'explicit-blocked': '指定通道已禁用（explicit-blocked）',
      'no-route': '无可用通道（no-route）',
      'multiplier-unknown': '花费倍率未知（multiplier-unknown）',
      'bad-route': '缺少通道名或模型名（bad-route）',
      'config-chain': '按配置链选择（config-chain）',
      'host-default': '宿主快照回落（host-default）',
      'stale-lineage': '会话已失效（stale-lineage）',
      'unbound': '未绑定会话（unbound）',
    }

    /** 表值已含「（英文键）」就不再补括号；未知键才现补，避免「免费（free）（free）」 */
    function withKey(label, k) {
      return label.indexOf('（') >= 0 ? label : label + '（' + k + '）'
    }
    /** 档位 → 「免费（free）」：主文案中文，键名留给排查 */
    function tierLabelCn(tier) {
      var k = String(tier == null ? '' : tier)
      if (!k) return '未分档'
      return withKey(TIER_LABEL_CN[k] || k, k)
    }

    /** 被挡原因 → 「通道已停用（provider-disabled）」；未知键原样带出不编造 */
    function blockedLabelCn(blockedBy) {
      var k = String(blockedBy == null ? '' : blockedBy)
      if (!k) return '不可用'
      return withKey(BLOCKED_LABEL_CN[k] || k, k)
    }

    /** 三步上手：内容写在这里，跳转目标都是真实存在的页签 id */
    var ONBOARD_STEPS = [
      {
        no: 1,
        title: '选一个项目文件夹',
        desc: '面板只认你选的目录，不写死任何项目。探测到项目类型后可以「存为工作项」，之后随时复用。',
        tab: 'start', anchor: 'atc-step-pick', cta: '就在本页选文件夹',
      },
      {
        no: 2,
        title: '检查成员与能力域',
        desc: '看团队里架构 / 执行 / 复核这三种角色配齐没有；缺人会给出可直接粘贴的招募配置。',
        tab: 'members', anchor: null, cta: '去看成员',
      },
      {
        no: 3,
        title: '派发任务并盯进度',
        desc: '在工作项上跑流水线，任务与消息都在「任务」页；模型在哪一档、被什么挡住看「模型」页。',
        tab: 'tasks', anchor: null, cta: '去派任务',
      },
    ]

    /* 页签 1「开始」= 选文件夹 + 总览合并（验收①），首屏带一句话与三步上手（②③） */
    function TabStart(p) {
      function goStep(st) {
        if (typeof p.setTab === 'function') p.setTab(st.tab)
        if (!st.anchor) return
        // 切页签后 DOM 才存在，等一帧再滚；滚不动也不算错（页签已经切对了）
        setTimeout(function () {
          try {
            var el = document.getElementById(st.anchor)
            if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' })
          } catch (e) { /* 忽略：跳转本身已完成 */ }
        }, 60)
      }
      var snap = p.snap || {}
      var team = snap.team || {}
      var checks = snap.checks || {}
      var ready = (team.counts && team.counts.total > 0) || (team.tasks && team.tasks.length > 0)
      return h('div', null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-card', style: {
            borderColor: 'color-mix(in srgb,var(--ok) 40%,transparent)',
            background: 'color-mix(in srgb,var(--ok) 7%,transparent)',
          } },
            h('div', { className: 'atc-name', style: { fontSize: 13 } },
              '把一件事交给一支 AI 小团队：你选个文件夹，它负责开团、派活、盯进度、验收。'),
            h('div', { className: 'atc-mini', style: { marginTop: 4 } },
              ready
                ? ('当前工作项「' + (snap.scenario || '—') + '」· 验收自检 '
                  + (checks.passed === undefined ? '—' : checks.passed + '/' + checks.total)
                  + ' · 成员 ' + ((team.members || []).length) + ' 人')
                : '还没开过团。按下面三步走一遍就能跑起来。'),
            h('div', { className: 'atc-row', style: { marginTop: 8 } },
              h('button', {
                className: 'atc-btn on',
                title: '跳到本页的「选文件夹」区块',
                onClick: function () { goStep(ONBOARD_STEPS[0]) },
              }, '选个文件夹开始'),
              h('span', { className: 'atc-mini' }, '不用先建团队，选完目录就能开团。'),
            ),
          ),
        ),
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '三步上手'),
          h('div', { className: 'atc-grid' }, ONBOARD_STEPS.map(function (st) {
            return h('div', { key: st.no, className: 'atc-card' },
              h('div', { className: 'atc-row' },
                h('span', { className: 'atc-pill run' }, '第 ' + st.no + ' 步'),
                h('span', { className: 'atc-name' }, st.title),
              ),
              h('div', { className: 'atc-dim', style: { marginTop: 4 } }, st.desc),
              h('div', { className: 'atc-row', style: { marginTop: 8 } },
                h('button', {
                  className: 'atc-btn', onClick: function () { goStep(st) },
                }, st.cta),
              ),
            )
          })),
        ),
        // 原「选文件夹」与「总览」的内容原样并进来（组件按函数调用，钩子顺序固定）
        h('div', { id: 'atc-step-pick' }, TabWorkspace(p)),
        TabOverview(p),
      )
    }

    /* 页签 3「任务」= 工作项编排 + 任务消息（验收①） */
    function TabTasks(p) {
      return h('div', null, TabScenario(p), TabLog(p))
    }

    /* 页签 5「更多」= 对话 + 手册 + 预设（验收①） */
    function TabMore(p) {
      return h('div', null, TabChat(p), TabHandbook(p), TabPreset(p))
    }

    /* ── 技能页：op=skills / skill-approve ── */
    function TabSkills(p) {
      var mut = useMutate()
      var ss = useState(null); var skills = ss[0], setSkills = ss[1]
      var er = useState(null); var loadErr = er[0], setLoadErr = er[1]
      // 蒸馏门槛：op=evolve-config GET/POST，默认 3（读不到时回落）
      var cr = useState(null); var cfg = cr[0], setCfg = cr[1]
      var ci = useState(''); var cfgEdit = ci[0], setCfgEdit = ci[1]
      var cn = useState(''); var cfgNote = cn[0], setCfgNote = cn[1]
      var ce = useState(''); var cfgErr = ce[0], setCfgErr = ce[1]
      // 工作项进度（空状态里告诉用户去哪蒸馏、还差几轮）
      var sc = useState(null); var scenes = sc[0], setScenes = sc[1]
      function load() {
        // 三个 op 并行拉。fetch 返回的是 Response，必须 .json() 才拿到数据；
        // 任一失败都降级成可判别的对象，不让整个 Promise.all 挂掉。
        function jget(url, fallback) {
          return fetch(url, { headers: { accept: 'application/json' } })
            .then(function (r) { return r.json() })
            .catch(function (x) { return fallback(String(x && x.message ? x.message : x)) })
        }
        Promise.all([
          jget('/ai-team/api?op=skills', function (e) { return { ok: false, error: e, active: [], pending: [] } }),
          jget('/ai-team/api?op=evolve-config', function () { return null }),
          jget('/ai-team/api?op=scenarios', function () { return null }),
        ]).then(function (arr) {
          setSkills(arr[0]); setCfg(arr[1]); setScenes(arr[2])
          setCfgEdit(arr[1] && arr[1].distillMinRounds ? String(arr[1].distillMinRounds) : '3')
          setLoadErr(arr[0] && arr[0].ok === false ? String(arr[0].error || '读技能库失败') : null)
        })
      }
      useEffect(function () { load() }, [])
      var minRounds = (cfg && Number(cfg.distillMinRounds)) || 3
      var cfgValid = /^\d+$/.test(String(cfgEdit).trim()) && Number(cfgEdit) >= 1 && Number(cfgEdit) <= 10
      function saveCfg() {
        if (!cfgValid) { setCfgErr('门槛须是 1-10 的整数'); return }
        mut.send('evolve-config', { distillMinRounds: Number(cfgEdit) }).then(function (d) {
          if (d && d.ok) { setCfgErr(''); setCfgNote('已改为 ' + d.distillMinRounds + ' 轮'); load() }
          else setCfgErr(String((d && d.error) || '保存门槛失败'))
        })
      }
      var approveResult = mut.result && mut.result.op === 'skill-approve' ? mut.result.data : null
      // 从文件名解析来源工作项：{scenarioId}-onboarding.md
      function sidOf(item) {
        var f = String((item && item.file) || (item && item.path) || '')
        var base = f.split(/[\\/]/).pop() || ''
        return base.replace(/-onboarding\.md$/i, '')
      }
      function approve(item) {
        mut.send('skill-approve', { scenarioId: sidOf(item) }).then(function (d) { if (d && d.ok) load() })
      }
      // 三段式结构化摘要卡（task_mwr524wm1ijwb）：管什么 / 内容概览 / 最容易错的。
      // summary 缺失（老数据）时退化为原文预览，不崩；「最容易错的」优先展示。
      // 技能卡片（方案 B：分层）。
      // 卡面只放「人能用来决策」的信息；技术原文全部下沉到折叠层。
      // humanItems 为 null 的条目退化显示原文并标注——宁可不翻译，不许编造。
      function renderSkillCard(it, kind) {
        var sm = it && it.summary
        var secs = (sm && sm.sections) || []
        var danger = null
        var others = []
        for (var _i = 0; _i < secs.length; _i++) {
          if (String(secs[_i].title || '').indexOf('最容易错') >= 0) {
            if (!danger) danger = secs[_i]
          } else if (secs[_i].title !== '这个 skill 管什么' && secs[_i].title !== '启用方式') {
            others.push(secs[_i])
          }
        }
        var full = it.fullPreview || it.preview || (typeof it.content === 'string' ? it.content : '') || ''
        var truncated = it.fullPreviewTruncated === true
        // 场景中文名：从 TabSkills 自己的 scenes state 里按 summary.scene.id 找。
        // 注意用局部变量 scenes（L2388 useState），不是 p.scenes——p 是 props，没有它。
        var sceneName = ''
        var sceneId = (sm && sm.scene && sm.scene.id) || ''
        var sceneList = (scenes && scenes.scenarios) || []
        for (var _k = 0; _k < sceneList.length; _k++) {
          if (String(sceneList[_k].id) === String(sceneId)) { sceneName = String(sceneList[_k].name || ''); break }
        }
        var title = sceneName || String(it.file || it.path || '').replace(/-onboarding\.md$/i, '')
        var TIER_LABEL = { rule: '做法', risk: '要小心', contract: '对接口', process: '流程' }

        // 一条踩坑：有 humanItems 用两行制，否则显示原文并标注是工程记录
        function pitfallRow(x, idx) {
          if (x && typeof x === 'object' && x.do) {
            return h('div', { key: 'pf' + idx, style: { marginTop: 8, paddingLeft: 10, borderLeft: '2px solid var(--warn)' } },
              h('div', { className: 'atc-mini', style: { color: 'var(--text)', fontWeight: 600 } }, x.do),
              x.why ? h('div', { className: 'atc-mini', style: { color: 'var(--dim)', marginTop: 2 } }, x.why) : null,
              h('span', { className: 'atc-pill', style: { marginTop: 4, fontSize: 10 } },
                (TIER_LABEL[x.tier] || '经验') + (x.derived ? ' · 系统归纳' : '')),
            )
          }
          return h('div', { key: 'pf' + idx, className: 'atc-mini', style: { marginTop: 6 } },
            '· ' + String(x),
            h('span', { className: 'atc-pill', style: { marginLeft: 6, fontSize: 10 } }, '工程记录'),
          )
        }

        var dangerHuman = (danger && danger.humanItems) || null
        var dangerList = dangerHuman || (danger && danger.items) || []

        return h('div', { key: it.file || it.path, className: 'atc-card' },
          // ── 标题行：中文场景名 + 状态 + 批准 ──
          h('div', { className: 'atc-row' },
            h('span', { className: 'atc-name' }, title),
            h('span', { className: 'atc-pill ' + (kind === 'active' ? 'run' : 'warn') },
              kind === 'active' ? '已启用' : '待批准'),
            h('span', { className: 'atc-spacer' }),
            sm && sm.handoffRounds ? h('span', { className: 'atc-mini' }, '归纳自 ' + sm.handoffRounds + ' 轮交接') : null,
            sm && sm.generatedAt ? h('span', { className: 'atc-mini' }, sm.generatedAt) : null,
            kind === 'pending' ? h('button', {
              className: 'atc-btn', style: { borderColor: 'var(--accent)', color: 'var(--accent)' },
              disabled: !!mut.busy, onClick: function () { approve(it) },
            }, '批准') : null,
          ),

          sm ? h('div', null,
            // ── 这个技能管什么（purposeHuman 是人话版；退化用 purpose） ──
            h('div', { className: 'atc-mini', style: { marginTop: 6, color: 'var(--dim)' } },
              sm.purposeHuman || sm.purpose || '（未写明用途）'),
            // ── 后果说明：批之前必须知道的两件事（consequence 是数组，逐行渲染） ──
            sm.consequence ? [].concat(sm.consequence).filter(Boolean).map(function (c, ci) {
              return h('div', { key: 'cons' + ci, className: 'atc-mini', style: { marginTop: 4, color: 'var(--dim)' } }, c)
            }) : null,

            // ── 内容概览：只给计数，不给内容 ──
            others.length ? h('div', { className: 'atc-row', style: { marginTop: 8, flexWrap: 'wrap', gap: 8 } },
              others.map(function (s) {
                return h('span', { key: s.title, className: 'atc-mini' },
                  s.title + ' ', h('span', { className: 'atc-pill', style: { fontSize: 10 } }, s.count + ' 条'))
              }),
            ) : null,

            // ── 最容易错的：两行制，优先展示 ──
            dangerList.length ? h('div', { style: { marginTop: 10 } },
              h('div', { className: 'atc-sec-h', style: { color: 'var(--warn)' } },
                '最容易错的' + (danger && danger.count > dangerList.length
                  ? '（15 条里先看 ' + dangerList.length + ' 条）' : '')),
              dangerList.map(pitfallRow),
            ) : null,
          ) : (full ? h('div', { className: 'atc-mini atc-code', style: { marginTop: 8 } }, full.slice(0, 300)) : null),

          // ── 技术原文：完整保留，折叠 ──
          full ? h('details', { style: { marginTop: 10 } },
            h('summary', { className: 'atc-mini', style: { cursor: 'pointer' } },
              '给 AI 看的技术细节' + (it.chars ? '（全文 ' + it.chars + ' 字）' : '')),
            truncated ? h('div', { className: 'atc-mini', style: { color: 'var(--warn)', marginTop: 4 } },
              '原文过大，显示的是截断版（前 ' + full.length + ' 字）') : null,
            h('div', { className: 'atc-mini atc-code', style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, full),
          ) : null,
        )
      }
      var active = (skills && skills.active) || []
      var pending = (skills && skills.pending) || []
      var sceneList = (scenes && scenes.scenarios) || []
      return h('div', null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '技能库 · 从团队交接记录归纳的操作手册'),
          h('div', { className: 'atc-mini', style: { marginBottom: 6, lineHeight: 1.6 } },
            h('div', null, '轮次（rounds）统计的是已完成的轮次，不是会话正在跑的次数。'),
            h('div', null, '工作项跑到「已完成」状态才会 +1；会话开着的这段时间不计入。')),
          // 门槛调节控件：跟随主题变量，1-10 校验，显示来源（自定义/默认）
          h('div', { className: 'atc-card' },
            h('div', { className: 'atc-row' },
              h('span', { className: 'atc-mini', style: { flex: 'none' } }, '蒸馏门槛'),
              h('input', {
                className: 'atc-input', type: 'number', min: 1, max: 10,
                value: cfgEdit, style: { maxWidth: 64 },
                onChange: function (e) { setCfgEdit(e.target.value); setCfgNote('') },
              }),
              h('span', { className: 'atc-mini' }, '轮才允许蒸馏'),
              h('button', {
                className: 'atc-btn', disabled: !!mut.busy || !cfgValid,
                style: cfgValid ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {},
                onClick: saveCfg,
              }, '保存'),
              h('span', { className: 'atc-spacer' }),
              h('span', { className: 'atc-mini' }, '当前 ' + minRounds + ' 轮 · ' + ((cfg && cfg.note && /默认/.test(cfg.note)) || !cfg ? '默认' : '自定义')),
            ),
            h('div', { className: 'atc-mini', style: { marginTop: 4 } },
              '同一工作项跑满该轮数后，可从团队交接记录归纳操作手册。'),
            cfgNote ? h('div', { className: 'atc-mini', style: { color: 'var(--ok)', marginTop: 4 } }, cfgNote) : null,
            cfgErr ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)', marginTop: 4 } }, cfgErr) : null,
          ),
          loadErr ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)' } }, loadErr) : null,
        ),
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '已启用（' + active.length + '）'),
          active.length ? active.map(function (it) { return renderSkillCard(it, 'active') }) : h('div', { className: 'atc-card' },
            h('div', { className: 'atc-name' }, '还没有启用的技能 · 按下面三步让它有内容：'),
            h('div', { className: 'atc-mini', style: { marginTop: 8 } },
              '① 到【任务】页对每个工作项点「跑流水线」，攒够轮数。'),
            // 列出每个工作项的进度与还差几轮
            sceneList.length ? h('div', { style: { marginTop: 4 } }, sceneList.map(function (s) {
              var r = s.rounds || 0
              var gap = Math.max(0, minRounds - r)
              return h('div', { key: s.id, className: 'atc-row' },
                h('span', { className: 'atc-mono' }, s.name || s.id),
                h('span', { className: 'atc-pill' }, '已跑 ' + r + ' 轮'),
                h('span', { className: 'atc-mini' }, gap ? '还差 ' + gap + ' 轮' : '可蒸馏'),
              )
            })) : h('div', { className: 'atc-mini', style: { marginTop: 4 } }, '（当前还没有工作项）'),
            h('div', { className: 'atc-mini', style: { marginTop: 8 } },
              '② 达标后，蒸馏入口在【任务】页每个工作项卡片的「蒸馏技能」按钮。'),
            h('div', { className: 'atc-mini', style: { marginTop: 4 } },
              '③ 蒸馏生成的草稿回到本页「待批准」，点「批准」后才成为已启用技能。'),
            minRounds === 1 && sceneList.some(function (s) { return (s.rounds || 0) === 0 })
              ? h('div', { className: 'atc-mini', style: { color: 'var(--warn)', marginTop: 8 } },
                  '门槛已是 1 轮，但仍有工作项 0 轮——至少跑 1 轮才能蒸馏。') : null,
            h('button', {
              className: 'atc-btn', style: { marginTop: 12, borderColor: 'var(--accent)', color: 'var(--accent)' },
              onClick: function () { if (typeof p.setTab === 'function') p.setTab('tasks') },
            }, '去任务页'),
          ),
        ),
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '待批准（' + pending.length + '）'),
          pending.length ? pending.map(function (it) { return renderSkillCard(it, 'pending') }) : h('div', { className: 'atc-empty' }, '没有待批准的草稿。'),
        ),
        approveResult && approveResult.ok === false ? h('div', { className: 'atc-card', style: { borderColor: 'var(--danger)' } },
          h('div', { className: 'atc-mini', style: { color: 'var(--danger)' } }, String(approveResult.error || '批准失败')),
        ) : null,
      )
    }

    /* ── 会话预设页：op=presets / preset-toggle / preset-order ── */
    function TabPresets(p) {
      var mut = useMutate()
      var ps = useState(null); var data = ps[0], setData = ps[1]
      var er = useState(null); var loadErr = er[0], setLoadErr = er[1]
      var oe = useState({}); var orderEdits = oe[0], setOrderEdits = oe[1]
      var note = useState(''); var changed = note[0], setChanged = note[1]
      var opErr = useState(''); var err = opErr[0], setErr = opErr[1]
      function load() {
        fetch('/ai-team/api?op=presets', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) { setData(d); setLoadErr(null) })
          .catch(function (x) { setLoadErr(String(x && x.message ? x.message : x)) })
      }
      useEffect(function () { load() }, [])
      function after(res) {
        if (res && res.ok) { setChanged('已修改，重启 DSH 后生效'); setErr(''); load() }
        else { setChanged(''); setErr(String((res && res.error) || '操作失败')) }
      }
      function toggle(it) {
        mut.send('preset-toggle', { instanceId: it.instanceId, disabled: !!it.enabled }).then(after)
      }
      function applyOrder(it) {
        var raw = String(orderEdits[it.instanceId] === undefined ? it.order : orderEdits[it.instanceId]).trim()
        var v = Number(raw)
        if (!/^\d+$/.test(raw) || v < 0 || v > 999) { setErr('排序值须是 0-999 的整数'); return }
        mut.send('preset-order', { instanceId: it.instanceId, order: v }).then(after)
      }
      var list = (data && data.presets) || []
      // 按 order 升序（服务端给 order，这里只做展示排序；改完仍走 op 重拉，不本地糊）
      var sorted = list.slice().sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0) })
      var errors = (data && data.errors) || []
      return h('div', null,
        h('div', { className: 'atc-sec' },
          h('div', { className: 'atc-sec-h' }, '会话预设 · 管理 DSH 会话栏的 agent preset'),
          changed ? h('div', { className: 'atc-mini', style: { color: 'var(--warn)', marginBottom: 8 } }, changed) : null,
          err ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)', marginBottom: 8 } }, err) : null,
          loadErr ? h('div', { className: 'atc-mini', style: { color: 'var(--danger)', marginBottom: 8 } }, loadErr) : null,
        ),
        // 空状态：presets 为空或 errors 非空，逐条列原因，不白屏
        (!sorted.length || errors.length) ? h('div', { className: 'atc-card' },
          !sorted.length ? h('div', { className: 'atc-empty' }, '没有可显示的会话预设。') : null,
          errors.length ? h('div', { className: 'atc-mini', style: { color: 'var(--warn)' } },
            h('div', null, '读取预设时遇到问题：'),
            errors.map(function (e, i) { return h('div', { key: i, className: 'atc-mono' }, '· ' + String(e)) }),
          ) : null,
        ) : null,
        sorted.map(function (it) {
          var isUser = it.source === 'profile'
          return h('div', { key: it.instanceId || it.id, className: 'atc-card' },
            h('div', { className: 'atc-row' },
              h('span', { className: 'atc-name' }, it.name || it.id),
              h('span', { className: 'atc-mono atc-mini' }, it.id || ''),
              h('span', { className: 'atc-pill' }, (it.pluginCount || 0) + ' 个插件'),
              h('span', { className: 'atc-pill ' + (isUser ? 'run' : 'idle') }, isUser ? '可管理' : '内置只读'),
              h('span', { className: 'atc-pill ' + (it.enabled ? 'run' : 'bad') }, it.enabled ? '已启用' : '已停用'),
              h('span', { className: 'atc-spacer' }),
              !isUser ? h('span', { className: 'atc-mini', style: { color: 'var(--dim)' } }, '内置预设，只读')
                : h('span', { className: 'atc-row', style: { gap: '4px' } },
                    h('input', {
                      className: 'atc-input', type: 'number', min: 0, max: 999,
                      value: orderEdits[it.instanceId] === undefined ? String(it.order == null ? '' : it.order) : orderEdits[it.instanceId],
                      style: { maxWidth: 64, padding: '4px 8px' },
                      onChange: function (e) {
                        var nx = {}; nx[it.instanceId] = e.target.value; setOrderEdits(Object.assign({}, orderEdits, nx))
                      },
                      onBlur: function () { applyOrder(it) },
                      onKeyDown: function (e) { if (e.key === 'Enter') applyOrder(it) },
                    }),
                    h('button', {
                      className: 'atc-btn', disabled: !!mut.busy,
                      style: { padding: '4px 8px' },
                      onClick: function () { toggle(it) },
                    }, it.enabled ? '停用' : '启用'),
                  ),
            ),
            it.description ? h('div', { className: 'atc-preset-desc', style: { marginTop: 6 } }, it.description) : null,
          )
        }),
      )
    }

    /* ── 面板主体（ 页签精简：9→5） ───────────────────────────
     * 原来 9 个页签是按「后端 op 的形状」切的，不是按用户任务的形状：
     * 选文件夹和总览其实是同一件事（我在哪、现在怎么样），手册/预设/对话
     * 又都是低频活。现在收成 5 个，按「先干什么」排：
     * 开始 → 成员 → 任务 → 模型 → 更多
     * 对话（TabChat）放「更多」而不是主位，理由写在这里供复核：它需要先有
     * 工作项目录（sceneId 必填，空目录点「开启线程」只会拿到错误），
     * 放主位会让新用户第一步就撞墙；它是低频补充通道，不是上手路径。
     * 旧 id 全部保留做 alias：老的 localStorage / setTab('chat') 不断。
     */
    var TABS = [
      { id: 'start', label: '开始', view: TabStart },
      // TabMembers 本身就含「成员卡 + 能力域缺口」两段（原页签「成员 / 缺口」），
      // 这里直接复用，不再包一层空壳函数。
      { id: 'members', label: '成员', view: TabMembers },
      { id: 'tasks', label: '任务', view: TabTasks },
      { id: 'models', label: '模型', view: TabModels },
      { id: 'skills', label: '技能', view: TabSkills },
      { id: 'presets', label: '会话预设', view: TabPresets },
      { id: 'more', label: '更多', view: TabMore },
    ]

    /** 旧页签 id → 新页签 id（兼容 localStorage 与视图内部的 setTab 调用） */
    var TAB_ALIAS = {
      overview: 'start', workspace: 'start', chat: 'more',
      scenario: 'tasks', log: 'tasks', handbook: 'more', preset: 'more',
    }

    /** 归一化页签 id：未知一律回落「开始」，不白屏 */
    function normalizeTab(id) {
      var want = String(id == null ? '' : id).trim()
      if (TABS.some(function (t) { return t.id === want })) return want
      if (TAB_ALIAS[want]) return TAB_ALIAS[want]
      return TABS[0].id
    }

    function Panel() {
      useCss()
      var st = useState(TABS[0].id); var tab = st[0], setTab = st[1]
      var sv = useState(true); var auto = sv[0], setAuto = sv[1]
      // 「切到此团队」：选中后快照按该团队取，成员页跟着换
      var ts = useState(null); var selTeam = ts[0], setSelTeam = ts[1]
      var d = useSnapshot(auto ? 15000 : 0, selTeam)
      var snap = d.snap, err = d.err, loading = d.loading, reload = d.reload

      // 切团队：换快照 + 停在成员页，并给用户一句反馈
      var pickTeam = useCallback(function (t) {
        if (!t || !t.teamId) return
        setSelTeam(t.teamId)
        setTab('members')
        try {
          if (typeof window !== 'undefined' && window.__atcHint) window.__atcHint('已切到「' + t.name + '」')
        } catch { /* 提示失败不影响切换 */ }
      }, [])

      // 子视图里还留着旧 id 的跳转（如 setTab('scenario')），统一在出口处归一化，
      // 这样旧调用自动落到新页签，不必逐个改、也不会点了没反应。
      var goTab = useCallback(function (id) { setTab(normalizeTab(id)) }, [])

      var cur = useMemo(function () {
        var want = normalizeTab(tab)
        for (var i = 0; i < TABS.length; i++) if (TABS[i].id === want) return TABS[i]
        return TABS[0]
      }, [tab])

      var head = h('div', { className: 'atc-head' },
        h('div', null,
          h('div', { className: 'atc-title' }, 'AI 团队控制台'),
          h('div', { className: 'atc-sub' },
            snap ? ('更新于 ' + String(snap.generatedAt || '').slice(11, 19)) : (loading ? '加载中…' : '无数据')),
        ),
        h('span', { className: 'atc-spacer' }),
        h('button', {
          type: 'button',
          className: 'atc-btn' + (auto ? ' on' : ''),
          title: auto ? '自动刷新：开（15 秒）' : '自动刷新：关',
          onClick: function () { setAuto(!auto) },
        }, auto ? '自动' : '手动'),
        h('button', {
          type: 'button', className: 'atc-btn', title: '立即刷新',
          onClick: function () { reload() },
        }, '刷新'),
      )

      if (err && !snap) {
        return h('div', { className: 'atc-root' }, head,
          h('div', { className: 'atc-body' },
            h('div', { className: 'atc-empty' },
              h('div', { className: 'atc-no' }, '取不到数据'),
              h('div', { className: 'atc-mini', style: { marginTop: 8 } }, err),
              h('div', { className: 'atc-mini', style: { marginTop: 8, opacity: 0.7 } },
                '路由 /ai-team/api 由 dsh-ai-team-console 服务端半侧提供；若刚装完请重启 DSH。'),
            ),
          ),
        )
      }
      if (!snap) {
        return h('div', { className: 'atc-root' }, head,
          h('div', { className: 'atc-body' }, h('div', { className: 'atc-empty' }, '加载中…')))
      }

      var View = cur.view
      return h('div', { className: 'atc-root' },
        head,
        h('div', { className: 'atc-tabs' }, TABS.map(function (t) {
          return h('button', {
            key: t.id, type: 'button',
            className: 'atc-tab' + (t.id === cur.id ? ' on' : ''),
            onClick: function () { goTab(t.id) },
          }, t.label)
        })),
        h('div', { className: 'atc-body' }, h(View, {
          snap: snap,
          onSnapshot: function (s) { if (s) reload() },
          setTab: goTab,
          onPickTeam: pickTeam,
          selTeam: selTeam,
        })),
      )
    }

    /* 侧栏列表里的图标：一眼认出的「团队」符号，纯 SVG，不依赖图标库 */
    function PanelIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 8, cy: 5, r: 2.2 }),
        h('path', { d: 'M3.6 13c0-2.3 2-3.9 4.4-3.9S12.4 10.7 12.4 13' }),
      )
    }

    /* ── 注册：左侧栏「全局面板」入口 + 主面板正文 ─────────────── */
    function apply(ctx) {
      useCssInject()

      // 客户端是 CJS 形态（测试用 vm 直接执行源码），不能 import 适配层。
      // 这里用同文件内的内联辅助，做同样的能力探测与降级。
      function safeSlot(name, options, component) {
        try {
          var slots = ctx && ctx.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false
          slots.inject(name, function () {
            return slots.register(Object.assign({ name: name }, options), component)
          })
          return true
        } catch (e) {
          return false
        }
      }

      var sidebarMounted = safeSlot('sidebar.panellist', {
        id: PANEL_ID,
        label: '团队控制台',
        order: 60,
      }, PanelIcon)

      safeSlot('main', { key: PANEL_ID }, Panel)

      if (!sidebarMounted) {
        console.warn('[ai-team-console] 宿主未提供 slots API，侧边栏入口未挂载')
      }
    }

    /* 样式只要注入一次，挂到 <head> （不依赖 panel 是否渲染） */
    function useCssInject() {
      try {
        var id = 'atc-style-v1'
        if (typeof document === 'undefined') return
        if (document.getElementById(id)) return
        var el = document.createElement('style')
        el.id = id
        el.textContent = CSS
        document.head.appendChild(el)
      } catch { /* ignore */ }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    // 面板反馈的纯视图模型（无 DOM、无 React），给 scripts\verify-chat-feedback.mjs
    // 真跑用。渲染层只消费这几个函数的输出，所以测它们就是测面板实际显示的内容。
    exports.__vm = {
      sourceLabel: sourceLabel,
      splitRouteKey: splitRouteKey,
      chatRouteOptions: chatRouteOptions,
      chatOpenVM: chatOpenVM,
      // 术语中文化第二批：档位与被挡原因的中文主文案表，给 verify 真跑锁措辞
      tierLabelCn: tierLabelCn,
      blockedLabelCn: blockedLabelCn,
      // 模型页重构：定价/用途/原因白话纯函数，给 verify-model-tab.mjs 真跑
      priceTextOf: priceTextOf,
      purposeOf: purposeOf,
      cleanReasonOf: cleanReasonOf,
      reasonOf: reasonOf,
      channelNameOf: channelNameOf,
      configSourceTextOf: configSourceTextOf,
    }
    return module.exports
  },
})
