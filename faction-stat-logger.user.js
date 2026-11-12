// ==UserScript==
// @name         Faction Stat Logger
// @namespace    https://github.com/92gthrbg88-eng/faction-stat-logger
// @version      1.4.0
// @description  Torn profile UI that stays visible, never prompts for a key, and falls back to battle history when server stats are missing.
// @author       92gthrbg88-eng
// @match        https://*.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      faction-intel.thn25tvjtb.workers.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://faction-intel.thn25tvjtb.workers.dev';
    const FACTION_TOKEN = 'HeartBreakers2026!SecretKey';
    const STORAGE_KEY = 'fsl_torn_api_key';

    function safeGetStorage() {
        try {
            return window.localStorage || null;
        } catch (_) {
            return null;
        }
    }

    function getApiKey() {
        const candidates = [];
        try {
            if (typeof GM_getValue === 'function') {
                candidates.push(String(GM_getValue(STORAGE_KEY, '') || ''));
            }
        } catch (_) {}

        try {
            if (window && window.__FSL_API_KEY__) {
                candidates.push(String(window.__FSL_API_KEY__ || ''));
            }
        } catch (_) {}

        const storage = safeGetStorage();
        if (storage) {
            candidates.push(String(storage.getItem(STORAGE_KEY) || ''));
        }

        for (const candidate of candidates) {
            const value = String(candidate || '').trim();
            if (value) return value;
        }

        return '';
    }

    function setApiKey(value) {
        const clean = String(value || '').trim();
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(STORAGE_KEY, clean);
            }
        } catch (_) {}

        const storage = safeGetStorage();
        if (storage) {
            try {
                if (clean) storage.setItem(STORAGE_KEY, clean);
                else storage.removeItem(STORAGE_KEY);
            } catch (_) {}
        }
    }

    function formatNumber(value) {
        const number = Number(value);
        if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return '—';
        if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
        if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
        if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
        return Math.round(number).toLocaleString();
    }

    function archetype(stats = {}) {
        const entries = [
            ['Str Build', Number(stats.str) || 0],
            ['Def Tank', Number(stats.def) || 0],
            ['Spd Build', Number(stats.spd) || 0],
            ['Dex Build', Number(stats.dex) || 0]
        ].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);

        if (entries.length < 2) return 'Partial Intel';
        return entries[0][1] >= entries[1][1] * 1.6 ? entries[0][0] : 'Balanced';
    }

    function addStyles() {
        if (document.getElementById('fsl-styles')) return;

        const style = document.createElement('style');
        style.id = 'fsl-styles';
        style.textContent = `
            #fsl-profile-panel {
                position: fixed;
                top: 80px;
                right: 12px;
                width: min(330px, calc(100vw - 24px));
                max-height: 55vh;
                overflow: auto;
                z-index: 2147483647;
                background: rgba(14, 16, 18, 0.96);
                color: #f5f5f5;
                border: 1px solid #5aae6c;
                border-radius: 8px;
                box-shadow: 0 8px 28px rgba(0,0,0,0.45);
                font-family: Arial, sans-serif;
                padding: 10px 12px;
                box-sizing: border-box;
            }

            #fsl-profile-panel h3 {
                margin: 0 0 8px;
                color: #b8efbd;
                font-size: 14px;
                font-weight: 700;
            }

            #fsl-profile-panel p {
                margin: 6px 0;
                font-size: 12px;
                line-height: 1.4;
            }

            #fsl-profile-panel .fsl-muted {
                color: #c8c8c8;
                font-size: 11px;
            }

            #fsl-profile-panel .fsl-section {
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 6px;
                padding: 8px 10px;
                margin-bottom: 8px;
            }

            .fsl-roster-badge {
                display: inline-block;
                margin-left: 8px;
                padding: 2px 6px;
                border-radius: 4px;
                background: rgba(74, 174, 117, 0.2);
                color: #dff7e4;
                font-size: 10px;
                line-height: 1.4;
                vertical-align: middle;
            }
        `;

        const parent = document.head || document.documentElement;
        if (parent) parent.appendChild(style);
    }

    function ensureProfilePanel() {
        let panel = document.getElementById('fsl-profile-panel');
        if (panel) return panel;

        addStyles();
        const root = document.body || document.documentElement;
        if (!root) return null;

        panel = document.createElement('div');
        panel.id = 'fsl-profile-panel';
        panel.innerHTML = `
            <div class="fsl-section">
                <h3>Faction Intel</h3>
                <p id="fsl-main-text">Waiting for profile data…</p>
                <p id="fsl-main-note" class="fsl-muted">Profile intel will appear here.</p>
            </div>
            <div class="fsl-section">
                <h3>Faction Intel Loadout</h3>
                <p id="fsl-loadout-text">No loadout yet.</p>
                <p id="fsl-loadout-note" class="fsl-muted">Loadout data will appear here.</p>
            </div>
        `;
        root.appendChild(panel);
        return panel;
    }

    function writeProfileInfo(mainText, mainNote, loadoutText, loadoutNote) {
        const panel = ensureProfilePanel();
        if (!panel) return;

        const mainTextNode = document.getElementById('fsl-main-text');
        const mainNoteNode = document.getElementById('fsl-main-note');
        const loadoutTextNode = document.getElementById('fsl-loadout-text');
        const loadoutNoteNode = document.getElementById('fsl-loadout-note');

        if (mainTextNode) mainTextNode.textContent = mainText;
        if (mainNoteNode) mainNoteNode.textContent = mainNote;
        if (loadoutTextNode) loadoutTextNode.textContent = loadoutText;
        if (loadoutNoteNode) loadoutNoteNode.textContent = loadoutNote;
    }

    function parseJson(text) {
        try {
            return JSON.parse(text);
        } catch (_) {
            return null;
        }
    }

    function requestBackend(options) {
        if (typeof GM_xmlhttpRequest !== 'function') {
            if (options.onerror) options.onerror(new Error('GM_xmlhttpRequest unavailable'));
            return;
        }

        GM_xmlhttpRequest({
            ...options,
            headers: {
                ...(options.headers || {}),
                'X-Faction-Token': FACTION_TOKEN
            }
        });
    }

    function getBattleHistorySummary(playerId, apiKey) {
        if (!apiKey || !playerId) return Promise.resolve(null);

        return fetch(`https://api.torn.com/user/?selections=attacks&key=${encodeURIComponent(apiKey)}`, {
            cache: 'no-store'
        })
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
                if (!data || data.error || !data.attacks) return null;

                const attacks = Object.values(data.attacks).filter((entry) => {
                    if (!entry) return false;
                    const defenderId = Number(entry.defender_id || entry.defenderId || entry.target_id || entry.targetId || 0);
                    const attackerId = Number(entry.attacker_id || entry.attackerId || 0);
                    const targetId = Number(playerId);
                    return defenderId === targetId || attackerId === targetId;
                });

                if (!attacks.length) return null;

                const wins = attacks.filter((entry) => /win|won|victory|success|killed|defeated/i.test(String(entry.result || entry.outcome || entry.status || ''))).length;
                const losses = attacks.filter((entry) => /loss|lost|failed|escaped|missed/i.test(String(entry.result || entry.outcome || entry.status || ''))).length;
                const totalDamage = attacks.reduce((sum, entry) => sum + (Number(entry.damage || entry.damage_done || entry.damageDealt || 0) || 0), 0);
                const latest = attacks.slice().sort((a, b) => (Number(b.timestamp || b.time || 0) || 0) - (Number(a.timestamp || a.time || 0) || 0))[0];
                const latestResult = latest && (latest.result || latest.outcome || latest.status || 'Battle history');
                const lastSeen = latest && (latest.timestamp || latest.time) ? new Date(Number(latest.timestamp || latest.time) * 1000).toLocaleString() : 'Unknown';

                return {
                    count: attacks.length,
                    wins,
                    losses,
                    totalDamage,
                    latestResult,
                    lastSeen
                };
            })
            .catch(() => null);
    }

    function isProfilePage() {
        const href = window.location.href || '';
        return /profiles\.php/i.test(href) || /\/profiles\.php/i.test(window.location.pathname || '');
    }

    function isFactionPage() {
        const href = window.location.href || '';
        return /factions\.php/i.test(href) || /\/factions\.php/i.test(window.location.pathname || '');
    }

    function isAttackPage() {
        const href = window.location.href || '';
        return /loader\.php\?sid=attack/i.test(href) || /\/loader\.php\?sid=attack/i.test(href) || (new URLSearchParams(window.location.search || '')).get('sid') === 'attack';
    }

    function getProfileIdFromUrl() {
        const qs = new URLSearchParams(window.location.search || '');
        const direct = qs.get('XID') || qs.get('userID') || qs.get('id');
        if (direct && /^\d+$/.test(String(direct))) return String(direct);

        const hash = (window.location.hash || '').match(/[?&]XID=(\d+)/i);
        if (hash && hash[1]) return hash[1];

        const path = window.location.pathname || '';
        const fromPath = path.match(/profiles\.php\/?(\d+)/i);
        if (fromPath && fromPath[1]) return fromPath[1];

        return null;
    }

    async function renderProfileFallback(targetId, apiKey) {
        const fallback = apiKey ? await getBattleHistorySummary(targetId, apiKey) : null;

        if (fallback) {
            writeProfileInfo(
                `Recent fights: ${fallback.count} · Wins ${fallback.wins} · Losses ${fallback.losses} · Damage ${formatNumber(fallback.totalDamage)}`,
                'No current logs available — using Torn attack history.',
                `Last result: ${fallback.latestResult || 'No recent result captured.'}`,
                fallback.lastSeen ? `Last seen: ${fallback.lastSeen}` : 'No historical battle records found.'
            );
            return;
        }

        writeProfileInfo(
            'No combat intel available.',
            'The panel remains visible, but there is no cached data yet.',
            'No live loadout data.',
            'Check the Torn API key or backend status.'
        );
    }

    function installProfileUi() {
        const id = getProfileIdFromUrl();
        const apiKey = getApiKey();
        ensureProfilePanel();

        if (!id) {
            writeProfileInfo(
                'Could not determine profile ID.',
                'The profile page is missing a valid XID.',
                'No player ID detected.',
                'Profile data cannot be resolved.'
            );
            return;
        }

        requestBackend({
            method: 'GET',
            url: `${API_BASE}/stats?id=${encodeURIComponent(id)}`,
            onload: async (response) => {
                if (response.status < 200 || response.status >= 300) {
                    await renderProfileFallback(id, apiKey);
                    return;
                }

                const data = parseJson(response.responseText);
                if (!data) {
                    await renderProfileFallback(id, apiKey);
                    return;
                }

                const hasLiveStats = !!(Number(data.bss) || Number(data.str) || Number(data.def) || Number(data.spd) || Number(data.dex) || Number(data.samples));
                if (!hasLiveStats) {
                    await renderProfileFallback(id, apiKey);
                    return;
                }

                const updated = data.updatedAt ? new Date(data.updatedAt * 1000).toLocaleDateString() : 'unknown';
                writeProfileInfo(
                    `Build: ${archetype(data)} · BSS: ${formatNumber(data.bss)} · STR: ${formatNumber(data.str)} · DEF: ${formatNumber(data.def)} · SPD: ${formatNumber(data.spd)} · DEX: ${formatNumber(data.dex)}`,
                    `Reports: ${formatNumber(data.samples || 0)} · Last updated: ${updated}`,
                    `Primary: ${data.loadout?.primary || 'Unknown'} · Secondary: ${data.loadout?.secondary || 'Unknown'} · Melee: ${data.loadout?.melee || 'Unknown'} · Temporary: ${data.loadout?.temporary || 'Unknown'}`,
                    data.updatedAt ? `Last seen: ${updated}` : 'No dated loadout report available.'
                );
            },
            onerror: async () => {
                await renderProfileFallback(id, apiKey);
            }
        });
    }

    function installProfileObserver() {
        const root = document.body || document.documentElement;
        if (!root) return;

        const observer = new MutationObserver(() => {
            if (isProfilePage()) {
                ensureProfilePanel();
            }
        });

        observer.observe(root, { childList: true, subtree: true });
    }

    function installFactionUi() {
        const pendingIds = new Set();
        let timer = null;

        function badgeFor(link, id) {
            let badge = link.parentElement && link.parentElement.querySelector(`.fsl-roster-badge[data-fsl-id="${id}"]`);
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'fsl-roster-badge';
                badge.dataset.fslId = id;
                badge.textContent = 'Faction Intel · no data';
                badge.title = 'No faction intel report is available yet.';
                link.insertAdjacentElement('afterend', badge);
            }
            return badge;
        }

        function paintBadge(id, stats) {
            document.querySelectorAll(`.fsl-roster-badge[data-fsl-id="${id}"]`).forEach((badge) => {
                if (!stats || (!stats.bss && !stats.str && !stats.def && !stats.spd && !stats.dex)) {
                    badge.textContent = 'Faction Intel · no data';
                    badge.title = 'No faction intel report is available yet.';
                    return;
                }

                badge.textContent = `BSS ${formatNumber(stats.bss)} · ${archetype(stats)}`;
                const gear = stats.loadout || {};
                badge.title = `Faction Intel (${stats.samples || 1} reports)\nSTR ${formatNumber(stats.str)} | DEF ${formatNumber(stats.def)}\nSPD ${formatNumber(stats.spd)} | DEX ${formatNumber(stats.dex)}\nPrimary ${gear.primary || 'Unknown'} | Secondary ${gear.secondary || 'Unknown'}`;
            });
        }

        function fetchRosterStats(ids) {
            for (let i = 0; i < ids.length; i += 50) {
                const batch = ids.slice(i, i + 50);
                requestBackend({
                    method: 'POST',
                    url: `${API_BASE}/stats-batch`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ ids: batch }),
                    onload: (response) => {
                        const map = response.status >= 200 && response.status < 300 ? parseJson(response.responseText) : null;
                        batch.forEach((id) => paintBadge(id, map && map[id]));
                    },
                    onerror: () => batch.forEach((id) => paintBadge(id, null))
                });
            }
        }

        function scanRoster() {
            const newIds = [];
            document.querySelectorAll('a[href*="profiles.php?XID="]').forEach((link) => {
                let id = null;
                try {
                    id = new URL(link.href, location.href).searchParams.get('XID');
                } catch (_) {
                    return;
                }

                if (!id || !/^\d+$/.test(id)) return;
                badgeFor(link, id);
                if (!pendingIds.has(id)) {
                    pendingIds.add(id);
                    newIds.push(id);
                }
            });

            if (newIds.length) fetchRosterStats(newIds);
        }

        scanRoster();
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(scanRoster, 250);
        });

        const target = document.body || document.documentElement;
        if (target) {
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    function installAttackWatcher() {
        const state = {
            opponentId: null,
            opponentName: null,
            mySwings: 0,
            myHits: 0,
            myDamage: [],
            opponentSwings: 0,
            opponentHits: 0,
            opponentDamage: [],
            loadout: { primary: null, secondary: null, melee: null, temporary: null, armor: [] },
            fairFight: null,
            submitted: false,
            seenLogEntries: new Set()
        };

        function captureLoadout(db) {
            const defender = db.defenderUser || {};
            const items = defender.items || defender.weapons || {};
            ['primary', 'secondary', 'melee', 'temporary'].forEach((slot) => {
                if (items[slot] && items[slot].name) state.loadout[slot] = items[slot].name;
            });

            if (Array.isArray(defender.armor)) {
                state.loadout.armor = defender.armor.map((item) => item && (item.name || item)).filter(Boolean);
            } else if (defender.armor && typeof defender.armor === 'object') {
                state.loadout.armor = Object.values(defender.armor).map((item) => item && item.name).filter(Boolean);
            }
        }

        function parseAttackPayload(payload) {
            const db = payload && payload.DB;
            if (!db || state.submitted) return;

            if (db.defenderUser) {
                state.opponentId = Number(db.defenderUser.playerId) || null;
                state.opponentName = db.defenderUser.playername || null;
                captureLoadout(db);
            }

            (Array.isArray(db.fightLogs) ? db.fightLogs : []).forEach((entry, index) => {
                if (!entry || !entry.attackerId || !state.opponentId) return;
                const key = entry.logId || entry.id || `${entry.attackerId}:${entry.action}:${entry.weaponName || ''}:${entry.damage || ''}:${index}`;
                if (state.seenLogEntries.has(key)) return;
                state.seenLogEntries.add(key);

                const isOpponent = Number(entry.attackerId) === state.opponentId;
                if (isOpponent && entry.weaponName) {
                    const slot = { Primary: 'primary', Secondary: 'secondary', Melee: 'melee', Temporary: 'temporary' }[entry.weaponType];
                    if (slot) state.loadout[slot] = entry.weaponName;
                }

                if (entry.smoke || entry.tearGas || entry.flash) return;
                const hits = entry.action === 'hit' || entry.action === 'crit';
                if (!hits && entry.action !== 'miss') return;

                if (isOpponent) {
                    state.opponentSwings += 1;
                    if (hits) state.opponentHits += 1;
                    if (hits && Number(entry.damage) > 0) state.opponentDamage.push(Number(entry.damage));
                } else {
                    state.mySwings += 1;
                    if (hits) state.myHits += 1;
                    if (hits && Number(entry.damage) > 0) state.myDamage.push(Number(entry.damage));
                }
            });

            const fairFight = Number(db.currentFight && db.currentFight.modifiers && db.currentFight.modifiers.fairFight);
            if (Number.isFinite(fairFight) && fairFight >= 1) {
                state.fairFight = fairFight;
                state.submitted = true;
                uploadReport();
            }
        }

        async function uploadReport() {
            try {
                const key = getApiKey();
                if (!key || !state.opponentId) return;

                const response = await fetch(`https://api.torn.com/user/?selections=basic,battlestats&key=${encodeURIComponent(key)}`);
                const data = await response.json();
                if (!response.ok || data.error || !Number.isFinite(Number(data.strength))) return;

                const myBss = ['strength', 'defense', 'speed', 'dexterity'].reduce((sum, keyName) => sum + Math.sqrt(Number(data[keyName]) || 0), 0);
                const estimatedBss = state.fairFight > 1 && state.fairFight < 3 ? (3 / 8) * (state.fairFight - 1) * myBss : null;
                const estimatedDef = estimateDefense(Number(data.strength), state.myDamage);
                const estimatedDex = estimateDexterity(Number(data.speed), state.mySwings, state.myHits);
                const estimatedSpd = estimateSpeed(Number(data.dexterity), state.opponentSwings, state.opponentHits);
                const estimatedStr = estimateStrength(state.opponentDamage);

                const report = {
                    targetId: state.opponentId,
                    targetName: state.opponentName,
                    reporterId: data.player_id,
                    factionId: (data.faction && data.faction.faction_id) || 0,
                    fairFight: state.fairFight,
                    estimatedBss: estimatedBss ? Math.round(estimatedBss) : null,
                    estimatedStr: estimatedStr ? Math.round(estimatedStr) : null,
                    estimatedDef: estimatedDef ? Math.round(estimatedDef) : null,
                    estimatedSpd: estimatedSpd ? Math.round(estimatedSpd) : null,
                    estimatedDex: estimatedDex ? Math.round(estimatedDex) : null,
                    remainingStrSpdBss: estimatedBss && estimatedDef && estimatedDex ? Math.max(0, Math.round(estimatedBss - Math.sqrt(estimatedDef) - Math.sqrt(estimatedDex))) : null,
                    loadout: state.loadout,
                    sampleCounts: { mySwings: state.mySwings, oppSwings: state.opponentSwings },
                    timestamp: Math.floor(Date.now() / 1000)
                };

                requestBackend({
                    method: 'POST',
                    url: `${API_BASE}/log`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(report)
                });
            } catch (error) {
                console.warn('[FSL] Report upload failed:', error);
            }
        }

        function estimateDexterity(mySpeed, swings, hits) {
            if (swings < 3 || !(mySpeed > 0)) return null;
            const rate = Math.min(Math.max(hits / swings, 0.02), 0.98);
            return rate <= 0.5 ? mySpeed / Math.pow(rate / 0.5, 1 / 0.72) : mySpeed * Math.pow((1 - rate) / 0.5, 1 / 0.72);
        }

        function estimateSpeed(myDexterity, swings, hits) {
            if (swings < 3 || !(myDexterity > 0)) return null;
            const rate = Math.min(Math.max(hits / swings, 0.02), 0.98);
            return rate <= 0.5 ? myDexterity * Math.pow(rate / 0.5, 1 / 0.72) : myDexterity / Math.pow((1 - rate) / 0.5, 1 / 0.72);
        }

        function estimateDefense(myStrength, samples) {
            if (!samples.length || !(myStrength > 0)) return null;
            const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            const logStrength = Math.log10(Math.max(myStrength / 10, 1));
            const baseDamage = 7 * logStrength ** 2 + 27 * logStrength + 30;
            const unmitigated = baseDamage * 5 * 0.65;
            if (!(unmitigated > 0)) return null;
            const mitigation = Math.min(Math.max(1 - average / unmitigated, 0.01), 0.99);
            return mitigation >= 0.5 ? myStrength * 14 ** ((mitigation - 0.5) / 0.5) : myStrength / 32 ** ((0.5 - mitigation) / 0.5);
        }

        function estimateStrength(samples) {
            if (!samples.length) return null;
            const unmitigated = (samples.reduce((sum, value) => sum + value, 0) / samples.length) / (0.5 * 5 * 0.65);
            const c = 30 - unmitigated;
            const discriminant = 27 ** 2 - 4 * 7 * c;
            if (discriminant < 0) return null;
            const logStrength = (-27 + Math.sqrt(discriminant)) / 14;
            return 10 * 10 ** Math.max(logStrength, 0);
        }

        const originalFetch = window.fetch.bind(window);
        window.fetch = async function (...args) {
            const response = await originalFetch(...args);
            try {
                const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
                if (requestUrl.includes('sid=attackData')) {
                    response.clone().json().then(parseAttackPayload).catch(() => {});
                }
            } catch (_) {}
            return response;
        };
    }

    function installUi() {
        ensureProfilePanel();
        if (isProfilePage()) {
            installProfileUi();
            installProfileObserver();
        }

        if (isFactionPage()) {
            installFactionUi();
        }

        if (isAttackPage()) {
            installAttackWatcher();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installUi, { once: true });
    } else {
        installUi();
    }
})();
