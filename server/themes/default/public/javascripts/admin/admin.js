/* PagerMon admin Alpine.js components
 * Replaces admin.main.js (AngularJS 1.8)
 */

async function adminApi(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { window.location.href = '/auth/login'; return null; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw err;
  }
  return res.json().catch(() => ({ error: 'Invalid server response' }));
}

function showMsg(component, text, type, ms) {
  component.message = { text, type: type || 'alert-success' };
  setTimeout(() => { component.message = null; }, ms || 3000);
}

document.addEventListener('alpine:init', () => {

  // Stats component
  Alpine.data('statsComponent', () => ({
    loading: true,
    stats: {},
    status: null,
    maxHourly: 1,
    _chart: null,

    async init() {
      try {
        const r = await adminApi('GET', '/api/stats');
        this.stats = r || {};
        // FIX: gebruik unaire + om string/BigInt naar Number te dwingen voor Math.max
        if (this.stats.hourly && this.stats.hourly.length) {
          this.maxHourly = Math.max(...this.stats.hourly.map(h => +h.count)) || 1;
        }
        this.loading = false;
        this.$nextTick(() => this.initDailyChart());
      } catch(e) { this.loading = false; }

      try {
        const r2 = await adminApi('GET', '/api/systemstatus');
        this.status = r2;
      } catch(e) {}
    },

    // ── Getters voor berekende statistieken ─────────────────────────────────

    get busiestDay() {
      if (!this.stats.daily || !this.stats.daily.length) return null;
      return this.stats.daily.reduce((max, d) => +d.count > +max.count ? d : max, this.stats.daily[0]);
    },

    get avgPerDay() {
      if (!this.stats.daily || !this.stats.daily.length) return 0;
      const total = this.stats.daily.reduce((s, d) => s + +d.count, 0);
      return Math.round(total / this.stats.daily.length);
    },

    // Percentage-verandering tov vorige week; null als onvoldoende data
    get weekTrend() {
      if (!this.stats.daily || this.stats.daily.length < 8) return null;
      const sorted = [...this.stats.daily].sort((a, b) => (a.day < b.day ? -1 : 1));
      const last7 = sorted.slice(-7).reduce((s, d) => s + +d.count, 0);
      const prev7 = sorted.slice(-14, -7).reduce((s, d) => s + +d.count, 0);
      if (!prev7) return null;
      return Math.round((last7 - prev7) / prev7 * 100);
    },

    // ── Hulpfuncties ─────────────────────────────────────────────────────────

    // Hoeveel keer elke weekdag (0=zo) voorkomt in de laatste 31 dagen
    _dowOcc() {
      const occ = [0,0,0,0,0,0,0];
      const today = new Date(); today.setHours(0,0,0,0);
      for (let i = 0; i < 31; i++) {
        const dt = new Date(today); dt.setDate(dt.getDate() - i);
        occ[dt.getDay()]++;
      }
      return occ;
    },

    // Gemiddeld aantal berichten per voorkomen van weekdag dow
    dowAvg(dow, count) {
      const occ = this._dowOcc();
      return Math.round(+count / (occ[+dow] || 1));
    },

    get maxDow() {
      if (!this.stats.dow || !this.stats.dow.length) return 1;
      const occ = this._dowOcc();
      return Math.max(...this.stats.dow.map(d => Math.round(+d.count / (occ[+d.dow] || 1)))) || 1;
    },

    // FIX bargraph: +count dwingt expliciete typeconversie af
    barWidth(count) { return this.maxHourly ? Math.round(+count / this.maxHourly * 100) : 0; },
    dowWidth(avg)    { return this.maxDow   ? Math.round(+avg   / this.maxDow   * 100) : 0; },

    padHour(h) { return ('0' + h).slice(-2) + ':00'; },
    dowName(d) { return ['Zo','Ma','Di','Wo','Do','Vr','Za'][+d] || d; },

    formatDay(dateStr) {
      if (!dateStr) return '-';
      // dateStr is 'YYYY-MM-DD' — parse in lokale tijdzone via T00:00
      return new Date(dateStr + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    },

    formatUptime(s) {
      if (!s) return '-';
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      const parts = [];
      if (d) parts.push(d + 'd');
      if (h) parts.push(h + 'h');
      parts.push(m + 'min');
      return parts.join(' ');
    },
    formatBytes(b) {
      if (!b) return '-';
      if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
      return (b / 1024).toFixed(0) + ' KB';
    },
    formatServerTime(t) { return t ? new Date(t).toLocaleTimeString() : '-'; },

    // ── Charts ───────────────────────────────────────────────────────────────

    initDailyChart() {
      const canvas = document.getElementById('dailyChart');
      if (!canvas || typeof Chart === 'undefined') return;
      const daily = this.stats.daily || [];
      // Bouw lookup van beschikbare data
      const counts = {};
      daily.forEach(d => { counts[d.day] = +d.count; });
      // Genereer labels voor de laatste 31 dagen
      const labels = [], data = [], colors = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const busiestKey = this.busiestDay ? this.busiestDay.day : null;
      for (let i = 30; i >= 0; i--) {
        const dt = new Date(today); dt.setDate(dt.getDate() - i);
        const key = dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
        labels.push(i === 0 ? 'Vandaag' : dt.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }));
        data.push(counts[key] || 0);
        // Markeer drukste dag in een afwijkende kleur
        colors.push(key === busiestKey ? 'rgba(248,113,113,0.85)' : 'rgba(59,130,246,0.65)');
      }
      const isDark = !document.documentElement.classList.contains('light-theme');
      const textColor = isDark ? '#a0aec0' : '#555555';
      const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
      if (this._chart) { this._chart.destroy(); this._chart = null; }
      this._chart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'Berichten',
            data,
            backgroundColor: colors,
            borderColor: colors.map(c => c.replace('0.65', '1').replace('0.85', '1')),
            borderWidth: 1,
            borderRadius: 3
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { mode: 'index', intersect: false }
          },
          scales: {
            x: { ticks: { color: textColor, maxRotation: 45, font: { size: 10 } }, grid: { color: gridColor } },
            y: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } }
          }
        }
      });
    },

    destroy() {
      if (this._chart) { this._chart.destroy(); this._chart = null; }
    }
  }));

  // Logs component
  Alpine.data('logsComponent', () => ({
    loading: true,
    lines: [],
    total: 0,
    error: null,
    filter: '',
    _filterCache: null,   // gecachte gefilterde array
    _filterKey: '',       // filter-waarde waarvoor cache geldig is

    async init() {
      try {
        const r = await adminApi('GET', '/admin/logsData');
        this.lines = r.lines || [];
        this.total = r.total || 0;
        this.loading = false;
      } catch(e) {
        this.error = 'Log bestand kon niet geladen worden.';
        this.loading = false;
      }
      // Cache vervalt wanneer lines of filter verandert
      this.$watch('lines', () => { this._filterCache = null; });
      this.$watch('filter', () => { this._filterCache = null; });
    },

    filteredLines() {
      // Herbereken alleen als cache ongeldig is
      if (this._filterCache !== null && this._filterKey === this.filter) {
        return this._filterCache;
      }
      const f = this.filter ? this.filter.toLowerCase() : '';
      this._filterCache = f ? this.lines.filter(l => l.toLowerCase().includes(f)) : this.lines;
      this._filterKey = this.filter;
      return this._filterCache;
    }
  }));

  // Users list component
  Alpine.data('usersComponent', () => ({
    loading: true,
    users: [],
    search: '',
    message: null,

    async init() {
      try {
        const r = await adminApi('GET', '/api/user');
        this.users = Array.isArray(r) ? r : [];
        this.loading = false;
      } catch(e) { this.loading = false; }
    },

    filteredUsers() {
      if (!this.search) return this.users;
      const f = this.search.toLowerCase();
      return this.users.filter(u =>
        (u.username || '').toLowerCase().includes(f) ||
        (u.givenname || '').toLowerCase().includes(f) ||
        (u.surname || '').toLowerCase().includes(f) ||
        (u.email || '').toLowerCase().includes(f)
      );
    },

    userSelected() {
      return this.users.filter(u => u.selected).length;
    },

    userDetail(id) { window.location.href = '/admin/users/' + id; },

    openDeleteModal() {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('deleteUsersModal')).show();
    },

    async userDeleteConfirmed() {
      bootstrap.Modal.getInstance(document.getElementById('deleteUsersModal')).hide();
      const deleteList = this.users.filter(u => u.selected && u.id != 1).map(u => u.id);
      if (!deleteList.length) return;
      this.loading = true;
      try {
        const r = await adminApi('POST', '/api/user/deleteMultiple', { deleteList });
        if (r && r.status === 'ok') {
          showMsg(this, 'Users deleted!', 'alert-success');
          await this.init();
        } else {
          showMsg(this, 'Error deleting users: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error deleting users: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    }
  }));

  // User detail component
  Alpine.data('userDetailComponent', () => ({
    user: { role: 'user', status: 'active' },
    loading: true,
    isNew: false,
    userLoading: false,
    existingUsername: false,
    existingEmail: false,
    message: null,

    async init() {
      const parts = window.location.pathname.split('/');
      const id = parts[parts.length - 1];
      this.isNew = (id === 'new');

      // Listen for password reset event from the modal
      const self = this;
      this._resetHandler = function(e) { self.user.newpassword = e.detail.password; self.userResetConfirmed(); };
      document.addEventListener('user-reset-confirmed', this._resetHandler);

      if (!this.isNew) {
        try {
          const r = await adminApi('GET', '/api/user/' + id);
          this.user = r || {};
          if (r && r.username) {
            this.user.originalUsername = r.username;
            this.user.originalEmail = r.email;
            this.user.lastlogondate = r.lastlogondate ? new Date(r.lastlogondate).toLocaleString() : '';
          }
        } catch(e) {}
      } else {
        this.user = { role: 'user', status: 'active' };
      }
      this.loading = false;
    },

    async checkUsername() {
      if (!this.user.username) { this.existingUsername = false; return; }
      this.userLoading = true;
      try {
        const r = await adminApi('GET', '/api/userCheck/username/' + encodeURIComponent(this.user.username));
        this.existingUsername = !!(r && r.username && r.username !== this.user.originalUsername);
      } catch(e) { this.existingUsername = false; }
      this.userLoading = false;
    },

    async checkEmail() {
      if (!this.user.email) { this.existingEmail = false; return; }
      this.userLoading = true;
      try {
        const r = await adminApi('GET', '/api/userCheck/email/' + encodeURIComponent(this.user.email));
        this.existingEmail = !!(r && r.email && r.email !== this.user.originalEmail);
      } catch(e) { this.existingEmail = false; }
      this.userLoading = false;
    },

    async userSubmit() {
      if (this.existingUsername) { showMsg(this, 'Error saving user: Username already exists.', 'alert-danger'); return; }
      if (this.existingEmail) { showMsg(this, 'Error saving user: Email already exists.', 'alert-danger'); return; }
      this.loading = true;
      const id = this.user.id || 'new';
      try {
        const r = await adminApi('POST', '/api/user/' + id, this.user);
        if (r && r.status === 'ok') {
          showMsg(this, 'User saved!', 'alert-success');
          if (this.isNew && r.id) window.location.href = '/admin/users/' + r.id;
        } else {
          showMsg(this, 'Error saving user: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error saving user: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    openDeleteModal() {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('deleteUserModal')).show();
    },

    async userDeleteConfirmed() {
      bootstrap.Modal.getInstance(document.getElementById('deleteUserModal')).hide();
      this.loading = true;
      const parts = window.location.pathname.split('/');
      const id = parts[parts.length - 1];
      try {
        const r = await adminApi('DELETE', '/api/user/' + id, this.user);
        if (r && r.status === 'ok') {
          showMsg(this, 'User deleted!', 'alert-success');
          setTimeout(() => { window.location.href = '/admin/users'; }, 1000);
        } else {
          showMsg(this, 'Error deleting user: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error deleting user: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    openResetModal() {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('resetPasswordModal')).show();
    },

    async userResetConfirmed() {
      const parts = window.location.pathname.split('/');
      const id = parts[parts.length - 1];
      try {
        const r = await adminApi('POST', '/api/user/' + id, this.user);
        if (r && r.status === 'ok') {
          showMsg(this, 'Password reset!', 'alert-success');
          this.user.newpassword = null;
        } else {
          showMsg(this, 'Error resetting password: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error resetting password: ' + (e && e.error || e), 'alert-danger'); }
    },

    destroy() {
      if (this._resetHandler) document.removeEventListener('user-reset-confirmed', this._resetHandler);
    }
  }));

  // Aliases list component
  Alpine.data('aliasesComponent', () => ({
    loading: true,
    aliases: [],
    totalItems: 0,
    totalPages: 1,
    currentPage: 1,
    pageSize: 50,
    pageNumbers: [],
    gotoPage: 1,
    search: '',
    aliasRefreshRequired: 0,
    message: null,
    importResults: [],
    importResultsTitle: '',
    importResultsMsg: '',
    _searchTimer: null,

    async init() {
      await this.loadSettings();
      await this.loadAliases();
    },

    async loadSettings() {
      try {
        const r = await adminApi('GET', '/admin/settingsData');
        if (r && r.settings && r.settings.database && r.settings.database.aliasRefreshRequired == 1) {
          this.aliasRefreshRequired = 1;
          showMsg(this, 'Alias refresh required!', 'alert-warning', 8000);
        }
      } catch(e) {}
    },

    async loadAliases() {
      this.loading = true;
      const limit = this.pageSize < 0 ? -1 : this.pageSize;
      const qs = new URLSearchParams({ page: this.currentPage, limit: limit, q: this.search || '' });
      try {
        const r = await adminApi('GET', '/api/capcodes/?' + qs);
        this.aliases = r.data || [];
        this.totalItems = r.total || 0;
        this.totalPages = (limit < 0 || limit >= this.totalItems) ? 1 : (Math.ceil(this.totalItems / limit) || 1);
        this.buildPageNumbers();
      } catch(e) {}
      this.loading = false;
    },

    buildPageNumbers() {
      const maxVisible = 9, half = Math.floor(maxVisible / 2);
      let start = Math.max(1, this.currentPage - half);
      const end = Math.min(this.totalPages, start + maxVisible - 1);
      if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);
      const pages = [];
      for (let i = start; i <= end; i++) pages.push(i);
      this.pageNumbers = pages;
    },

    goToPage(p) {
      p = parseInt(p, 10);
      if (isNaN(p) || p < 1 || p > this.totalPages || p === this.currentPage) return;
      this.currentPage = p;
      this.loadAliases();
    },
    prevPage() { this.goToPage(this.currentPage - 1); },
    nextPage() { this.goToPage(this.currentPage + 1); },
    pageSizeChanged() { this.currentPage = 1; this.loadAliases(); },
    jumpToPage() { this.goToPage(this.gotoPage); },

    debounceSearch() {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => { this.currentPage = 1; this.loadAliases(); }, 300);
    },

    aliasSelected() { return this.aliases.filter(a => a.selected).length; },
    aliasDetail(id) { window.location.href = '/admin/aliases/' + id; },
    aliasMessages(id) { window.location.href = '/?alias=' + id; },

    openDeleteModal() {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('deleteAliasesModal')).show();
    },

    async aliasDeleteConfirmed() {
      bootstrap.Modal.getInstance(document.getElementById('deleteAliasesModal')).hide();
      const deleteList = this.aliases.filter(a => a.selected).map(a => a.id);
      if (!deleteList.length) return;
      this.loading = true;
      try {
        const r = await adminApi('POST', '/api/capcodes/deleteMultiple', { deleteList });
        if (r && r.status === 'ok') {
          showMsg(this, 'Alias deleted!', 'alert-success');
          this.aliasRefreshRequired = 1;
          await this.loadAliases();
        } else {
          showMsg(this, 'Error deleting alias: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error deleting alias: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    async aliasRefresh() {
      this.loading = true;
      try {
        const r = await adminApi('POST', '/api/capcodeRefresh');
        if (r && r.status === 'ok') {
          showMsg(this, 'Alias refresh complete!', 'alert-success');
          this.aliasRefreshRequired = 0;
        } else {
          showMsg(this, 'Error refreshing aliases: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error refreshing aliases: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    async aliasExport() {
      this.loading = true;
      try {
        const res = await fetch('/api/capcodeExport', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        if (!res.ok) throw new Error('Export failed');
        const data = await res.json();
        if (data.data) {
          const blob = new Blob([data.data], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = 'export.csv';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showMsg(this, 'Alias export complete!', 'alert-success');
        }
      } catch(e) { showMsg(this, 'Error exporting aliases: ' + e.message, 'alert-danger'); }
      this.loading = false;
    },

    aliasImport() {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('importAliasesModal')).show();
    },

    async aliasImportConfirmed() {
      bootstrap.Modal.getInstance(document.getElementById('importAliasesModal')).hide();
      const fileInput = document.getElementById('importcsv');
      if (!fileInput || !fileInput.files[0]) return;
      const deleteAll = document.getElementById('importDeleteAll').checked;
      document.getElementById('importDeleteAll').checked = false;
      this.loading = true;
      const reader = new FileReader();
      reader.onload = async (e) => {
        const rows = e.target.result.split('\n');
        try {
          const r = await adminApi('POST', '/api/capcodeImport', { rows, deleteAll });
          this.importResults = r.results || [];
          this.importResultsTitle = 'Import Results';
          this.importResultsMsg = '';
          bootstrap.Modal.getOrCreateInstance(document.getElementById('importResultsModal')).show();
        } catch(e2) {
          this.importResults = [];
          this.importResultsTitle = 'Import Failed';
          this.importResultsMsg = 'Failed to Parse CSV file, please check the file and try again!';
          bootstrap.Modal.getOrCreateInstance(document.getElementById('importResultsModal')).show();
        }
        this.loading = false;
      };
      reader.readAsText(fileInput.files[0]);
    },

    afterImport() {
      this.aliasRefreshRequired = 1;
      showMsg(this, 'Alias refresh required!', 'alert-warning', 8000);
      this.loadAliases();
    },

    destroy() {
      if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    }
  }));

  // Alias detail component
  Alpine.data('aliasDetailComponent', () => ({
    alias: { ignore: 0, onlyShowLoggedIn: 0 },
    loading: true,
    isNew: false,
    aliasLoading: false,
    existingAddress: false,
    existingID: null,
    aliasRefreshRequired: 0,
    plugins: [],
    settings: {},
    message: null,
    faSearch: '',
    templateSearch: '',
    faIcons: Object.freeze(["ad","address-book","address-card","adjust","air-freshener","align-center","align-justify","align-left","align-right","allergies","ambulance","american-sign-language-interpreting","anchor","angle-double-down","angle-double-left","angle-double-right","angle-double-up","angle-down","angle-left","angle-right","angle-up","angry","ankh","apple-alt","archive","archway","arrow-alt-circle-down","arrow-alt-circle-left","arrow-alt-circle-right","arrow-alt-circle-up","arrow-circle-down","arrow-circle-left","arrow-circle-right","arrow-circle-up","arrow-down","arrow-left","arrow-right","arrow-up","arrows-alt","arrows-alt-h","arrows-alt-v","assistive-listening-systems","asterisk","at","atlas","atom","audio-description","award","baby","baby-carriage","backspace","backward","bacon","bacteria","bacterium","bahai","balance-scale","balance-scale-left","balance-scale-right","ban","band-aid","barcode","bars","baseball-ball","basketball-ball","bath","battery-empty","battery-full","battery-half","battery-quarter","battery-three-quarters","bed","beer","bell","bell-slash","bezier-curve","bible","bicycle","biking","binoculars","biohazard","birthday-cake","blender","blender-phone","blind","blog","bold","bolt","bomb","bone","bong","book","book-dead","book-medical","book-open","book-reader","bookmark","border-all","border-none","border-style","bowling-ball","box","box-open","box-tissue","boxes","braille","brain","bread-slice","briefcase","briefcase-medical","broadcast-tower","broom","brush","bug","building","bullhorn","bullseye","burn","bus","bus-alt","business-time","calculator","calendar","calendar-alt","calendar-check","calendar-day","calendar-minus","calendar-plus","calendar-times","calendar-week","camera","camera-retro","campground","candy-cane","cannabis","capsules","car","car-alt","car-battery","car-crash","car-side","caravan","caret-down","caret-left","caret-right","caret-square-down","caret-square-left","caret-square-right","caret-square-up","caret-up","carrot","cart-arrow-down","cart-plus","cash-register","cat","certificate","chair","chalkboard","chalkboard-teacher","charging-station","chart-area","chart-bar","chart-line","chart-pie","check","check-circle","check-double","check-square","cheese","chess","chess-bishop","chess-board","chess-king","chess-knight","chess-pawn","chess-queen","chess-rook","chevron-circle-down","chevron-circle-left","chevron-circle-right","chevron-circle-up","chevron-down","chevron-left","chevron-right","chevron-up","child","church","circle","circle-notch","city","clinic-medical","clipboard","clipboard-check","clipboard-list","clock","clone","closed-captioning","cloud","cloud-download-alt","cloud-meatball","cloud-moon","cloud-moon-rain","cloud-rain","cloud-showers-heavy","cloud-sun","cloud-sun-rain","cloud-upload-alt","cocktail","code","code-branch","coffee","cog","cogs","coins","columns","comment","comment-alt","comment-dollar","comment-dots","comment-medical","comment-slash","comments","comments-dollar","compact-disc","compass","compress","compress-alt","compress-arrows-alt","concierge-bell","cookie","cookie-bite","copy","copyright","couch","credit-card","crop","crop-alt","cross","crosshairs","crow","crown","crutch","cube","cubes","cut","database","deaf","democrat","desktop","dharmachakra","diagnoses","dice","dice-d20","dice-d6","dice-five","dice-four","dice-one","dice-six","dice-three","dice-two","digital-tachograph","directions","disease","divide","dizzy","dna","dog","dollar-sign","dolly","dolly-flatbed","donate","door-closed","door-open","dot-circle","dove","download","drafting-compass","dragon","draw-polygon","drum","drum-steelpan","drumstick-bite","dumbbell","dumpster","dumpster-fire","dungeon","edit","egg","eject","ellipsis-h","ellipsis-v","envelope","envelope-open","envelope-open-text","envelope-square","equals","eraser","ethernet","euro-sign","exchange-alt","exclamation","exclamation-circle","exclamation-triangle","expand","expand-alt","expand-arrows-alt","external-link-alt","external-link-square-alt","eye","eye-dropper","eye-slash","fan","fast-backward","fast-forward","faucet","fax","feather","feather-alt","female","fighter-jet","file","file-alt","file-archive","file-audio","file-code","file-contract","file-csv","file-download","file-excel","file-export","file-image","file-import","file-invoice","file-invoice-dollar","file-medical","file-medical-alt","file-pdf","file-powerpoint","file-prescription","file-signature","file-upload","file-video","file-word","fill","fill-drip","film","filter","fingerprint","fire","fire-alt","fire-extinguisher","first-aid","fish","fist-raised","flag","flag-checkered","flag-usa","flask","flushed","folder","folder-minus","folder-open","folder-plus","font","football-ball","forward","frog","frown","frown-open","funnel-dollar","futbol","gamepad","gas-pump","gavel","gem","genderless","ghost","gift","gifts","glass-cheers","glass-martini","glass-martini-alt","glass-whiskey","glasses","globe","globe-africa","globe-americas","globe-asia","globe-europe","golf-ball","gopuram","graduation-cap","greater-than","greater-than-equal","grimace","grin","grin-alt","grin-beam","grin-beam-sweat","grin-hearts","grin-squint","grin-squint-tears","grin-stars","grin-tears","grin-tongue","grin-tongue-squint","grin-tongue-wink","grin-wink","grip-horizontal","grip-lines","grip-lines-vertical","grip-vertical","guitar","h-square","hamburger","hammer","hamsa","hand-holding","hand-holding-heart","hand-holding-medical","hand-holding-usd","hand-holding-water","hand-lizard","hand-middle-finger","hand-paper","hand-peace","hand-point-down","hand-point-left","hand-point-right","hand-point-up","hand-pointer","hand-rock","hand-scissors","hand-sparkles","hand-spock","hands","hands-helping","hands-wash","handshake","handshake-alt-slash","handshake-slash","hanukiah","hard-hat","hashtag","hat-cowboy","hat-cowboy-side","hat-wizard","hdd","head-side-cough","head-side-cough-slash","head-side-mask","head-side-virus","heading","headphones","headphones-alt","headset","heart","heart-broken","heartbeat","helicopter","highlighter","hiking","hippo","history","hockey-puck","holly-berry","home","horse","horse-head","hospital","hospital-alt","hospital-symbol","hospital-user","hot-tub","hotdog","hotel","hourglass","hourglass-end","hourglass-half","hourglass-start","house-damage","house-user","hryvnia","i-cursor","ice-cream","icicles","icons","id-badge","id-card","id-card-alt","igloo","image","images","inbox","indent","industry","infinity","info","info-circle","italic","jedi","joint","journal-whills","kaaba","key","keyboard","khanda","kiss","kiss-beam","kiss-wink-heart","kiwi-bird","landmark","language","laptop","laptop-code","laptop-house","laptop-medical","laugh","laugh-beam","laugh-squint","laugh-wink","layer-group","leaf","lemon","less-than","less-than-equal","level-down-alt","level-up-alt","life-ring","lightbulb","link","lira-sign","list","list-alt","list-ol","list-ul","location-arrow","lock","lock-open","long-arrow-alt-down","long-arrow-alt-left","long-arrow-alt-right","long-arrow-alt-up","low-vision","luggage-cart","lungs","lungs-virus","magic","magnet","mail-bulk","male","map","map-marked","map-marked-alt","map-marker","map-marker-alt","map-pin","map-signs","marker","mars","mars-double","mars-stroke","mars-stroke-h","mars-stroke-v","mask","medal","medkit","meh","meh-blank","meh-rolling-eyes","memory","menorah","mercury","meteor","microchip","microphone","microphone-alt","microphone-alt-slash","microphone-slash","microscope","minus","minus-circle","minus-square","mitten","mobile","mobile-alt","money-bill","money-bill-alt","money-bill-wave","money-bill-wave-alt","money-check","money-check-alt","monument","moon","mortar-pestle","mosque","motorcycle","mountain","mouse","mouse-pointer","mug-hot","music","network-wired","neuter","newspaper","not-equal","notes-medical","object-group","object-ungroup","oil-can","om","otter","outdent","pager","paint-brush","paint-roller","palette","pallet","paper-plane","paperclip","parachute-box","paragraph","parking","passport","pastafarianism","paste","pause","pause-circle","paw","peace","pen","pen-alt","pen-fancy","pen-nib","pen-square","pencil-alt","pencil-ruler","people-arrows","people-carry","pepper-hot","percent","percentage","person-booth","phone","phone-alt","phone-slash","phone-square","phone-square-alt","phone-volume","photo-video","piggy-bank","pills","pizza-slice","place-of-worship","plane","plane-arrival","plane-departure","plane-slash","play","play-circle","plug","plus","plus-circle","plus-square","podcast","poll","poll-h","poo","poo-storm","poop","portrait","pound-sign","power-off","pray","praying-hands","prescription","prescription-bottle","prescription-bottle-alt","print","procedures","project-diagram","pump-medical","pump-soap","puzzle-piece","qrcode","question","question-circle","quidditch","quote-left","quote-right","quran","radiation","radiation-alt","rainbow","random","receipt","record-vinyl","recycle","redo","redo-alt","registered","remove-format","reply","reply-all","republican","restroom","retweet","ribbon","ring","road","robot","rocket","route","rss","rss-square","ruble-sign","ruler","ruler-combined","ruler-horizontal","ruler-vertical","running","rupee-sign","sad-cry","sad-tear","satellite","satellite-dish","save","school","screwdriver","scroll","sd-card","search","search-dollar","search-location","search-minus","search-plus","seedling","server","shapes","share","share-alt","share-alt-square","share-square","shekel-sign","shield-alt","shield-virus","ship","shipping-fast","shoe-prints","shopping-bag","shopping-basket","shopping-cart","shower","shuttle-van","sign","sign-in-alt","sign-language","sign-out-alt","signal","signature","sim-card","sink","sitemap","skating","skiing","skiing-nordic","skull","skull-crossbones","slash","sleigh","sliders-h","smile","smile-beam","smile-wink","smog","smoking","smoking-ban","sms","snowboarding","snowflake","snowman","snowplow","soap","socks","solar-panel","sort","sort-alpha-down","sort-alpha-down-alt","sort-alpha-up","sort-alpha-up-alt","sort-amount-down","sort-amount-down-alt","sort-amount-up","sort-amount-up-alt","sort-down","sort-numeric-down","sort-numeric-down-alt","sort-numeric-up","sort-numeric-up-alt","sort-up","spa","space-shuttle","spell-check","spider","spinner","splotch","spray-can","square","square-full","square-root-alt","stamp","star","star-and-crescent","star-half","star-half-alt","star-of-david","star-of-life","step-backward","step-forward","stethoscope","sticky-note","stop","stop-circle","stopwatch","stopwatch-20","store","store-alt","store-alt-slash","store-slash","stream","street-view","strikethrough","stroopwafel","subscript","subway","suitcase","suitcase-rolling","sun","superscript","surprise","swatchbook","swimmer","swimming-pool","synagogue","sync","sync-alt","syringe","table","table-tennis","tablet","tablet-alt","tablets","tachometer-alt","tag","tags","tape","tasks","taxi","teeth","teeth-open","temperature-high","temperature-low","tenge","terminal","text-height","text-width","th","th-large","th-list","theater-masks","thermometer","thermometer-empty","thermometer-full","thermometer-half","thermometer-quarter","thermometer-three-quarters","thumbs-down","thumbs-up","thumbtack","ticket-alt","times","times-circle","tint","tint-slash","tired","toggle-off","toggle-on","toilet","toilet-paper","toilet-paper-slash","toolbox","tools","tooth","torah","torii-gate","tractor","trademark","traffic-light","trailer","train","tram","transgender","transgender-alt","trash","trash-alt","trash-restore","trash-restore-alt","tree","trophy","truck","truck-loading","truck-monster","truck-moving","truck-pickup","tshirt","tty","tv","umbrella","umbrella-beach","underline","undo","undo-alt","universal-access","university","unlink","unlock","unlock-alt","upload","user","user-alt","user-alt-slash","user-astronaut","user-check","user-circle","user-clock","user-cog","user-edit","user-friends","user-graduate","user-injured","user-lock","user-md","user-minus","user-ninja","user-nurse","user-plus","user-secret","user-shield","user-slash","user-tag","user-tie","user-times","users","users-cog","users-slash","utensil-spoon","utensils","vector-square","venus","venus-double","venus-mars","vest","vest-patches","vial","vials","video","video-slash","vihara","virus","virus-slash","viruses","voicemail","volleyball-ball","volume-down","volume-mute","volume-off","volume-up","vote-yea","vr-cardboard","walking","wallet","warehouse","water","wave-square","weight","weight-hanging","wheelchair","wifi","wind","window-close","window-maximize","window-minimize","window-restore","wine-bottle","wine-glass","wine-glass-alt","won-sign","wrench","x-ray","yen-sign","yin-yang"]),

    async init() {
      const parts = window.location.pathname.split('/');
      const id = parts[parts.length - 1];
      this.isNew = (id === 'new');

      try {
        const r = await adminApi('GET', '/admin/settingsData');
        if (r) {
          if (r.settings && r.settings.database && r.settings.database.aliasRefreshRequired == 1) {
            this.aliasRefreshRequired = 1;
          }
          this.settings = r.settings || {};
          this.plugins = Object.freeze(r.plugins || []);
        }
      } catch(e) {}

      await this.aliasLoad();
    },

    async aliasLoad() {
      this.loading = true;
      const parts = window.location.pathname.split('/');
      const id = parts[parts.length - 1];
      this.existingAddress = false;
      try {
        const r = await adminApi('GET', '/api/capcodes/' + id);
        this.alias = r || { ignore: 0, onlyShowLoggedIn: 0 };

        // Initialize pluginconf for all plugins
        if (!this.alias.pluginconf) this.alias.pluginconf = {};
        this.plugins.forEach(plugin => {
          if (!this.alias.pluginconf[plugin.name]) this.alias.pluginconf[plugin.name] = {};
        });

        if (r && r.address) {
          this.alias.originalAddress = r.address;
          this.isNew = false;
        } else {
          this.alias.address = '';
          this.alias.originalAddress = '';
          this.isNew = true;
        }
      } catch(e) {
        this.alias = { ignore: 0, onlyShowLoggedIn: 0 };
        this.isNew = true;
      }
      this.loading = false;
    },

    async checkAddress() {
      if (!this.alias.address) { this.existingAddress = false; return; }
      this.aliasLoading = true;
      try {
        const r = await adminApi('GET', '/api/capcodeCheck/' + encodeURIComponent(this.alias.address));
        if (r && r.address && r.address !== this.alias.originalAddress) {
          this.existingID = r.id;
          this.existingAddress = true;
        } else {
          this.existingAddress = false;
        }
      } catch(e) { this.existingAddress = false; }
      this.aliasLoading = false;
    },

    async aliasSubmit() {
      if (this.existingAddress) { showMsg(this, 'Error saving alias: Address already exists.', 'alert-danger'); return; }
      this.loading = true;
      const id = this.alias.id || 'new';
      try {
        const r = await adminApi('POST', '/api/capcodes/' + id, this.alias);
        if (r && r.status === 'ok') {
          showMsg(this, 'Alias saved!', 'alert-success');
          if (this.isNew) {
            this.aliasRefreshRequired = 1;
            window.location.href = '/admin/aliases/' + r.id;
          }
        } else {
          showMsg(this, 'Error saving alias: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error saving alias: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    openDeleteModal() {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('deleteAliasModal')).show();
    },

    async aliasDeleteConfirmed() {
      bootstrap.Modal.getInstance(document.getElementById('deleteAliasModal')).hide();
      this.loading = true;
      const parts = window.location.pathname.split('/');
      const id = parts[parts.length - 1];
      try {
        const r = await adminApi('DELETE', '/api/capcodes/' + id, this.alias);
        if (r && r.status === 'ok') {
          showMsg(this, 'Alias deleted!', 'alert-success');
          setTimeout(() => { window.location.href = '/admin/aliases'; }, 1000);
        } else {
          showMsg(this, 'Error deleting alias: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error deleting alias: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    async aliasRefresh() {
      this.loading = true;
      try {
        const r = await adminApi('POST', '/api/capcodeRefresh');
        if (r && r.status === 'ok') {
          showMsg(this, 'Alias refresh complete!', 'alert-success');
          this.aliasRefreshRequired = 0;
        } else {
          showMsg(this, 'Error refreshing aliases: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error refreshing aliases: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    newButton(id) { window.location.href = '/admin/aliases/' + id; },

    applyTemplate(template) {
      this.alias.agency = template.agency || this.alias.agency;
      this.alias.icon = template.icon || this.alias.icon;
      this.alias.color = template.color || this.alias.color;
      if (template.filter) this.alias.ignore = 1;
      else this.alias.ignore = 0;
    }
  }));

  // Settings component
  Alpine.data('settingsComponent', () => ({
    settings: { global: {}, database: {}, messages: { replaceText: [] }, aliases: { templates: [] }, auth: { keys: [] }, monitoring: {}, plugins: {} },
    plugins: [],
    themes: [],
    loading: true,
    message: null,
    showPassword: false,
    _sortable: null,

    async init() {
      try {
        const r = await adminApi('GET', '/admin/settingsData');
        if (r) {
          const s = r.settings || {};
          if (!s.messages) s.messages = {};
          if (!s.messages.replaceText || !s.messages.replaceText.length) s.messages.replaceText = [{}];
          if (!s.aliases) s.aliases = {};
          if (!s.aliases.templates || !s.aliases.templates.length) s.aliases.templates = [{}];
          if (!s.auth) s.auth = {};
          if (!s.auth.keys || !s.auth.keys.length) s.auth.keys = [{}];
          if (!s.plugins) s.plugins = {};
          this.settings = s;
          this.plugins = Object.freeze(r.plugins || []);
          this.themes = r.themes || [];
        }
      } catch(e) {}
      this.loading = false;

      // Initialize SortableJS for replaceText table
      this.$nextTick(() => {
        const tbody = document.getElementById('replaceTextTable');
        if (tbody && typeof Sortable !== 'undefined') {
          if (this._sortable) { this._sortable.destroy(); this._sortable = null; }
          const self = this;
          this._sortable = Sortable.create(tbody, {
            handle: '.drag-handle',
            animation: 150,
            onEnd(e) {
              const item = self.settings.messages.replaceText.splice(e.oldIndex, 1)[0];
              self.settings.messages.replaceText.splice(e.newIndex, 0, item);
            }
          });
        }
      });
    },

    async settingsSubmit() {
      this.loading = true;
      try {
        const r = await adminApi('POST', '/admin/settingsData', this.settings);
        if (r && r.status === 'ok') {
          showMsg(this, 'Settings saved!', 'alert-success');
        } else {
          showMsg(this, 'Error saving settings: ' + (r && r.error || ''), 'alert-danger');
        }
      } catch(e) { showMsg(this, 'Error saving settings: ' + (e && e.error || e), 'alert-danger'); }
      this.loading = false;
    },

    generateKey(index) {
      function uuid() {
        return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
          (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
      }
      const h1 = uuid().replace(/-/g,'').slice(0, 15);
      const h2 = uuid().replace(/-/g,'').slice(0, 15);
      const key = (parseInt(h1, 16).toString(36) + parseInt(h2, 16).toString(36)).toUpperCase();
      if (index === 'sessionSecret') {
        this.settings.global.sessionSecret = key;
      } else {
        this.settings.auth.keys[index].key = key;
      }
    },

    addKey() { this.settings.auth.keys.push({ name: '', key: '' }); },
    addMatch() { this.settings.messages.replaceText.push({ match: '', replace: '' }); },
    addTemplate() { this.settings.aliases.templates.push({ name: '', agency: '', icon: '', color: '' }); },

    destroy() {
      if (this._sortable) { this._sortable.destroy(); this._sortable = null; }
    },

    keySelected() { return this.settings.auth && this.settings.auth.keys ? this.settings.auth.keys.filter(k => k.selected).length : 0; },
    matchSelected() { return this.settings.messages && this.settings.messages.replaceText ? this.settings.messages.replaceText.filter(t => t.selected).length : 0; },
    templateSelected() { return this.settings.aliases && this.settings.aliases.templates ? this.settings.aliases.templates.filter(t => t.selected).length : 0; },

    removeKey() { if (this.keySelected()) this.settings.auth.keys = this.settings.auth.keys.filter(k => !k.selected); },
    removeMatch() { if (this.matchSelected()) this.settings.messages.replaceText = this.settings.messages.replaceText.filter(t => !t.selected); },
    removeTemplate() { if (this.templateSelected()) this.settings.aliases.templates = this.settings.aliases.templates.filter(t => !t.selected); }
  }));

});
