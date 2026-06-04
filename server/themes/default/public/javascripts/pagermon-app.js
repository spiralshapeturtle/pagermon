/* PagerMon Modern Alpine.js Application
 * Senior-level Refactoring: Modular, Reactive, and Clean.
 */

(function() {
  const cfg = window.PAGERMON_CONFIG || {};

  // ---- 1. Domain Utilities ----
  const Utils = {
    getCookie: (n) => (document.cookie.match(new RegExp('(?:^|;\\s*)'+n+'=([^;]*)'))||[])[1],
    setCookie: (n,v,d=30) => { const e=new Date(); e.setDate(e.getDate()+d); document.cookie=\`\${n}=\${v}; expires=\${e.toUTCString()}; path=/\`; },
    escapeHtml: (s) => String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])),
    noLeadingZeros: (a) => { if(!a) return a; let s=String(a); while(s.length>7 && s[0]==='0') s=s.slice(1); return s; },
    isNational: (a) => { const n=parseInt(String(a).replace(/^0+/,''),10); return n>=2029568 && n<=2029583; },
    fmtDate: (ts) => { const d=new Date(ts*1000); return \`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,'0')}-\${String(d.getDate()).padStart(2,'0')}\`; },
    fmtTime: (ts) => { const d=new Date(ts*1000); return \`\${String(d.getHours()).padStart(2,'0')}:\${String(d.getMinutes()).padStart(2,'0')}:\${String(d.getSeconds()).padStart(2,'0')}\`; },
    relTime: (ts) => {
      const s=Math.round((Date.now()-ts*1000)/1000);
      if(s<60) return \`\${s}s ago\`;
      const m=Math.round(s/60); if(m<60) return \`\${m}m ago\`;
      const h=Math.round(m/60); if(h<24) return \`\${h}h ago\`;
      return \`\${Math.round(h/24)}d ago\`;
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
            const attr = isLink ? \` href="/?q=$&" class="highlight-match"\` : ' class="label-match"';
            const tt = r.replace ? \` x-tooltip="'\${Utils.escapeHtml(r.replace)}'"\` : '';
            res = res.replace(regex, \`<\${tag}\${attr}\${tt}>$&</\${tag}>\`);
          }
        } catch(e) {}
      });
      return res;
    }
  };

  // ---- 3. Component UI Logic ----
  let _colorCache = {};
  const UI = {
    getBadgeColor(color) {
      const isLight = document.documentElement.classList.contains('light-theme');
      const key = \`\${color}:\${isLight?'L':'D'}\`;
      if (_colorCache[key]) return _colorCache[key];
      // simplified luminance check
      return (color === '#ffffff' || isLight) ? '#1a1f2e' : '#D6EEFF';
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
      
      init() {
        this.timeRelative = Utils.getCookie('timeRelative') === 'on';
        this.soundEnabled = Utils.getCookie('soundEnabled') === 'on';
        this.updateData();
        this._initSocket();
      },

      updateData(page = 1) {
        this.loading = true;
        const limit = Utils.getCookie('messageLimit') || 20;
        fetch(\`/api/messages/?page=\${page}&limit=\${limit}\`)
          .then(r => r.json())
          .then(res => {
            this.messages = this._group(res.messages);
            this.pager = res.init;
            this.loading = false;
          });
      },

      _group(msgs) {
        const res = []; const map = {};
        msgs.forEach(m => {
          m.date = Utils.fmtDate(m.timestamp); m.time = Utils.fmtTime(m.timestamp);
          const key = \`\${m.timestamp}|\${m.message}\`;
          if (m.isFlexGroup && map[key]) {
            map[key].capcodes.push(m);
          } else {
            m.capcodes = [m]; map[key] = m; res.push(m);
          }
        });
        return res;
      },

      _initSocket() {
        const s = io({ transports: ['websocket'] });
        s.on('messagePost', m => {
          m.date = Utils.fmtDate(m.timestamp); m.time = Utils.fmtTime(m.timestamp);
          // Real-time grouping logic
          const existing = this.messages.find(ex => ex.timestamp === m.timestamp && ex.message === m.message);
          if (existing) {
            // Add capcode to existing group if not already there
            if (!existing.capcodes.find(c => c.id === m.id)) {
              existing.capcodes.push(m);
            }
          } else {
            // New unique message
            m.capcodes = [m];
            this.messages.unshift(m);
            if(this.messages.length > 50) this.messages.pop();
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
