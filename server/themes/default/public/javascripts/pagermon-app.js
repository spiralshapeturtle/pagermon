/* PagerMon Modern Alpine.js Application
 * Senior-level Refactoring: Modular, Reactive, and Clean.
 */

(function() {
  const cfg = window.PAGERMON_CONFIG || {};

  // ---- 1. Domain Utilities ----
  const Utils = {
    getCookie: (n) => (document.cookie.match(new RegExp('(?:^|;\\s*)'+n+'=([^;]*)'))||[])[1],
    setCookie: (n,v,d=30) => { const e=new Date(); e.setDate(e.getDate()+d); document.cookie=`${n}=${v}; expires=${e.toUTCString()}; path=/`; },
    escapeHtml: (s) => String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])),
    noLeadingZeros: (a) => { if(!a) return a; let s=String(a); while(s.length>7 && s[0]==='0') s=s.slice(1); return s; },
    isNational: (a) => { const n=parseInt(String(a).replace(/^0+/,''),10); return n>=2029568 && n<=2029583; },
    fmtDate: (ts) => { const d=new Date(ts*1000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; },
    fmtTime: (ts) => { const d=new Date(ts*1000); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; },
    relTime: (ts) => {
      const s=Math.round((Date.now()-ts*1000)/1000);
      if(s<60) return `${s}s ago`;
      const m=Math.round(s/60); if(m<60) return `${m}m ago`;
      const h=Math.round(m/60); if(h<24) return `${h}h ago`;
      return `${Math.round(h/24)}d ago`;
    }
  };

  // ---- 2. Content Processors ----
  const Processor = {
    cleanAddress(text) {
      return (text || '').trim()
        .replace(/^\s*(?:Prio\s*\d+|[A-E]\s*\d+|P\s*\d+)\s*/i, '')
        .replace(/\([^)]{0,60}\)/g, '')
        .replace(/\s*:\s*\d*(\s+\d+)*/g, '')
        .replace(/\b(?:AMBU|Ambu)\s+\d{4,6}\b/g, '')
        .replace(/\b[A-Z]{2,5}-\d{2,4}\b/g, '')
        .replace(/\b(?:Brandweer|Ambulance|Politie|Trauma|KNRM|SEH|VWS|DIA)\b/gi, '')
        .replace(/\b(?:Rit|bon|GMS|ICnum|REG):?\s*\d*\b/gi, '')
        .replace(/\b\d{4}[A-Z]{2}\b/g, '')
        .replace(/\s{2,}/g, ' ').trim();
    },

    applyHighlight(text, rules) {
      if (!rules || !rules.length || !text) return Utils.escapeHtml(text);
      let res = Utils.escapeHtml(text);
      rules.forEach(r => {
        if (!r.match) return;
        try {
          const regex = new RegExp('(?<!<[^>]*)' + r.match, 'gi');
          if (r.highlight === 'replace') res = res.replace(regex, r.replace || '$&');
          else {
            const isLink = r.highlight === 'true' || r.highlight === true;
            const tag = isLink ? 'a' : 'span';
            const attr = isLink ? ` href="/?q=$&" class="highlight-match"` : ' class="label-match"';
            const tt = r.replace ? ` x-tooltip="'${Utils.escapeHtml(r.replace)}'"` : '';
            res = res.replace(regex, `<${tag}${attr}${tt}>$&</${tag}>`);
          }
        } catch(e) {}
      });
      return res;
    }
  };

  // ---- 3. Component UI Logic ----
  // Luminance-based text color for capcode badges ("chirps"). Parses any CSS color
  // (named/hex/rgb) via a 1x1 canvas, computes perceived luminance, and picks dark
  // text on light badges / light text on dark badges so every chirp stays readable.
  let _colorCache = {};
  let _colorCacheSize = 0;
  let _colorCanvas = null;
  let _colorCtx = null;
  const UI = {
    getBadgeColor(color) {
      const isLight = document.documentElement.classList.contains('light-theme');
      const fallback = isLight ? '#1a1f2e' : '#D6EEFF';
      if (!color) return fallback;
      const key = `${color}:${isLight ? 'L' : 'D'}`;
      if (_colorCache[key]) return _colorCache[key];
      try {
        if (!_colorCtx) {
          _colorCanvas = document.createElement('canvas');
          _colorCanvas.width = _colorCanvas.height = 1;
          _colorCtx = _colorCanvas.getContext('2d', { willReadFrequently: true });
        }
        _colorCtx.fillStyle = color;
        _colorCtx.fillRect(0, 0, 1, 1);
        const d = _colorCtx.getImageData(0, 0, 1, 1).data;
        const luminance = (0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]) / 255;
        const lightText = isLight ? '#ffffff' : '#D6EEFF';
        const result = luminance > 0.55 ? '#1a1f2e' : lightText;
        if (_colorCacheSize >= 200) { _colorCache = {}; _colorCacheSize = 0; }
        _colorCache[key] = result;
        _colorCacheSize++;
        return result;
      } catch (e) {
        return fallback;
      }
    },

    initTooltip(el, text, Tooltip) {
      if (!Tooltip || !text) return null;
      el.setAttribute('data-bs-title', text);
      el.removeAttribute('title');
      return new Tooltip(el, { container: 'body', offset: [0, 8], trigger: 'hover focus' });
    }
  };

  // ---- 4. Alpine.js Bootstrapping ----
  document.addEventListener('alpine:init', () => {
    // Robust Directive
    Alpine.directive('tooltip', (el, { expression }, { evaluate, cleanup }) => {
      const T = (window.bootstrap && window.bootstrap.Tooltip) || (typeof bootstrap !== 'undefined' && bootstrap.Tooltip);
      let tt = null;
      const upd = (v) => {
        const txt = (v || '').trim();
        if (!txt) { if(tt){tt.hide(); tt.dispose(); tt=null;} return; }
        if (!tt) tt = UI.initTooltip(el, txt, T);
        else { el.setAttribute('data-bs-title', txt); tt.setContent({ '.tooltip-inner': txt }); }
      };
      if (expression) Alpine.effect(() => { try { upd(evaluate(expression)); } catch(e) {} });
      else upd(el.getAttribute('title') || el.getAttribute('data-bs-title'));
      cleanup(() => tt && tt.dispose());
    });

    Alpine.data('messageComponent', () => ({
      messages: [], pager: { limit: 20, currentPage: 1 }, loading: false,
      timeRelative: false, soundEnabled: false, notificationEnabled: 'false',
      searchOpen: false, query: '', mapsLoading: {}, copyFeedback: {},
      stats: null, statsLoading: false,
      sneakpeek: false,
      _socket: null,

      init() {
        this.timeRelative = Utils.getCookie('timeRelative') === 'on';
        this.soundEnabled = Utils.getCookie('soundEnabled') === 'on';
        this.notificationEnabled = Utils.getCookie('notificationEnabled') || 'false';
        const urlParams = new URLSearchParams(window.location.search);
        this.query = urlParams.get('q') || '';
        // Sneakpeek = "landelijk meekijken zonder login": anonymous users see all
        // messages (incl. onlyShowLoggedIn capcodes). Driven by the sneakpeek cookie
        // set by the toggle button in the menu.
        this.sneakpeek = /(?:^|;\s*)sneakpeek=on/.test(document.cookie);
        this.updateData();
        this._initSocket();

        // The sneakpeek toggle (menu.ejs) flips the cookie and fires this event.
        // Re-sync our state, move the socket to the correct room, and reload data.
        window.addEventListener('sneakpeekChange', (e) => {
          this.sneakpeek = !!(e.detail && e.detail.active);
          if (this._socket && this._socket.connected) {
            this._socket.emit('setSneakpeek', this.sneakpeek);
          }
          this.updateData();
        });

        // Listen for stats modal show
        const modalEl = document.getElementById('statsModal');
        if (modalEl) {
          modalEl.addEventListener('show.bs.modal', () => this.loadStats());
        }
      },

      updateData(page = 1) {
        this.loading = true;
        const limit = Utils.getCookie('messageLimit') || 20;
        const q = encodeURIComponent(this.query || '');
        const sneak = this.sneakpeek ? '&sneakpeek=1' : '';
        fetch(`/api/messages/?page=${page}&limit=${limit}&q=${q}${sneak}`)
          .then(r => r.json())
          .then(res => {
            this.messages = this._group(res.messages);
            this.pager = this._buildPager(res.init);
            this.loading = false;
          });
      },

      // The API returns currentPage as a 0-based index and no page list, while the
      // pagination template works with 1-based page numbers and a `pages` array.
      // Normalise here so the pager renders correctly.
      _buildPager(init) {
        init = init || {};
        const pageCount = init.pageCount || 0;
        const currentPage = pageCount
          ? Math.min((init.currentPage || 0) + 1, pageCount)
          : 1;
        return { ...init, pageCount, currentPage, pages: this._pageList(currentPage, pageCount) };
      },

      // Build a windowed list of page numbers around the current page, using null
      // entries as ellipsis markers (rendered as "…" by the template).
      _pageList(current, total) {
        if (!total || total <= 1) return total === 1 ? [1] : [];
        const delta = 2;
        const left = Math.max(1, current - delta);
        const right = Math.min(total, current + delta);
        const pages = [];
        if (left > 1) { pages.push(1); if (left > 2) pages.push(null); }
        for (let i = left; i <= right; i++) pages.push(i);
        if (right < total) { if (right < total - 1) pages.push(null); pages.push(total); }
        return pages;
      },

      toggleTimeMode() {
        this.timeRelative = !this.timeRelative;
        Utils.setCookie('timeRelative', this.timeRelative ? 'on' : 'off');
      },

      toggleSound() {
        this.soundEnabled = !this.soundEnabled;
        Utils.setCookie('soundEnabled', this.soundEnabled ? 'on' : 'off');
      },

      toggleNotifications() {
        if (this.notificationEnabled === 'true') {
          this.notificationEnabled = 'false';
          Utils.setCookie('notificationEnabled', 'false');
        } else {
          Notification.requestPermission().then(p => {
            if (p === 'granted') {
              this.notificationEnabled = 'true';
              Utils.setCookie('notificationEnabled', 'true');
            }
          });
        }
      },

      setCookie(name, value) {
        Utils.setCookie(name, value);
        this.updateData();
      },

      submitSearch(e) {
        if (e) e.preventDefault();
        this.updateData(1);
      },

      openStats() {
        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('statsModal'));
        modal.show();
      },

      async openMaps(msg, e) {
        if (e) e.preventDefault();
        this.mapsLoading[msg.id] = true;
        try {
          const clean = Processor.cleanAddress(msg.message);
          const res = await fetch(`/api/geocode?q=${encodeURIComponent(clean)}`).then(r => r.json());
          if (res && res.lat && res.lon) {
            window.open(`https://www.google.com/maps/search/?api=1&query=${res.lat},${res.lon}`, '_blank');
          } else {
            window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`, '_blank');
          }
        } catch(err) {
          window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(msg.message)}`, '_blank');
        }
        this.mapsLoading[msg.id] = false;
      },

      copyMessage(msg, e) {
        if (e) e.preventDefault();
        navigator.clipboard.writeText(msg.message).then(() => {
          this.copyFeedback[msg.id] = true;
          setTimeout(() => { this.copyFeedback[msg.id] = false; }, 2000);
        });
      },

      aliasFilterUrl(cap) {
        return `/?q=${encodeURIComponent(cap.address)}`;
      },

      get notificationSupport() {
        return 'Notification' in window;
      },

      get spinner() {
        return this.loading ? 'fa-spin' : '';
      },

      get hasQuery() {
        return !!this.query;
      },

      get filterString() {
        const p = new URLSearchParams(window.location.search);
        return p.get('address') || p.get('alias') || '';
      },

      get filter() {
        return !!this.filterString;
      },

      get origQuery() {
        return this.query;
      },

      async loadStats() {
        if (this.stats) return; // cache stats
        this.statsLoading = true;
        try {
          const r = await fetch('/api/stats').then(res => res.json());
          this.stats = r || {};
          this.$nextTick(() => this.initStatsChart());
        } catch(e) {}
        this.statsLoading = false;
      },

      statsGetBusiestDay() {
        if (!this.stats || !this.stats.daily || !this.stats.daily.length) return null;
        return this.stats.daily.reduce((max, d) => +d.count > +max.count ? d : max, this.stats.daily[0]);
      },

      statsGetAvgPerDay() {
        if (!this.stats || !this.stats.daily || !this.stats.daily.length) return 0;
        const total = this.stats.daily.reduce((s, d) => s + +d.count, 0);
        return Math.round(total / this.stats.daily.length);
      },

      statsGetWeekTrend() {
        if (!this.stats || !this.stats.daily || this.stats.daily.length < 8) return null;
        const sorted = [...this.stats.daily].sort((a, b) => (a.day < b.day ? -1 : 1));
        const last7 = sorted.slice(-7).reduce((s, d) => s + +d.count, 0);
        const prev7 = sorted.slice(-14, -7).reduce((s, d) => s + +d.count, 0);
        if (!prev7) return null;
        return Math.round((last7 - prev7) / prev7 * 100);
      },

      statsPadHour(h) { return ('0' + h).slice(-2) + ':00'; },
      statsDowName(d) { return ['Zo','Ma','Di','Wo','Do','Vr','Za'][+d] || d; },
      statsFormatDay(dateStr) {
        if (!dateStr) return '-';
        return new Date(dateStr + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      },

      statsBarWidth(count) {
        if (!this.stats || !this.stats.hourly) return 0;
        const max = Math.max(...this.stats.hourly.map(h => +h.count)) || 1;
        return Math.round(+count / max * 100);
      },

      statsDowAvg(dow, count) {
        const occ = [0,0,0,0,0,0,0];
        const today = new Date(); today.setHours(0,0,0,0);
        for (let i = 0; i < 31; i++) {
          const dt = new Date(today); dt.setDate(dt.getDate() - i);
          occ[dt.getDay()]++;
        }
        return Math.round(+count / (occ[+dow] || 1));
      },

      statsDowWidth(dow, count) {
        if (!this.stats || !this.stats.dow) return 0;
        const avg = this.statsDowAvg(dow, count);
        const max = Math.max(...this.stats.dow.map(d => this.statsDowAvg(d.dow, d.count))) || 1;
        return Math.round(avg / max * 100);
      },

      initStatsChart() {
        const canvas = document.getElementById('statsModalDailyChart');
        if (!canvas || typeof Chart === 'undefined') return;
        const daily = this.stats.daily || [];
        const counts = {};
        daily.forEach(d => { counts[d.day] = +d.count; });
        const labels = [], data = [], colors = [];
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const busiestKey = this.statsGetBusiestDay() ? this.statsGetBusiestDay().day : null;
        for (let i = 30; i >= 0; i--) {
          const dt = new Date(today); dt.setDate(dt.getDate() - i);
          const key = dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
          labels.push(i === 0 ? 'Vandaag' : dt.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }));
          data.push(counts[key] || 0);
          colors.push(key === busiestKey ? 'rgba(248,113,113,0.85)' : 'rgba(59,130,246,0.65)');
        }
        const isDark = !document.documentElement.classList.contains('light-theme');
        new Chart(canvas, {
          type: 'bar',
          data: {
            labels,
            datasets: [{ label: 'Berichten', data, backgroundColor: colors, borderRadius: 3 }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: isDark ? '#a0aec0' : '#555555', font: { size: 10 } } },
              y: { beginAtZero: true, ticks: { color: isDark ? '#a0aec0' : '#555555' } }
            }
          }
        });
      },

      _group(msgs) {
        const res = []; const map = {};
        msgs.forEach(m => {
          m.date = Utils.fmtDate(m.timestamp); m.time = Utils.fmtTime(m.timestamp);
          const key = `${m.timestamp}|${m.message}`;
          if (m.isFlexGroup && map[key]) {
            map[key].capcodes.push(m);
          } else {
            m.capcodes = [m]; map[key] = m; res.push(m);
          }
        });
        return res;
      },

      _initSocket() {
        if (this._socket) return;
        this._socket = io({ transports: ['websocket'] });
        this._socket.on('messagePost', m => {
          m.date = Utils.fmtDate(m.timestamp); m.time = Utils.fmtTime(m.timestamp);
          // Real-time grouping logic
          const existing = this.messages.find(ex => ex.timestamp === m.timestamp && ex.message === m.message);
          if (existing) {
            // Add capcode to existing group if not already there
            if (!existing.capcodes.find(c => c.id === m.id)) {
              existing.capcodes.push(m);
            }
          } else if ((this.pager.currentPage || 1) === 1) {
            // New unique message — only prepend live when viewing the first page,
            // otherwise it would corrupt pagination on page 2+ (phantom rows).
            m.capcodes = [m];
            this.messages.unshift(m);
            if (this.messages.length > this.pager.limit) this.messages.pop();
          }
        });
      },

      // API Proxies
      noLeadingZeros: Utils.noLeadingZeros,
      applyHighlight: Processor.applyHighlight,
      badgeTextColor: UI.getBadgeColor,
      relativeTime: Utils.relTime
    }));
  });
})();
