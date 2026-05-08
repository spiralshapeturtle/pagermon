/* PagerMon main Alpine.js application
 * Server-side config is injected via window.PAGERMON_CONFIG by index.ejs
 */

// Wake Lock — scherm actief houden (Safari 16.4+, Chrome, Edge)
(function() {
  let wakeLock = null;

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {
        // Stille no-op (bijv. tab op achtergrond of oudere browser)
      }
    }
  }

  // iOS geeft de lock altijd vrij bij schermvergrendeling; herverkrijgen bij terugkeer
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  requestWakeLock();
})();

(function() {
  const cfg = window.PAGERMON_CONFIG || {};

  // Cleans a raw P2000 message string down to a geocodable address.
  function cleanAddress(text) {
    let t = (text || '').trim();

    // Priority codes: "P 3", "A2", "B1", "Prio 2"
    t = t.replace(/^\s*(?:Prio\s*\d+|[A-E]\s*\d+|P\s*\d+)\s*/i, '');

    // Parenthetical expressions: (bg), (DIA: ja), (Directe inzet: ja), (binnen), (medium care)
    t = t.replace(/\([^)]{0,60}\)/g, '');

    // Colon-separated reference numbers: ": 15123" — run early before number-only strips
    // consume the digits so the orphaned colon is also removed
    t = t.replace(/\s*:\s*\d*(\s+\d+)*/g, '');

    // Ambulance unit identifiers: "AMBU 17118" / "Ambu 06811"
    t = t.replace(/\bAMBU\s+\d{4,6}\b/g, '');
    t = t.replace(/\bAmbu\s+\d{4,6}\b/g, '');

    // Unit codes: BOB-02, BNN-01, BDH-03, etc.
    t = t.replace(/\b[A-Z]{2,5}-\d{2,4}\b/g, '');

    // Compound dispatch/rit numbers like "16162-16", "201963-15" — strip as one unit
    // MUST run before the 5-digit strip below, which would otherwise eat the left side first
    t = t.replace(/\b\d{4,}-\d+\b/g, '');

    // 5-digit call-sign IDs starting with 1 (e.g. 13163, 17118)
    t = t.replace(/\b1[0-9]{4}\b/g, '');

    // Service/role words
    t = t.replace(/\b(?:Brandweer|Ambulance|Ambulancepost|Politie|Lifeliner\s*\d*|OvD-[GPB]|CPA|Trauma|Rijalda|KNRM|Brandwacht|Woonloc\.?|SEH|DP\d+)\b/gi, '');

    // VWS (station return) / DIA (direct admission) markers
    t = t.replace(/\bVWS\b/g, '');
    t = t.replace(/\bDIA\b/gi, '');

    // Reference numbers: rit, bon, GMS, ICnum, MKA region codes
    t = t.replace(/\bRit:?\s*\d*\b/gi, '');
    t = t.replace(/\bbon\s+\d+\b/gi, '');
    t = t.replace(/\bGMS:?\s*\d+\b/gi, '');
    t = t.replace(/\bICnum\s+\d+\b/gi, '');
    // MKA region/routing codes always appear at the end; consume everything from MKA onward
    t = t.replace(/\bMKA\b.*/i, '');
    t = t.replace(/\bREG\s+\d+\b/gi, '');

    // Dutch postal codes: "3201GZ"
    t = t.replace(/\b\d{4}[A-Z]{2}\b/g, '');

    // Incident type words and phrases (P2000 fire/ambulance incident descriptions)
    t = t.replace(/\bOMS\s+(?:brandmelding|handmelder)\b/gi, '');
    t = t.replace(/\bBR\s+(?:woning|container|afval|bijgebouw|wegvervoer|riet|gebouw|bosschage|berm|buiten)\b/gi, '');
    t = t.replace(/\b(?:Reanimatie|Liftopsluiting|Buitensluiting|Wateroverlast|Brandgerucht|Nacontrole|Nablussen|Bodemverontreiniging|Rookmelder|Brandmelding|Stankmelding|Koolmonoxide|Herbezetting|Dienstverlening|Bewusteloos|Autowrak|Brand)\b/gi, '');
    t = t.replace(/\bAss\.?\s+Ambu\b/gi, '');
    t = t.replace(/\bAss\.\b/gi, '');
    t = t.replace(/\bStank\/hind\.\s*\w*/gi, '');
    t = t.replace(/\b(?:Dier\s+(?:op\s+hoogte|in\s+problemen)|Voertuig\s+te\s+water|Persoon\s+te\s+water|Vervuild\s+wegdek|Intrekken\s+Alarm\s+Brw|Spoor\s+incident|Passage\s+Ambulance)\b/gi, '');
    t = t.replace(/\b(?:Aanrijding(?:\s+letsel)?|Ongeval(?:\s+(?:wegvervoer|gev\.\s*stof))?|Wegvervoer|Letsel|Materieel)\b/gi, '');

    // Expand known ALL-CAPS city abbreviations, then strip unexpanded ones
    const abbr = {
      'SGRAVH': "'s-Gravenhage", 'VOORSC': 'Voorschoten', 'ZOETMR': 'Zoetermeer',
      'BODEGR': 'Bodegraven',    'ALPHRN': 'Alphen aan den Rijn', 'WADDXV': 'Waddinxveen',
      'WASSNR': 'Wassenaar',     'OEGSTG': 'Oegstgeest',          'SASSHM': 'Sassenheim',
      'RIJNBG': 'Rijnsburg',     'NDWKZH': 'Noordwijk',           'HILLGM': 'Hillegom',
      'VOORB':  'Voorburg',      'SCHIDM': 'Schiedam',            'ROTTDM': 'Rotterdam',
      'CAPIJS': 'Capelle aan den IJssel',                          'SPIJKN': 'Spijkenisse',
      'RIDDKK': 'Ridderkerk',    'SLIEDR': 'Sliedrecht',          'DORDRT': 'Dordrecht',
      'HELLVS': 'Hellevoetsluis','RIJSZH': 'Rijswijk',            'DENHZH': "'s-Gravenhage",
      'NAALDW': 'Naaldwijk',     'MOERKP': 'Moerkapelle',         'GOUDA':  'Gouda',
      'DELFT':  'Delft',
    };
    t = t.replace(/\b([A-Z]{4,6})\b/g, function(m) { return abbr[m] || m; });
    t = t.replace(/\b[A-Z]{4,6}\b/g, '');

    // Strip all remaining standalone numbers ≥3 digits (dispatch codes, area codes)
    t = t.replace(/\b\d{3,}\b/g, '');

    // Trailing "21-1234" short rit references
    t = t.replace(/\s+\d{2}-\d{3,5}\s*$/, '');

    // Leading dash/separator left by stripped content
    t = t.replace(/^[\s\-–]+/, '');

    // Remove "Nederland"
    t = t.replace(/\bNederland\b/gi, '');

    // Deduplicate adjacent identical words (e.g. "Spijkenisse Spijkenisse" from abbr+spelled-out)
    t = t.replace(/\b(\w{3,})\s+\1\b/gi, '$1');

    // Normalize
    t = t.replace(/\s{2,}/g, ' ').trim();
    if (!t) return '';

    // Extract [street] [city]: find the FIRST word ending in a Dutch street suffix
    // (left-to-right scan so city names ending in a suffix like "Rotterdam"→"dam"
    // or "Amsterdam"→"dam" are never mistaken for the street anchor).
    // Walk backwards from the street word including prepositions freely, but
    // capitalized words only when a preposition already links them — strips
    // object/institution names ("Aldi", "Bibliotheek") while keeping multi-word
    // street names ("Reinier de Graafweg", "Ruwaard van Puttenweg").
    // Hyphenated directional suffixes (-Noord/-Zuid/-Oost/-West) are stripped
    // before the suffix test so "Stationsplein-Noord" matches "plein".
    const dirSuffix    = /-(?:Noord|Zuid|Oost|West|Centrum|Boven|Beneden)$/i;
    const streetSuffix = /(?:straat|weg|laan|dreef|plein|singel|kade|dijk|boulevard|pad|hof|park|ring|baan|brink|gracht|vest|allee|horst|hoek|dam|poort|steeg|markt|haven|erf|waard|promenade|burg|bolwerk)$/i;
    const preposition  = /^(?:van|de|den|der|het|'t|aan|op|in|bij|ter|te|voor|over|tot|uit|met|en|a)$/i;
    const words = t.split(/\s+/);

    let streetIdx = -1;
    for (let i = 0; i < words.length; i++) {
      const w0 = words[i];
      if (/^[A-Z]/.test(w0) && streetSuffix.test(w0.replace(dirSuffix, ''))) { streetIdx = i; break; }
    }

    if (streetIdx > 0) {
      let startIdx = streetIdx, foundPrep = false, capsAfterPrep = 0, directCapUsed = false;
      for (let j = streetIdx - 1; j >= 0; j--) {
        const w = words[j];
        if (preposition.test(w)) {
          startIdx = j; foundPrep = true;
        } else if (/^[A-Z'"]/.test(w) && !/^[A-Z]{4,}$/.test(w)) {
          if (!directCapUsed) {
            // Always include the word directly before the street suffix (e.g. "Paulus" in "Paulus Potterstraat")
            startIdx = j; directCapUsed = true;
          } else if (foundPrep && capsAfterPrep < 2) {
            startIdx = j; capsAfterPrep++;
          } else { break; }
        } else { break; }
      }
      t = words.slice(startIdx).join(' ');
    }

    t = t.replace(/\s{2,}/g, ' ').trim();
    if (t) t += ', Nederland';
    return t;
  }

  function isNationalCode(address) {
    const n = parseInt(String(address).replace(/^0+/, ''), 10);
    return (n >= 2029568 && n <= 2029583) ? 1 : 0;
  }

  // noLeadingZeros: strips leading zeros from addresses > 7 chars
  function noLeadingZeros(addr) {
    if (!addr) return addr;
    let s = String(addr);
    while (s.length > 7 && s[0] === '0') s = s.slice(1);
    return s;
  }

  // applyHighlight: extracts logic from angular-textreplace.js
  // rules: array of {match, highlight, replace}
  function applyHighlight(text, rules) {
    if (!rules || !rules.length || !text) return escapeHtml(text || '');
    let result = escapeHtml(text);
    rules.forEach(function(rule) {
      if (!rule.match) return;
      try {
        // No extra wrapping group — $1/$2/etc. in rule.replace refer directly to the rule's own groups.
        // Use $& (whole match) for highlight/label modes so they work with or without capture groups.
        const regex = new RegExp('(?<!<[^>]*)' + rule.match, 'gi');
        if (rule.highlight === 'replace') {
          result = result.replace(regex, rule.replace || '$&');
        } else if (rule.highlight === 'true' || rule.highlight === true) {
          // Escape rule.replace in HTML-attribuut om stored XSS te voorkomen
          const safeLabel = rule.replace
            ? ' title="' + rule.replace.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"'
            : '';
          result = result.replace(regex, '<a href="/?q=$&" class="highlight-match"' + safeLabel + '>$&</a>');
        } else {
          // Label mode (default): tooltip only
          if (rule.replace) {
            result = result.replace(regex, '<span class="label-match" title="' + rule.replace + '">$&</span>');
          }
        }
      } catch (e) {}
    });
    return result;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // badgeTextColor: luminance-based text color for capcode badges
  // Gebruikt één persistent canvas-element (geen nieuw element per aanroep)
  let _badgeColorCache = {};
  let _badgeColorCacheSize = 0;
  let _colorCanvas = null;
  let _colorCtx = null;
  function badgeTextColor(color) {
    const isLight = document.documentElement.classList.contains('light-theme');
    const fallback = isLight ? '#1a1f2e' : '#D6EEFF';
    if (!color) return fallback;
    const cacheKey = color + (isLight ? ':light' : ':dark');
    if (_badgeColorCache[cacheKey]) return _badgeColorCache[cacheKey];
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
      if (_badgeColorCacheSize >= 200) { _badgeColorCache = {}; _badgeColorCacheSize = 0; }
      _badgeColorCache[cacheKey] = result;
      _badgeColorCacheSize++;
      return result;
    } catch(e) { return fallback; }
  }

  // Format a Unix timestamp (seconds) to 'YYYY-MM-DD' using local time
  function fmtDate(unixSec) {
    const d = new Date(unixSec * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // Format a Unix timestamp (seconds) to 'HH:mm:ss' using local time
  function fmtTime(unixSec) {
    const d = new Date(unixSec * 1000);
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + min + ':' + sec;
  }

  // Return a human-readable relative time string for a Unix timestamp (seconds)
  function relativeTimeStr(unixSec) {
    if (!unixSec) return '';
    const diffMs = Date.now() - unixSec * 1000;
    const diffSec = Math.round(diffMs / 1000);
    if (diffSec < 60) return diffSec + ' seconds ago';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return diffMin + ' minute' + (diffMin === 1 ? '' : 's') + ' ago';
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return diffHr + ' hour' + (diffHr === 1 ? '' : 's') + ' ago';
    const diffDay = Math.round(diffHr / 24);
    return diffDay + ' day' + (diffDay === 1 ? '' : 's') + ' ago';
  }

  // Shared AudioContext
  let _audioCtx = null;
  function getAudioCtx() {
    if (!_audioCtx) {
      try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    }
    return _audioCtx;
  }

  // cleanNotificationBody
  function cleanNotificationBody(text) {
    return String(text)
      .replace(/https?:\/\/[^\s]*/gi, '')
      .replace(/\bMONI\b/gi, '')
      .replace(/\[FLEX[^\]]*\]/gi, '')
      .replace(/\|[A-Z0-9]+/g, '')
      .replace(/[<>]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function notify(notifyTitle, notifyMessage) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var opts = { body: cleanNotificationBody(notifyMessage), icon: '/apple-touch-icon.png' };
    // Chrome vereist registration.showNotification() wanneer een SW actief is;
    // new Notification() vanuit de pagina wordt dan geblokkeerd.
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(function(reg) {
        reg.showNotification(notifyTitle, opts);
      }).catch(function() {
        try { new Notification(notifyTitle, opts); } catch(e) {}
      });
    } else {
      try { new Notification(notifyTitle, opts); } catch(e) {}
    }
  }

  document.addEventListener('alpine:init', () => {
    Alpine.data('messageComponent', () => ({
      messages: [],
      pager: { limit: 20, currentPage: 1, pageCount: 1, pages: [] },
      loading: false,
      spinner: '',
      query: '',
      origQuery: '',
      hasQuery: false,
      filter: '',
      filterString: '',
      searchOpen: false,
      timeRelative: false,
      soundEnabled: false,
      notificationSupport: false,
      notificationEnabled: 'false',
      statsLoading: false,
      stats: null,
      statsMaxHourly: 1,
      statsMaxDow: 1,
      mapsLoading: {},
      copyFeedback: {},
      hideUnaliased: false,
      sneakpeek: false,
      _statsModalChart: null,
      _socket: null,
      _autoRefreshTimer: null,
      _relativeTimeTimer: null,
      _fetchController: null,
      _iosUnlockActive: false,
      _iosUnlockBound: null,
      _reloadPending: false,
      _notifiedKeys: {},

      init() {
        // Read URL params
        const params = new URLSearchParams(window.location.search);
        if (params.get('q')) { this.query = params.get('q'); this.origQuery = params.get('q'); this.hasQuery = true; this.searchOpen = true; }
        if (params.get('agency') || params.get('address') || params.get('alias')) { this.hasQuery = true; this.filter = params.get('agency') || params.get('address') || params.get('alias'); }

        // Cookies
        this.timeRelative = /(?:^|;\s*)timeRelative=on/.test(document.cookie);
        this.soundEnabled = /(?:^|;\s*)soundEnabled=on/.test(document.cookie);
        this.sneakpeek = !!cfg.login || /(?:^|;\s*)sneakpeek=on/.test(document.cookie);
        this.hideUnaliased = !/(?:^|;\s*)pdwMode=off/.test(document.cookie);

        // Chrome blocks new Notification() on insecure (HTTP non-localhost) origins.
        if ('Notification' in window && window.isSecureContext) {
          this.notificationSupport = true;
          const saved = getCookie('notificationEnabled') || 'false';
          this.notificationEnabled = (saved === 'true' && Notification.permission === 'granted') ? 'true' : 'false';

          // Verifieer of cookie 'true' ook echt een actieve push-subscription heeft.
          // Als de SW de sub niet (meer) heeft (bijv. na SW-update of mislukte registratie),
          // reset dan de cookie zodat de volgende klik de toestemmingsvraag triggert.
          if (this.notificationEnabled === 'true' && 'serviceWorker' in navigator) {
            const _self = this;
            navigator.serviceWorker.ready.then(function(reg) {
              if (!('pushManager' in reg)) return;
              return reg.pushManager.getSubscription().then(function(sub) {
                if (!sub) {
                  const exp = new Date(); exp.setDate(exp.getDate() + 30);
                  document.cookie = 'notificationEnabled=false; expires=' + exp.toUTCString() + '; path=/';
                  _self.notificationEnabled = 'false';
                }
              });
            }).catch(function() {});
          }
        }

        if (this.soundEnabled) this._enableIosUnlock();

        // Socket.io
        const self = this;
        this._socket = io({ transports: ['websocket'], upgrade: false, forceNew: true });

        const discIcon = document.getElementById('socket-disconnected-icon');
        this._socket.on('connect', function() {
          if (discIcon) discIcon.classList.add('d-none');
        });
        this._socket.on('disconnect', function() {
          if (discIcon) discIcon.classList.remove('d-none');
        });

        const _hiddenSoundKeys = {};
        this._socket.on('messagePost', function(message) {
          if (!self.sneakpeek && message.onlyShowLoggedIn) {
            if (self.soundEnabled) {
              const key = message.timestamp + '|' + message.message;
              if (!_hiddenSoundKeys[key]) {
                _hiddenSoundKeys[key] = true;
                self._playBeep();
                setTimeout(function() { delete _hiddenSoundKeys[key]; }, 300000);
              }
            }
            return;
          }
          self._onMessagePost(message);
        });

        // Visibility change: resume audio, refresh data, reload if socket down
        var _hiddenSince = null;
        this._visibilityHandler = function() {
          if (document.hidden) {
            _hiddenSince = Date.now();
          } else {
            if (self.soundEnabled) {
              const ctx = getAudioCtx();
              if (ctx && ctx.state === 'suspended') ctx.resume();
            }
            // Refresh messages silently if page was hidden for >30s
            if (_hiddenSince !== null && (Date.now() - _hiddenSince) > 30000) {
              self.updateData();
            }
            _hiddenSince = null;
            // Fallback: full reload if socket is still down after 2s
            if (self._socket && !self._socket.connected && !self._reloadPending) {
              self._reloadPending = true;
              setTimeout(function() {
                self._reloadPending = false;
                if (self._socket && !self._socket.connected && navigator.onLine) window.location.reload();
              }, 2000);
            }
          }
        };
        document.addEventListener('visibilitychange', this._visibilityHandler);

        // PDW mode event from menu
        this._pdwHandler = function(e) { self.hideUnaliased = e.detail.active; self.updateData(); };
        window.addEventListener('pdwModeChange', this._pdwHandler);

        // Sneakpeek event from menu
        this._sneakpeekHandler = function(e) {
          self.sneakpeek = e.detail.active;
          if (self._socket && self._socket.connected) { self._socket.emit('setSneakpeek', e.detail.active); }
          self.updateData();
        };
        window.addEventListener('sneakpeekChange', this._sneakpeekHandler);

        // Fallback auto-refresh (30s, only if socket down)
        this._autoRefreshTimer = setInterval(function() {
          if (self._socket && !self._socket.connected && self.pager.currentPage === 1 && !self.hasQuery && !self.filter) {
            self.updateData();
          }
        }, 30000);

        // Relative time refresh (30s)
        this._relativeTimeTimer = setInterval(function() {
          if (self.timeRelative) {
            // Force Alpine to re-evaluate x-text bindings that call relativeTime()
            self.messages = self.messages.slice();
          }
        }, 30000);

        this.updateData();
      },

      _onMessagePost(message) {
        const self = this;
        const params = new URLSearchParams(window.location.search);

        function addMessage(msg) {
          let isNew = false;
          if (msg.isFlexGroup) {
            let grp = null;
            for (let i = 0; i < self.messages.length; i++) {
              if (self.messages[i].isFlexGroup &&
                  self.messages[i].timestamp === msg.timestamp &&
                  self.messages[i].message === msg.message) {
                grp = self.messages[i];
                break;
              }
            }
            if (grp) {
              grp.capcodes.push({ id: msg.id, address: msg.address, alias: msg.alias, alias_id: msg.alias_id, agency: msg.agency, icon: msg.icon, color: msg.color });
              grp.capcodes.sort(function(a, b) { return isNationalCode(a.address) - isNationalCode(b.address); });
              // Force Alpine reactivity
              self.messages = self.messages.slice();
            } else {
              msg.capcodes = [{ id: msg.id, address: msg.address, alias: msg.alias, alias_id: msg.alias_id, agency: msg.agency, icon: msg.icon, color: msg.color }];
              self.messages.unshift(msg);
              if (self.messages.length > self.pager.limit) self.messages.pop();
              isNew = true;
            }
          } else {
            msg.capcodes = [{ id: msg.id, address: msg.address, alias: msg.alias, alias_id: msg.alias_id, agency: msg.agency, icon: msg.icon, color: msg.color }];
            self.messages.unshift(msg);
            if (self.messages.length > self.pager.limit) self.messages.pop();
            isNew = true;
          }
          if (isNew && self.soundEnabled) self._playBeep();
          return isNew;
        }

        // Browser notifications — deduplicate per timestamp+message so a FLEX group
        // with multiple capcodes only fires one notification (same as old Angular behaviour).
        // Groepscapcodes 2029568–2029583 krijgen geen notificatie.
        if (!cfg.apisecurity || cfg.login) {
          if (!isNationalCode(message.address) && this.notificationEnabled === 'true' && (message.agency || message.alias)) {
            const notifyKey = message.timestamp + '|' + message.message;
            if (!this._notifiedKeys[notifyKey]) {
              this._notifiedKeys[notifyKey] = true;
              setTimeout(() => { delete this._notifiedKeys[notifyKey]; }, 300000);
              
              // Dubbel-fix: alleen een melding vanuit het tabblad als de pagina ZICHTBAAR is.
              // Als de pagina op de achtergrond staat (bijv. tijdens Netflix), laat de Service Worker het werk doen.
              if (document.visibilityState !== 'visible') return;

              // Stripping logica: verwijder alias/agency aan het begin van het bericht
              let cleanMsg = message.message || '';
              if (message.alias && cleanMsg.startsWith(message.alias)) {
                cleanMsg = cleanMsg.substring(message.alias.length).trim();
              }
              if (message.agency && cleanMsg.startsWith(message.agency)) {
                cleanMsg = cleanMsg.substring(message.agency.length).trim();
              }
              // Verwijder resterende tekens zoals : of -
              cleanMsg = cleanMsg.replace(/^[:\-\s]+/, '');

              notify('P2000-melding', cleanMsg || 'Nieuw bericht');
            }
          }
        }

        if (this.pager.currentPage !== 1) return;

        message.date = message.timestamp ? fmtDate(message.timestamp) : '';
        message.time = message.timestamp ? fmtTime(message.timestamp) : '';
        // NOTE: do NOT pre-escape message.message here — applyHighlight() calls escapeHtml()
        // internally, so pre-escaping would cause double-encoding (&amp; → &amp;amp;).

        if (this.hideUnaliased && !message.alias) return;

        const q = params.get('q');
        const agency = params.get('agency');
        const alias = params.get('alias');
        const address = params.get('address');
        if (q || agency || alias || address) {
          // Use a flag so only the first matching filter adds the message (prevent duplicates
          // when multiple filter params are active and all match the same message).
          let matched = false;
          if (!matched && q) { try { const patt = new RegExp(q, 'i'); if (patt.test(message.message) || patt.test(message.agency) || patt.test(message.address)) { addMessage(message); matched = true; } } catch(e) {} }
          if (!matched && agency) { try { const patt = new RegExp(agency, 'i'); if (patt.test(message.agency)) { addMessage(message); matched = true; } } catch(e) {} }
          if (!matched && alias) { if (message.alias_id == alias) { addMessage(message); matched = true; } }
          if (!matched && address) { const ap = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.'); try { const patt = new RegExp('^' + ap + '$', 'i'); if (patt.test(message.address)) addMessage(message); } catch(e) {} }
        } else {
          addMessage(message);
        }
      },

      updateData(page) {
        const self = this;
        this.spinner = 'fa-spin';
        this.loading = true;
        const params = new URLSearchParams(window.location.search);
        const curPage = page || parseInt(params.get('page') || '1', 10);
        const limit = getCookie('messageLimit') || '';

        const queryObj = { page: curPage };
        if (limit) queryObj.limit = limit;

        const q = params.get('q');
        const agency = params.get('agency');
        const address = params.get('address');
        const alias = params.get('alias');

        if (q) { this.query = q; this.origQuery = q; this.hasQuery = true; queryObj.q = q; this.searchOpen = true; }
        else { this.query = ''; this.hasQuery = false; }

        if (agency || address || alias) {
          const activeFilters = [];
          this.hasQuery = true;
          if (agency) { activeFilters.push('Agency: ' + agency); queryObj.agency = agency; }
          if (address) { let displayAddr = address.replace(/%/g, ''); if (/^00\d{7}$/.test(displayAddr)) displayAddr = displayAddr.slice(2); activeFilters.push('Capcode: ' + displayAddr); queryObj.address = address; }
          if (alias) { activeFilters.push(params.get('aliasName') || ('Alias: ' + alias)); queryObj.alias = alias; }
          this.filter = agency || address || alias;
          this.filterString = activeFilters.join(' & ');
        }

        if (page) {
          const qArray = [];
          if (queryObj.q) qArray.push('q=' + encodeURIComponent(queryObj.q));
          if (queryObj.address) qArray.push('address=' + encodeURIComponent(queryObj.address));
          if (queryObj.agency) qArray.push('agency=' + encodeURIComponent(queryObj.agency));
          if (queryObj.alias) qArray.push('alias=' + encodeURIComponent(queryObj.alias));
          if (queryObj.page > 1) qArray.push('page=' + encodeURIComponent(queryObj.page));
          window.history.pushState('', '', qArray.length > 0 ? '?' + qArray.join('&') : '/');
        }

        queryObj.pdwMode = this.hideUnaliased ? '1' : '0';
        queryObj.sneakpeek = this.sneakpeek ? '1' : '0';

        const qs = Object.entries(queryObj).map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
        const hasFilter = queryObj.q || queryObj.agency || queryObj.address || queryObj.alias;
        const url = (hasFilter ? '/api/messageSearch/?' : '/api/messages/?') + qs;

        // Annuleer een eventueel lopend fetch-verzoek voordat een nieuw wordt gestart
        if (this._fetchController) this._fetchController.abort();
        this._fetchController = new AbortController();
        const signal = this._fetchController.signal;

        fetch(url, { signal: signal })
          .then(function(r) { return r.json(); })
          .then(function(results) { self._handleResults(results); })
          .catch(function(e) {
            if (e.name === 'AbortError') return; // verwacht bij component-cleanup of nieuw verzoek
            self.spinner = ''; self.loading = false;
          });
      },

      _handleResults(results) {
        // Guard: API returns {init:{}, messages:[]} when rowCount === 0.
        // Preserve existing pager.limit so the toolbar dropdown stays intact.
        if (!results || results.init == null || results.init.currentPage == null) {
          this.spinner = '';
          this.loading = false;
          this.messages = [];
          this.pager = Object.assign({}, this.pager, { pageCount: 0, pages: [], msgCount: 0 });
          return;
        }
        results.init.currentPage++;
        const cp = results.init.currentPage;
        const pc = results.init.pageCount;
        // Ellipsis pagination: always show p1, window around cp, last page.
        // null entries render as '…' separators.
        const pages = [];
        if (pc <= 9) {
          for (let i = 1; i <= pc; i++) pages.push(i);
        } else {
          const lo = Math.max(2, cp - 2);
          const hi = Math.min(pc - 1, cp + 2);
          pages.push(1);
          if (lo > 2) pages.push(null);
          for (let i = lo; i <= hi; i++) pages.push(i);
          if (hi < pc - 1) pages.push(null);
          pages.push(pc);
        }
        results.init.pages = pages;
        this.pager = results.init;

        results.messages.forEach(function(result) {
          result.date = result.timestamp ? fmtDate(result.timestamp) : '';
          result.time = result.timestamp ? fmtTime(result.timestamp) : '';
          // Do NOT pre-escape result.message — applyHighlight() handles escaping internally.
        });

        this.spinner = '';
        this.loading = false;
        this.messages = groupMessages(results.messages);
      },

      relativeTime(ts) {
        return ts ? relativeTimeStr(ts) : '';
      },

      toggleTimeMode() {
        this.timeRelative = !this.timeRelative;
        const exp = new Date(); exp.setDate(exp.getDate() + 365);
        document.cookie = 'timeRelative=' + (this.timeRelative ? 'on' : 'off') + '; expires=' + exp.toUTCString() + '; path=/';
      },

      setCookie(cookie, value) {
        const expireDate = new Date(); expireDate.setDate(expireDate.getDate() + 30);
        document.cookie = cookie + '=' + value + '; expires=' + expireDate.toUTCString() + '; path=/';
        this.updateData(this.pager.currentPage);
      },

      toggleSound() {
        this.soundEnabled = !this.soundEnabled;
        if (this.soundEnabled) {
          this._iosUnlockHandler();
          this._enableIosUnlock();
        } else {
          this._disableIosUnlock();
        }
        const exp = new Date(); exp.setDate(exp.getDate() + 365);
        document.cookie = 'soundEnabled=' + (this.soundEnabled ? 'on' : 'off') + '; expires=' + exp.toUTCString() + '; path=/';
      },

      async toggleNotifications() {
        const self = this;
        const exp = new Date(); exp.setDate(exp.getDate() + 30);

        // ── Uitschakelen ────────────────────────────────────────────────────
        if (this.notificationEnabled === 'true') {
          document.cookie = 'notificationEnabled=false; expires=' + exp.toUTCString() + '; path=/';
          this.notificationEnabled = 'false';
          // Zeg push-subscription op als die aanwezig is
          if ('serviceWorker' in navigator) {
            try {
              const reg = await navigator.serviceWorker.ready;
              if ('pushManager' in reg) {
                const sub = await reg.pushManager.getSubscription();
                if (sub) {
                  await sub.unsubscribe();
                  // Informeer server zodat subscription uit de database verwijderd kan worden
                  fetch('/api/push/unsubscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: sub.endpoint })
                  }).catch(function() {});
                }
              }
            } catch(e) {}
          }
          return;
        }

        // ── Inschakelen — stap 1: browser-permissie ─────────────────────────
        if (!('Notification' in window)) return;

        let permission = Notification.permission;
        if (permission === 'default') {
          // requestPermission() is Promise-based in moderne browsers;
          // callback-stijl als fallback voor oudere Safari
          permission = await new Promise(function(resolve) {
            const result = Notification.requestPermission(resolve);
            if (result && typeof result.then === 'function') result.then(resolve);
          });
        }
        if (permission !== 'granted') return;

        // Foreground-notificaties via SW showNotification zijn nu actief.
        // Cookie pas instellen nadat push-subscription ÉN server-opslag succesvol zijn.

        // ── Stap 2: registreer push-subscription via PushManager ────────────
        // Vereist HTTPS (of localhost) en een geregistreerde Service Worker
        if (!('serviceWorker' in navigator) || !window.isSecureContext) {
          // Alleen foreground-notificaties — zet cookie direct
          document.cookie = 'notificationEnabled=true; expires=' + exp.toUTCString() + '; path=/';
          self.notificationEnabled = 'true';
          return;
        }

        try {
          // Wacht totdat de SW klaar is EN de pagina bestuurt (controller aanwezig)
          const reg = await navigator.serviceWorker.ready;

          // pushManager afwezig in HTTP-context of privémodus (Firefox)
          if (!('pushManager' in reg)) {
            console.info('PagerMon: pushManager niet beschikbaar — alleen foreground-notificaties actief');
            document.cookie = 'notificationEnabled=true; expires=' + exp.toUTCString() + '; path=/';
            self.notificationEnabled = 'true';
            return;
          }

          // Haal VAPID public key op van server
          const keyResp = await fetch('/api/push/vapid-public-key');
          if (!keyResp.ok) {
            console.info('PagerMon: VAPID public key niet geconfigureerd op server — alleen foreground-notificaties actief');
            document.cookie = 'notificationEnabled=true; expires=' + exp.toUTCString() + '; path=/';
            self.notificationEnabled = 'true';
            return;
          }
          const keyData = await keyResp.json();
          if (!keyData.publicKey) {
            document.cookie = 'notificationEnabled=true; expires=' + exp.toUTCString() + '; path=/';
            self.notificationEnabled = 'true';
            return;
          }

          // Verwijder bestaande verouderde subscription vóór het aanmaken van een nieuwe.
          // Chrome/Firefox invalideren de oude subscription automatisch, maar de server
          // heeft het oude endpoint nog en zou anders naar 410-gone endpoints sturen.
          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            try {
              await fetch('/api/push/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: existing.endpoint })
              });
              await existing.unsubscribe();
            } catch(e) { /* niet kritiek */ }
          }

          // Maak nieuwe push-subscription aan
          // VERPLICHT voor Chrome: userVisibleOnly: true
          // applicationServerKey MOET een Uint8Array zijn, niet een string
          const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: _urlBase64ToUint8Array(keyData.publicKey)
          });

          // Stuur subscription naar server om op te slaan
          const subResp = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription)
          });
          if (!subResp.ok) throw new Error('Server push-subscribe mislukt: ' + subResp.status);

          // Cookie pas instellen nadat subscribe() ÉN server-opslag geslaagd zijn
          document.cookie = 'notificationEnabled=true; expires=' + exp.toUTCString() + '; path=/';
          self.notificationEnabled = 'true';
          console.info('PagerMon: Push-subscription actief');
        } catch(err) {
          // InvalidStateError = al ingeschreven (geen probleem)
          // NotAllowedError   = gebruiker weigerde permissie
          // AbortError        = SW nog niet klaar
          if (err.name !== 'InvalidStateError') {
            console.warn('PagerMon: Push-subscription mislukt —', err.name, err.message);
          }
          // Niet-kritieke fout: zet cookie zodat foreground-notificaties werken
          document.cookie = 'notificationEnabled=true; expires=' + exp.toUTCString() + '; path=/';
          self.notificationEnabled = 'true';
        }
      },

      submitSearch($event) {
        const q = (this.query || '').trim();
        if (/^\d[\d%]*$/.test(q)) {
          $event.preventDefault();
          let addr = q;
          if (/^\d{7}$/.test(addr)) addr = '00' + addr;
          if (addr.slice(-1) !== '%') addr = addr + '%';
          window.location.href = '/?address=' + encodeURIComponent(addr);
        }
        // else: normal form submit /?q=VALUE
      },

      openMaps(message, $event) {
        if ($event) $event.preventDefault();
        const id = message.id;
        if (this.mapsLoading[id]) return;
        const query = cleanAddress(message.message);
        if (!query) return;

        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        const win = isIOS ? null : window.open('', '_blank');
        this.mapsLoading[id] = true;
        const self = this;

        fetch('/api/geocode?' + new URLSearchParams({ q: query }))
          .then(function(r) { return r.json(); })
          .then(function(d) {
            const hasCoords = d.lat && d.lon;
            if (isIOS) {
              window.location.href = hasCoords
                ? 'comgooglemaps://?q=' + d.lat + ',' + d.lon + '&zoom=15'
                : 'comgooglemaps://?q=' + encodeURIComponent(query) + '&zoom=15';
            } else if (win) {
              win.location.href = hasCoords
                ? 'https://www.google.com/maps?q=' + d.lat + ',' + d.lon + '&z=15'
                : 'https://www.google.com/maps/search/' + encodeURIComponent(query);
            }
          })
          .catch(function() {
            if (isIOS) window.location.href = 'comgooglemaps://?q=' + encodeURIComponent(query) + '&zoom=15';
            else if (win) win.location.href = 'https://www.google.com/maps/search/' + encodeURIComponent(query);
          })
          .finally(function() {
            delete self.mapsLoading[id];
            self.mapsLoading = Object.assign({}, self.mapsLoading);
          });
      },

      copyMessage(message, $event) {
        if ($event) $event.preventDefault();
        const text = message.message || '';
        const id = message.id;
        const self = this;
        function showFeedback() {
          self.copyFeedback[id] = true;
          self.copyFeedback = Object.assign({}, self.copyFeedback);
          setTimeout(function() {
            delete self.copyFeedback[id];
            self.copyFeedback = Object.assign({}, self.copyFeedback);
          }, 1500);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(showFeedback).catch(function() { _fallbackCopy(text); showFeedback(); });
        } else {
          _fallbackCopy(text); showFeedback();
        }
      },

      openStats() {
        const self = this;
        this.stats = null;
        this.statsLoading = true;
        const modalEl = document.getElementById('statsModal');
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
        fetch('/api/stats')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            self.stats = data;
            self.statsLoading = false;
            if (data.hourly && data.hourly.length)
              self.statsMaxHourly = Math.max.apply(null, data.hourly.map(function(h){ return +h.count; })) || 1;
            if (data.dow && data.dow.length) {
              var occ = self._statsDowOcc();
              self.statsMaxDow = Math.max.apply(null, data.dow.map(function(d){ return Math.round(+d.count / (occ[+d.dow] || 1)); })) || 1;
            }
            setTimeout(function() { self._initModalDailyChart(data.daily || []); }, 50);
          })
          .catch(function() { self.statsLoading = false; });
      },

      statsBarWidth(count) {
        return this.statsMaxHourly ? Math.round(+count / this.statsMaxHourly * 100) : 0;
      },

      _statsDowOcc() {
        var occ = [0,0,0,0,0,0,0];
        var today = new Date(); today.setHours(0,0,0,0);
        for (var i = 0; i < 31; i++) {
          var dt = new Date(today); dt.setDate(dt.getDate() - i);
          occ[dt.getDay()]++;
        }
        return occ;
      },

      statsDowAvg(dow, count) {
        var occ = this._statsDowOcc();
        return Math.round(+count / (occ[+dow] || 1));
      },

      statsDowWidth(dow, count) {
        var avg = this.statsDowAvg(dow, count);
        return this.statsMaxDow ? Math.round(avg / this.statsMaxDow * 100) : 0;
      },

      statsPadHour(h) { return ('0' + h).slice(-2) + ':00'; },
      statsDowName(d)  { return ['Zo','Ma','Di','Wo','Do','Vr','Za'][+d] || d; },

      statsFormatDay(dateStr) {
        if (!dateStr) return '-';
        return new Date(dateStr + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      },

      statsGetBusiestDay() {
        if (!this.stats || !this.stats.daily || !this.stats.daily.length) return null;
        return this.stats.daily.reduce(function(max, d) { return +d.count > +max.count ? d : max; }, this.stats.daily[0]);
      },

      statsGetAvgPerDay() {
        if (!this.stats || !this.stats.daily || !this.stats.daily.length) return null;
        var total = this.stats.daily.reduce(function(s, d) { return s + +d.count; }, 0);
        return Math.round(total / this.stats.daily.length);
      },

      statsGetWeekTrend() {
        if (!this.stats || !this.stats.daily || this.stats.daily.length < 8) return null;
        var sorted = this.stats.daily.slice().sort(function(a, b) { return a.day < b.day ? -1 : 1; });
        var last7 = sorted.slice(-7).reduce(function(s, d) { return s + +d.count; }, 0);
        var prev7 = sorted.slice(-14, -7).reduce(function(s, d) { return s + +d.count; }, 0);
        if (!prev7) return null;
        return Math.round((last7 - prev7) / prev7 * 100);
      },

      _initModalDailyChart(daily) {
        const canvas = document.getElementById('statsModalDailyChart');
        if (!canvas || typeof Chart === 'undefined') return;
        if (this._statsModalChart) { this._statsModalChart.destroy(); this._statsModalChart = null; }
        const counts = {};
        daily.forEach(function(d) { counts[d.day] = +d.count; });
        const labels = [], data = [], colors = [];
        // Zoek drukste dag voor markering
        const busiest = daily.length
          ? daily.reduce(function(m, d) { return +d.count > +m.count ? d : m; }, daily[0]).day
          : null;
        const today = new Date(); today.setHours(0,0,0,0);
        for (let i = 30; i >= 0; i--) {
          const dt = new Date(today); dt.setDate(dt.getDate() - i);
          const key = dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
          labels.push(i === 0 ? 'Vnd' : dt.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }));
          data.push(counts[key] || 0);
          colors.push(key === busiest ? 'rgba(248,113,113,0.85)' : 'rgba(59,130,246,0.65)');
        }
        const isDark = !document.documentElement.classList.contains('light-theme');
        const textColor = isDark ? '#a0aec0' : '#555555';
        const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
        this._statsModalChart = new Chart(canvas, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{
              label: 'Berichten', data: data,
              backgroundColor: colors,
              borderColor: colors.map(function(c){ return c.replace('0.65','1').replace('0.85','1'); }),
              borderWidth: 1, borderRadius: 3
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
            scales: {
              x: { ticks: { color: textColor, maxRotation: 45, font: { size: 9 } }, grid: { color: gridColor } },
              y: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } }
            }
          }
        });
      },

      aliasFilterUrl(cap) {
        if (cap.alias_id) {
          let url = '/?alias=' + encodeURIComponent(cap.alias_id);
          if (cap.alias) url += '&aliasName=' + encodeURIComponent(cap.alias);
          return url;
        }
        return '/?address=' + encodeURIComponent(cap.address);
      },

      noLeadingZeros: noLeadingZeros,
      badgeTextColor: badgeTextColor,
      applyHighlight: applyHighlight,

      _playBeep() {
        try {
          const ctx = getAudioCtx();
          if (!ctx) return;
          const doPlay = function() {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            gain.gain.setValueAtTime(0.85, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.4);
          };
          if (ctx.state === 'suspended') ctx.resume().then(doPlay).catch(function() {});
          else doPlay();
        } catch(e) {}
      },

      _iosUnlockHandler() {
        const ctx = getAudioCtx();
        if (!ctx) return;
        try {
          const buf = ctx.createBuffer(1, 1, 22050);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
          if (ctx.state === 'suspended') ctx.resume().catch(function() {});
        } catch(e) {}
      },

      _enableIosUnlock() {
        if (this._iosUnlockActive) return;
        this._iosUnlockActive = true;
        // Store one stable bound reference so removeEventListener can find it later.
        if (!this._iosUnlockBound) this._iosUnlockBound = this._iosUnlockHandler.bind(this);
        ['touchstart', 'touchend', 'click', 'keydown'].forEach((evt) => {
          window.addEventListener(evt, this._iosUnlockBound, { passive: true, capture: true });
        });
      },

      _disableIosUnlock() {
        this._iosUnlockActive = false;
        if (!this._iosUnlockBound) return;
        ['touchstart', 'touchend', 'click', 'keydown'].forEach((evt) => {
          window.removeEventListener(evt, this._iosUnlockBound, { capture: true });
        });
      },

      destroy() {
        if (this._autoRefreshTimer) { clearInterval(this._autoRefreshTimer); this._autoRefreshTimer = null; }
        if (this._relativeTimeTimer) { clearInterval(this._relativeTimeTimer); this._relativeTimeTimer = null; }
        if (this._fetchController) { this._fetchController.abort(); this._fetchController = null; }
        if (this._socket) { this._socket.disconnect(); this._socket = null; }
        this._disableIosUnlock();
        if (this._statsModalChart) { this._statsModalChart.destroy(); this._statsModalChart = null; }
        if (this._visibilityHandler) { document.removeEventListener('visibilitychange', this._visibilityHandler); this._visibilityHandler = null; }
        if (this._pdwHandler) { window.removeEventListener('pdwModeChange', this._pdwHandler); this._pdwHandler = null; }
        if (this._sneakpeekHandler) { window.removeEventListener('sneakpeekChange', this._sneakpeekHandler); this._sneakpeekHandler = null; }
      }
    }));
  });

  // Helper functions
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? m[1] : null;
  }

  function _fallbackCopy(text) {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed'; el.style.opacity = '0';
      document.body.appendChild(el);
      el.focus(); el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    } catch(e) {}
  }

  function groupMessages(msgs) {
    const result = [];
    const groupMap = {};
    msgs.forEach(function(msg) {
      const key = msg.timestamp + '|' + msg.message;
      if (msg.isFlexGroup) {
        if (groupMap[key]) {
          groupMap[key].capcodes.push({ id: msg.id, address: msg.address, alias: msg.alias, alias_id: msg.alias_id, agency: msg.agency, icon: msg.icon, color: msg.color });
        } else {
          msg.capcodes = [{ id: msg.id, address: msg.address, alias: msg.alias, alias_id: msg.alias_id, agency: msg.agency, icon: msg.icon, color: msg.color }];
          groupMap[key] = msg;
          result.push(msg);
        }
      } else {
        msg.capcodes = [{ id: msg.id, address: msg.address, alias: msg.alias, alias_id: msg.alias_id, agency: msg.agency, icon: msg.icon, color: msg.color }];
        result.push(msg);
      }
    });
    result.forEach(function(msg) {
      if (msg.capcodes && msg.capcodes.length > 1) {
        msg.capcodes.sort(function(a, b) { return isNationalCode(a.address) - isNationalCode(b.address); });
      }
    });
    return result;
  }

  // Helper: converteer VAPID public key (URL-safe base64) naar Uint8Array
  // Chrome/Firefox vereisen Uint8Array — een string als applicationServerKey geeft
  // een InvalidAccessError bij PushManager.subscribe()
  function _urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var output  = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
    return output;
  }

  // Service Worker registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function(err) {
      console.warn('PagerMon: Service Worker registratie mislukt —', err.message || err);
    });
  }
})();
