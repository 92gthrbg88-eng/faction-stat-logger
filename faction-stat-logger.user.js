// ==UserScript==
// @name         Faction Fight Stat Logger & Loadout Intel
// @namespace    https://github.com
// @version      1.3.3
// @description  Logs combat estimates and defender equipment loadouts; keeps profile panels visible and falls back to Torn attack history when live logs are unavailable.
// @author       92gthrbg88-eng
// @match        https://www.torn.com/loader.php?sid=attack*
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/factions.php*
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
    const isAttackPage = pageUrl.searchParams.get('sid') === 'attack';
    const isProfilePage = pageUrl.pathname.endsWith('/profiles.php');
    const isFactionPage = pageUrl.pathname.endsWith('/factions.php');

    function getApiKey() {
        let key = String(GM_getValue('torn_api_key', '') || '').trim();
        if (!key) {
            key = String(prompt('Faction Stat Logger: Enter your Torn Limited Access API Key (stored locally only):') || '').trim();
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
            .fsl-panel{box-sizing:border-box;margin:10px 0;padding:12px;background:#222;border:1px solid #444;border-left:4px solid #4caf50;border-radius:5px;color:#eee;font:13px Arial,sans-serif}
            .fsl-panel h3{margin:0 0 8px;color:#a5d6a7;font-size:14px}
            .fsl-panel p{margin:4px 0;line-height:1.45}
            .fsl-panel .fsl-muted{color:#aaa;font-size:11px}
            .fsl-loadout{background:#292929}
            .fsl-roster-badge{display:inline-block;margin-left:6px;padding:2px 6px;background:#1e272e;border:1px solid #4caf50;border-radius:3px;color:#a5d6a7;font:11px Arial,sans-serif;vertical-align:middle;cursor:help}
            @media (max-width: 720px){
                .fsl-panel{margin:8px 0;padding:10px}
                .fsl-roster-badge{display:block;margin:6px 0 0}
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function findProfileHost() {
        const selectors = ['.profile-wrapper', '.profile-container', '.profile-content', '#profile-content', '.user-profile', 'main', 'body'];
        for (const selector of selectors) {
            const host = document.querySelector(selector);
            if (host) return host;
        }
        return document.body || document.documentElement;
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
        }).then(response => {
            if (!response.ok) return null;
            return response.json();
        }).then(data => {
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
                const value = Number(entry.damage || entry.damage_done || entry.damageDealt || 0);
                return sum + (Number.isFinite(value) ? value : 0);
            }, 0);
            const latest = attacks.slice().sort((a, b) => (Number(b.timestamp || b.time || 0) || 0) - (Number(a.timestamp || a.time || 0) || 0))[0];
            const fallbackLabel = latest && (latest.result || latest.outcome || latest.status || 'Battle history');
            const lastSeen = latest && (latest.timestamp || latest.time) ? new Date(Number(latest.timestamp || latest.time) * 1000).toLocaleString() : 'Unknown';

            return {
                count: attacks.length,
                wins,
                losses,
                totalDamage,
                lastSeen,
                latestResult: fallbackLabel
            };
        }).catch(() => null);
    }

    if (isProfilePage) {
        onDocumentReady(() => {
            addStyles();
            const targetId = pageUrl.searchParams.get('XID');
            const host = findProfileHost();

            const statsPanel = document.createElement('section');
            statsPanel.className = 'fsl-panel';
            statsPanel.id = 'fsl-profile-card';
            const statsTitle = document.createElement('h3');
            statsTitle.textContent = 'Faction Intel';
            const statsText = document.createElement('p');
            statsText.textContent = 'No stat reports available yet.';
            const statsNote = document.createElement('p');
            statsNote.className = 'fsl-muted';
            statsNote.textContent = 'Intel will appear here when the service has data.';
            statsPanel.append(statsTitle, statsText, statsNote);

            const gearPanel = document.createElement('section');
            gearPanel.className = 'fsl-panel fsl-loadout';
            gearPanel.id = 'fsl-loadout-card';
            const gearTitle = document.createElement('h3');
            gearTitle.textContent = 'Faction Intel Loadout';
            const gearText = document.createElement('p');
            gearText.textContent = 'No loadout reports available yet.';
            const gearNote = document.createElement('p');
            gearNote.className = 'fsl-muted';
            gearNote.textContent = 'Loadout data will appear here when available.';
            gearPanel.append(gearTitle, gearText, gearNote);

            const insertBeforeHost = host.firstChild;
            if (insertBeforeHost) {
                host.insertBefore(gearPanel, insertBeforeHost);
                host.insertBefore(statsPanel, insertBeforeHost);
            } else {
                host.appendChild(statsPanel);
                host.appendChild(gearPanel);
            }

            if (!targetId) {
                statsNote.textContent = 'Could not determine this profile’s player ID.';
                return;
            }

            const query = new URLSearchParams({ id: targetId });
            backendRequest({
                method: 'GET',
                url: `${API_BASE}/stats?${query}`,
                onload: async response => {
                    if (response.status < 200 || response.status >= 300) {
                        statsNote.textContent = `Intel service unavailable (HTTP ${response.status}); panels remain visible.`;
                        const fallback = await getBattleHistorySummary(targetId);
                        if (fallback) {
                            statsText.textContent = `Recent fights: ${fallback.count} · Wins ${fallback.wins} · Losses ${fallback.losses} · Damage ${formatNumber(fallback.totalDamage)}`;
                            statsNote.textContent = 'No current logs available — using recent Torn attack history.';
                            gearText.textContent = `Last result: ${fallback.latestResult || 'No recent result captured.'}`;
                            gearNote.textContent = fallback.lastSeen ? `Last seen: ${fallback.lastSeen}` : 'No historical battle records found.';
                        }
                        return;
                    }

                    const data = parseJson(response.responseText);
                    if (!data) {
                        statsNote.textContent = 'Intel service returned an unreadable response; panels remain visible.';
                        const fallback = await getBattleHistorySummary(targetId);
                        if (fallback) {
                            statsText.textContent = `Recent fights: ${fallback.count} · Wins ${fallback.wins} · Losses ${fallback.losses} · Damage ${formatNumber(fallback.totalDamage)}`;
                            statsNote.textContent = 'No current logs available — using recent Torn attack history.';
                            gearText.textContent = `Last result: ${fallback.latestResult || 'No recent result captured.'}`;
                            gearNote.textContent = fallback.lastSeen ? `Last seen: ${fallback.lastSeen}` : 'No historical battle records found.';
                        }
                        return;
                    }

                    const hasLiveStats = !!(data && (Number(data.bss) || Number(data.str) || Number(data.def) || Number(data.spd) || Number(data.dex) || Number(data.samples)));
                    if (!hasLiveStats) {
                        const fallback = await getBattleHistorySummary(targetId);
                        if (fallback) {
                            statsText.textContent = `Recent fights: ${fallback.count} · Wins ${fallback.wins} · Losses ${fallback.losses} · Damage ${formatNumber(fallback.totalDamage)}`;
                            statsNote.textContent = 'No current logs available — using recent Torn attack history.';
                            gearText.textContent = `Last result: ${fallback.latestResult || 'No recent result captured.'}`;
                            gearNote.textContent = fallback.lastSeen ? `Last seen: ${fallback.lastSeen}` : 'No historical battle records found.';
                            return;
                        }
                    }

                    const updated = data.updatedAt ? new Date(data.updatedAt * 1000).toLocaleDateString() : 'unknown';
                    statsText.textContent = `Build: ${archetype(data)} · BSS: ${formatNumber(data.bss)} · STR: ${formatNumber(data.str)} · DEF: ${formatNumber(data.def)} · SPD: ${formatNumber(data.spd)} · DEX: ${formatNumber(data.dex)}`;
                    statsNote.textContent = `Reports: ${formatNumber(data.samples || 0)} · Last updated: ${updated}`;

                    const loadout = data.loadout || {};
                    const armor = Array.isArray(loadout.armor) && loadout.armor.length ? loadout.armor.join(', ') : 'Unknown';
                    gearText.textContent = `Primary: ${loadout.primary || 'Unknown'} · Secondary: ${loadout.secondary || 'Unknown'} · Melee: ${loadout.melee || 'Unknown'} · Temporary: ${loadout.temporary || 'Unknown'} · Armor: ${armor}`;
                    gearNote.textContent = data.updatedAt ? `Last seen: ${updated}` : 'No dated loadout report available.';
                },
                onerror: async () => {
                    const fallback = await getBattleHistorySummary(targetId);
                    if (fallback) {
                        statsText.textContent = `Recent fights: ${fallback.count} · Wins ${fallback.wins} · Losses ${fallback.losses} · Damage ${formatNumber(fallback.totalDamage)}`;
                        statsNote.textContent = 'Could not connect to intel service — using recent Torn attack history.';
                        gearText.textContent = `Last result: ${fallback.latestResult || 'No recent result captured.'}`;
                        gearNote.textContent = fallback.lastSeen ? `Last seen: ${fallback.lastSeen}` : 'No historical battle records found.';
                        return;
                    }
                    statsNote.textContent = 'Could not connect to intel service; panels remain visible.';
                }
            });
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
            addStyles();
            scanRoster();
            const observer = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(scanRoster, 300);
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

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
            } catch (_) { /* Do not interfere with Torn's request. */ }
            return response;
        };
    }
})();
