// ==UserScript==
// @name         Faction Fight Stat Logger & Loadout Intel
// @namespace    https://github.com
// @version      1.3.7
// @description  Robust Torn profile UI that stays visible on Torn PDA/profile pages, with backend fallback when live logs are unavailable.
// @author       92gthrbg88-eng
// @match        https://www.torn.com/loader.php?sid=attack*
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/factions.php*
// @match        https://*.torn.com/loader.php?sid=attack*
// @match        https://*.torn.com/profiles.php*
// @match        https://*.torn.com/factions.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      faction-intel.thn25tvjtb.workers.dev
// @updateURL    https://raw.githubusercontent.com/92gthrbg88-eng/faction-stat-logger/main/faction-stat-logger.user.js
// @downloadURL  https://raw.githubusercontent.com/92gthrbg88-eng/faction-stat-logger/main/faction-stat-logger.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://faction-intel.thn25tvjtb.workers.dev';
    const FACTION_TOKEN = 'HeartBreakers2026!SecretKey';
    const pageUrl = new URL(window.location.href);
    const isAttackPage = /loader\.php\?sid=attack/i.test(pageUrl.href) || pageUrl.searchParams.get('sid') === 'attack';
    const isProfilePage = /profiles\.php/i.test(pageUrl.href) || /profiles\.php/i.test(pageUrl.pathname);
    const isFactionPage = /factions\.php/i.test(pageUrl.href) || /factions\.php/i.test(pageUrl.pathname);

    function getApiKey() {
        let key = String(GM_getValue('torn_api_key', '') || '').trim();
        if (!key) {
            try {
                key = String(prompt('Faction Stat Logger: Enter your Torn Limited Access API Key (stored locally only):') || '').trim();
            } catch (_) {
                key = '';
            }
            if (key) GM_setValue('torn_api_key', key);
        }
        return key;
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
        const candidates = [
            ['Str Build', Number(stats.str) || 0],
            ['Def Tank', Number(stats.def) || 0],
            ['Spd Build', Number(stats.spd) || 0],
            ['Dex Build', Number(stats.dex) || 0]
        ].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
        if (candidates.length < 2) return 'Partial Intel';
        return candidates[0][1] >= candidates[1][1] * 1.6 ? candidates[0][0] : 'Balanced';
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
                width: min(320px, calc(100vw - 24px));
                max-height: 55vh;
                overflow: auto;
                z-index: 2147483647;
                background: rgba(18, 18, 18, 0.96);
                color: #f1f1f1;
                border: 1px solid #4caf50;
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
                font-family: Arial, sans-serif;
                padding: 10px 12px;
                box-sizing: border-box;
            }
            #fsl-profile-panel h3 {
                margin: 0 0 8px;
                color: #a5d6a7;
                font-size: 14px;
            }
            #fsl-profile-panel p {
                margin: 6px 0;
                line-height: 1.4;
                font-size: 12px;
            }
            #fsl-profile-panel .fsl-muted {
                color: #aaa;
                font-size: 11px;
            }
            #fsl-profile-panel .fsl-section {
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 6px;
                padding: 8px 10px;
                margin-bottom: 8px;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
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

    function onDocumentReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
        } else {
            callback();
        }
    }

    function backendRequest(options) {
        GM_xmlhttpRequest({
            ...options,
            headers: { ...(options.headers || {}), 'X-Faction-Token': FACTION_TOKEN },
            onerror: options.onerror || (() => {}),
            ontimeout: options.ontimeout || (() => {})
        });
    }

    function parseJson(text) {
        try { return JSON.parse(text); } catch (_) { return null; }
    }

    function getBattleHistorySummary(playerId) {
        const apiKey = getApiKey();
        if (!apiKey || !playerId) return Promise.resolve(null);

        return fetch(`https://api.torn.com/user/?selections=attacks&key=${encodeURIComponent(apiKey)}`, {
            cache: 'no-store'
        })
            .then(response => response.ok ? response.json() : null)
            .then(data => {
                if (!data || data.error || !data.attacks) return null;

                const attacks = Object.values(data.attacks).filter(entry => {
                    if (!entry) return false;
                    const defenderId = Number(entry.defender_id || entry.defenderId || entry.target_id || entry.targetId || 0);
                    const attackerId = Number(entry.attacker_id || entry.attackerId || 0);
                    const targetId = Number(playerId);
                    return defenderId === targetId || attackerId === targetId;
                });

                if (!attacks.length) return null;

                const wins = attacks.filter(entry => {
                    const result = String(entry.result || entry.outcome || entry.status || '');
                    return /win|won|victory|success|killed|defeated/i.test(result);
                }).length;

                const losses = attacks.filter(entry => {
                    const result = String(entry.result || entry.outcome || entry.status || '');
                    return /loss|lost|failed|escaped|missed/i.test(result);
                }).length;

                const totalDamage = attacks.reduce((sum, entry) => {
                    const val = Number(entry.damage || entry.damage_done || entry.damageDealt || 0);
                    return sum + (Number.isFinite(val) ? val : 0);
                }, 0);

                const latest = attacks.slice().sort((a, b) => (Number(b.timestamp || b.time || 0) || 0) - (Number(a.timestamp || a.time || 0) || 0))[0];
                const latestResult = latest && (latest.result || latest.outcome || latest.status || 'Battle history');
                const lastSeen = latest && (latest.timestamp || latest.time) ? new Date(Number(latest.timestamp || latest.time) * 1000).toLocaleString() : 'Unknown';

                return {
                    count: attacks.length,
                    wins,
                    losses,
                    totalDamage,
                    lastSeen,
                    latestResult
                };
            })
            .catch(() => null);
    }

    function installProfileUi() {
        const targetId = new URLSearchParams(window.location.search).get('XID');
        ensureProfilePanel();

        if (!targetId) {
            writeProfileInfo(
                'Could not determine profile ID.',
                'The profile page can’t be matched to a player.',
                'No player ID detected.',
                'Torn profile is missing XID.'
            );
            return;
        }

        const query = new URLSearchParams({ id: targetId });
        backendRequest({
            method: 'GET',
            url: `${API_BASE}/stats?${query}`,
            onload: async response => {
                if (response.status < 200 || response.status >= 300) {
                    const fallback = await getBattleHistorySummary(targetId);
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
                        'Intel service unavailable.',
                        'Panels remain visible while the backend is offline.',
                        'No live loadout data.',
                        'The service may be temporarily unavailable.'
                    );
                    return;
                }

                const data = parseJson(response.responseText);
                if (!data) {
                    const fallback = await getBattleHistorySummary(targetId);
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
                        'Intel service returned unreadable data.',
                        'Panels remain visible while data is missing.',
                        'No valid loadout data.',
                        'The backend may be unavailable.'
                    );
                    return;
                }

                const hasLiveStats = !!(Number(data.bss) || Number(data.str) || Number(data.def) || Number(data.spd) || Number(data.dex) || Number(data.samples));
                if (!hasLiveStats) {
                    const fallback = await getBattleHistorySummary(targetId);
                    if (fallback) {
                        writeProfileInfo(
                            `Recent fights: ${fallback.count} · Wins ${fallback.wins} · Losses ${fallback.losses} · Damage ${formatNumber(fallback.totalDamage)}`,
                            'No current logs available — using Torn attack history.',
                            `Last result: ${fallback.latestResult || 'No recent result captured.'}`,
                            fallback.lastSeen ? `Last seen: ${fallback.lastSeen}` : 'No historical battle records found.'
                        );
                        return;
                    }
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
                const fallback = await getBattleHistorySummary(targetId);
                if (fallback) {
                    writeProfileInfo(
                        `Recent fights: ${fallback.count} · Wins ${fallback.wins} · Losses ${fallback.losses} · Damage ${formatNumber(fallback.totalDamage)}`,
                        'Could not connect to intel service — using Torn attack history.',
                        `Last result: ${fallback.latestResult || 'No recent result captured.'}`,
                        fallback.lastSeen ? `Last seen: ${fallback.lastSeen}` : 'No historical battle records found.'
                    );
                    return;
                }
                writeProfileInfo(
                    'Could not connect to intel service.',
                    'Panels remain visible while the service is unavailable.',
                    'No loadout data available.',
                    'Check your API access or backend availability.'
                );
            }
        });
    }

    function installProfileObserver() {
        const root = document.body || document.documentElement;
        if (!root) return;

        const observer = new MutationObserver(() => {
            if (isProfilePage) ensureProfilePanel();
        });

        observer.observe(root, { childList: true, subtree: true });
    }

    if (isProfilePage) {
        onDocumentReady(() => {
            ensureProfilePanel();
            installProfileObserver();
            installProfileUi();
            setInterval(() => {
                ensureProfilePanel();
            }, 2000);
        });
    }

    if (isFactionPage) {
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
            document.querySelectorAll(`.fsl-roster-badge[data-fsl-id="${id}"]`).forEach(badge => {
                if (!stats || (!stats.bss && !stats.str && !stats.def && !stats.spd && !stats.dex)) {
                    badge.textContent = 'Faction Intel · no data';
                    badge.title = 'No faction intel report is available yet.';
                    return;
                }
                badge.textContent = `BSS ${formatNumber(stats.bss)} · ${archetype(stats)}`;
                const gear = stats.loadout || {};
                badge.title = `Faction Intel (${stats.samples || 1} reports)\nSTR ${formatNumber(stats.str)} | DEF ${formatNumber(stats.def)}\nSPD ${formatNumber(stats.spd)} | DEX ${formatNumber(stats.dex)}\nGear: ${[gear.primary, gear.melee, gear.temporary].filter(Boolean).join(', ') || 'Unknown'}`;
            });
        }

        function scanRoster() {
            const newIds = [];
            document.querySelectorAll('a[href*="profiles.php?XID="]').forEach(link => {
                let id;
                try { id = new URL(link.href, location.href).searchParams.get('XID'); } catch (_) { return; }
                if (!id || !/^\d+$/.test(id)) return;
                badgeFor(link, id);
                if (!pendingIds.has(id)) {
                    pendingIds.add(id);
                    newIds.push(id);
                }
            });
            if (newIds.length) fetchRosterStats(newIds);
        }

        function fetchRosterStats(ids) {
            for (let index = 0; index < ids.length; index += 50) {
                const batch = ids.slice(index, index + 50);
                backendRequest({
                    method: 'POST',
                    url: `${API_BASE}/stats-batch`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ ids: batch }),
                    onload: response => {
                        const map = response.status >= 200 && response.status < 300 ? parseJson(response.responseText) : null;
                        batch.forEach(id => paintBadge(id, map && map[id]));
                    },
                    onerror: () => batch.forEach(id => paintBadge(id, null))
                });
            }
        }

        onDocumentReady(() => {
            scanRoster();
            const observer = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(scanRoster, 300);
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    // Attack page: capture fight data and keep the script working without UI.
    if (isAttackPage) {
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
            ['primary', 'secondary', 'melee', 'temporary'].forEach(slot => {
                if (items[slot] && items[slot].name) state.loadout[slot] = items[slot].name;
            });
            if (Array.isArray(defender.armor)) {
                state.loadout.armor = defender.armor.map(item => item && (item.name || item)).filter(Boolean);
            } else if (defender.armor && typeof defender.armor === 'object') {
                state.loadout.armor = Object.values(defender.armor).map(item => item && item.name).filter(Boolean);
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

        async function uploadReport() {
            try {
                const apiKey = getApiKey();
                if (!apiKey || !state.opponentId) return;
                const response = await fetch(`https://api.torn.com/user/?selections=basic,battlestats&key=${encodeURIComponent(apiKey)}`);
                const data = await response.json();
                if (!response.ok || data.error || !Number.isFinite(Number(data.strength))) return;

                const myBss = ['strength', 'defense', 'speed', 'dexterity'].reduce((sum, key) => sum + Math.sqrt(Number(data[key]) || 0), 0);
                const estimatedBss = state.fairFight > 1 && state.fairFight < 3 ? (3 / 8) * (state.fairFight - 1) * myBss : null;
                const estimatedDef = estimateDefense(Number(data.strength), state.myDamage);
                const estimatedDex = estimateDexterity(Number(data.speed), state.mySwings, state.myHits);
                const estimatedSpd = estimateSpeed(Number(data.dexterity), state.opponentSwings, state.opponentHits);
                const estimatedStr = estimateStrength(state.opponentDamage);
                const report = {
                    targetId: state.opponentId,
                    targetName: state.opponentName,
                    reporterId: data.player_id,
                    factionId: data.faction && data.faction.faction_id || 0,
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
                backendRequest({ method: 'POST', url: `${API_BASE}/log`, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(report) });
            } catch (error) {
                console.warn('[FSL] Report upload failed:', error);
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
                    state.opponentSwings++;
                    if (hits) state.opponentHits++;
                    if (hits && Number(entry.damage) > 0) state.opponentDamage.push(Number(entry.damage));
                } else {
                    state.mySwings++;
                    if (hits) state.myHits++;
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

        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            try {
                const requestUrl = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url || '';
                if (requestUrl.includes('sid=attackData')) {
                    response.clone().json().then(parseAttackPayload).catch(() => {});
                }
            } catch (_) {
                // Do not interfere with Torn's request.
            }
            return response;
        };
    }
})();
