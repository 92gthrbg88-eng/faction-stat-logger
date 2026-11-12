// ==UserScript==
// @name         Faction Fight Stat Logger & Loadout Intel
// @namespace    https://github.com
// @version      1.3.0
// @description  Passively logs 4-stat combat estimates and defender equipment loadouts from fights, displaying them on Player Profiles and Faction War screens without interfering with FFScouter or CAT Script.
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
// @updateURL    https://githubusercontent.com/92gthrbg88-eng/faction-stat-logger/main/faction-stat-logger.user.js
// @downloadURL  https://githubusercontent.com/92gthrbg88-eng/faction-stat-logger/main/faction-stat-logger.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    const SERVERLESS_BASE_URL = 'https://faction-intel.thn25tvjtb.workers.dev';
    const FACTION_SECRET_TOKEN = 'HeartBreakers2026!SecretKey';

    const PAGE_URL = window.location.href;

    // =========================================================================
    // MENU COMMANDS & LOCAL API KEY MANAGEMENT
    // =========================================================================
    GM_registerMenuCommand('Set / Update Torn API Key', () => {
        const current = GM_getValue('torn_api_key', '');
        const input = prompt('Enter your Torn Limited Access API Key (stored locally in your browser only):', current);
        if (input !== null) {
            GM_setValue('torn_api_key', input.trim());
            alert('API key saved locally.');
        }
    });

    function getApiKey() {
        let key = GM_getValue('torn_api_key', '');
        if (!key) {
            key = prompt('Faction Stat Logger: Enter your Torn Limited Access API Key (stored locally only):');
            if (key && key.trim()) {
                key = key.trim();
                GM_setValue('torn_api_key', key);
            }
        }
        return key;
    }

    function formatCompactNumber(num) {
        if (num === null || num === undefined || Number.isNaN(Number(num))) return '—';
        const n = Number(num);
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return Math.round(n).toLocaleString();
    }

    function detectBuildArchetype(stats) {
        const { str, def, spd, dex } = stats;
        const available = [
            { label: 'Str Build', val: str || 0 },
            { label: 'Def Tank', val: def || 0 },
            { label: 'Spd Build', val: spd || 0 },
            { label: 'Dex Whore', val: dex || 0 }
        ].filter(s => s.val > 0);

        if (available.length < 2) return 'Partial Intel';
        available.sort((a, b) => b.val - a.val);
        if (available[0].val >= available[1].val * 1.6) {
            return available[0].label;
        }
        return 'Balanced';
    }

    // =========================================================================
    // MODULE 1: ATTACK SCREEN LOGGER & EQUIPMENT CAPTURE
    // =========================================================================
    if (PAGE_URL.includes('sid=attack')) {
        const fightState = {
            opponentId: null,
            opponentName: null,
            mySwings: 0,
            myHits: 0,
            myDamageSamples: [],
            oppSwings: 0,
            oppHits: 0,
            oppDamageSamples: [],
            loadout: {
                primary: null,
                secondary: null,
                melee: null,
                temporary: null,
                armor: []
            },
            fairFight: null,
            submitted: false
        };

        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            try {
                const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                if (reqUrl.includes('sid=attackData')) {
                    const clone = response.clone();
                    clone.json().then(parseAttackResponse).catch(() => {});
                }
            } catch (_) {}
            return response;
        };

        function extractDefenderLoadout(db) {
            const def = db.defenderUser;
            if (!def) return;

            const items = def.items || def.weapons || {};
            if (items.primary?.name) fightState.loadout.primary = items.primary.name;
            if (items.secondary?.name) fightState.loadout.secondary = items.secondary.name;
            if (items.melee?.name) fightState.loadout.melee = items.melee.name;
            if (items.temporary?.name) fightState.loadout.temporary = items.temporary.name;

            if (Array.isArray(def.armor)) {
                const armorNames = def.armor.map(a => a?.name || a).filter(Boolean);
                if (armorNames.length) fightState.loadout.armor = armorNames;
            } else if (def.armor && typeof def.armor === 'object') {
                const armorNames = Object.values(def.armor).map(a => a?.name).filter(Boolean);
                if (armorNames.length) fightState.loadout.armor = armorNames;
            }
        }

        function parseAttackResponse(payload) {
            if (!payload || !payload.DB || fightState.submitted) return;
            const db = payload.DB;

            if (db.defenderUser) {
                fightState.opponentId = Number(db.defenderUser.playerId);
                fightState.opponentName = db.defenderUser.playername;
                extractDefenderLoadout(db);
            }

            const logs = Array.isArray(db.fightLogs) ? db.fightLogs : [];
            for (const entry of logs) {
                if (!entry || !entry.attackerId || !fightState.opponentId) continue;

                const isOpp = Number(entry.attackerId) === fightState.opponentId;

                if (isOpp && entry.weaponName) {
                    if (entry.weaponType === 'Primary') fightState.loadout.primary = entry.weaponName;
                    if (entry.weaponType === 'Secondary') fightState.loadout.secondary = entry.weaponName;
                    if (entry.weaponType === 'Melee') fightState.loadout.melee = entry.weaponName;
                    if (entry.weaponType === 'Temporary') fightState.loadout.temporary = entry.weaponName;
                }

                if (entry.smoke || entry.tearGas || entry.flash) continue;

                if (!isOpp) {
                    if (entry.action === 'hit' || entry.action === 'crit') {
                        fightState.mySwings++;
                        fightState.myHits++;
                        if (typeof entry.damage === 'number' && entry.damage > 0) {
                            fightState.myDamageSamples.push(entry.damage);
                        }
                    } else if (entry.action === 'miss') {
                        fightState.mySwings++;
                    }
                } else {
                    if (entry.action === 'hit' || entry.action === 'crit') {
                        fightState.oppSwings++;
                        fightState.oppHits++;
                        if (typeof entry.damage === 'number' && entry.damage > 0) {
                            fightState.oppDamageSamples.push(entry.damage);
                        }
                    } else if (entry.action === 'miss') {
                        fightState.oppSwings++;
                    }
                }
            }

            const modifiers = db.currentFight?.modifiers;
            if (modifiers && modifiers.fairFight !== undefined && modifiers.fairFight !== null) {
                const ff = parseFloat(modifiers.fairFight);
                if (!Number.isNaN(ff) && ff >= 1.0) {
                    fightState.fairFight = ff;
                    fightState.submitted = true;
                    finalizeAndUpload();
                }
            }
        }

        function estimateOpponentDexterity(mySpeed, swings, hits) {
            if (swings < 3) return null;
            const hitRate = Math.min(Math.max(hits / swings, 0.02), 0.98);
            return hitRate <= 0.50
                ? mySpeed / Math.pow(hitRate / 0.50, 1 / 0.72)
                : mySpeed * Math.pow((1 - hitRate) / 0.50, 1 / 0.72);
        }

        function estimateOpponentSpeed(myDexterity, swings, hits) {
            if (swings < 3) return null;
            const oppHitRate = Math.min(Math.max(hits / swings, 0.02), 0.98);
            return oppHitRate <= 0.50
                ? myDexterity * Math.pow(oppHitRate / 0.50, 1 / 0.72)
                : myDexterity / Math.pow((1 - oppHitRate) / 0.50, 1 / 0.72);
        }

        function estimateOpponentDefense(myStrength, damageSamples) {
            if (!damageSamples.length || myStrength <= 0) return null;
            const avgDamage = damageSamples.reduce((a, b) => a + b, 0) / damageSamples.length;
            const logStr = Math.log10(Math.max(myStrength / 10, 1));
            const baseStrDamage = 7 * Math.pow(logStr, 2) + 27 * logStr + 30;
            const expectedUnmitigated = baseStrDamage * 5.0 * 0.65;
            const mitigation = Math.min(Math.max(1 - avgDamage / expectedUnmitigated, 0.01), 0.99);
            return mitigation >= 0.50
? myStrength * Math.pow(14, (mitigation - 0.50) / 0.50)
: myStrength / Math.pow(32, (0.50 - mitigation) / 0.50);
}
function estimateOpponentStrength(myDefense, oppDamageSamples) {
if (!oppDamageSamples.length || myDefense <= 0) return null;
const avgOppDamage = oppDamageSamples.reduce((a, b) => a + b, 0) / oppDamageSamples.length;
const estimatedUnmitigated = avgOppDamage / (0.50 * 5.0 * 0.65);
const c = 30 - estimatedUnmitigated;
const discriminant = Math.pow(27, 2) - 4 * 7 * c;
if (discriminant < 0) return null;
const logOppStr = (-27 + Math.sqrt(discriminant)) / (2 * 7);
return 10 * Math.pow(10, Math.max(logOppStr, 0));
}
async function finalizeAndUpload() {
try {
const apiKey = getApiKey();
if (!apiKey || !fightState.opponentId) return;
const res = await fetch('https://api.torn.com/user/?selections=basic,battlestats&key=${encodeURIComponent(apiKey)}');
const data = await res.json();
if (data.error) return;
const myBss = Math.sqrt(data.strength) + Math.sqrt(data.defense) + Math.sqrt(data.speed) + Math.sqrt(data.dexterity);
const ff = fightState.fairFight;
const estimatedBss = (ff > 1.00 && ff < 3.00) ? (3 / 8) * (ff - 1) * myBss : null;
const estDex = estimateOpponentDexterity(data.speed, fightState.mySwings, fightState.myHits);
const estDef = estimateOpponentDefense(data.strength, fightState.myDamageSamples);
const estSpd = estimateOpponentSpeed(data.dexterity, fightState.oppSwings, fightState.oppHits);
const estStr = estimateOpponentStrength(data.defense, fightState.oppDamageSamples);
let remainingStrSpdBss = null;
if (estimatedBss && estDef && estDex) {
remainingStrSpdBss = Math.max(0, Math.round(estimatedBss - (Math.sqrt(estDef) + Math.sqrt(estDex))));
}
const report = {
targetId: fightState.opponentId,
targetName: fightState.opponentName,
reporterId: data.player_id,
factionId: data.faction?.faction_id || 0,
fairFight: ff,
estimatedBss: estimatedBss ? Math.round(estimatedBss) : null,
estimatedStr: estStr ? Math.round(estStr) : null,
estimatedDef: estDef ? Math.round(estDef) : null,
estimatedSpd: estSpd ? Math.round(estSpd) : null,
estimatedDex: estDex ? Math.round(estDex) : null,
remainingStrSpdBss,
loadout: fightState.loadout,
sampleCounts: { mySwings: fightState.mySwings, oppSwings: fightState.oppSwings },
timestamp: Math.floor(Date.now() / 1000)
};
GM_xmlhttpRequest({
method: 'POST',
url: ${SERVERLESS_BASE_URL}/log,
headers: {
'Content-Type': 'application/json',
'X-Faction-Token': FACTION_SECRET_TOKEN
},
data: JSON.stringify(report)
});
} catch (err) {
console.error('[FSL] Upload error:', err);
}
}
}
// =========================================================================
// MODULE 2: PLAYER PROFILE OVERLAY (Stats + Loadout Below Medals)
// =========================================================================
if (PAGE_URL.includes('profiles.php')) {
window.addEventListener('DOMContentLoaded', () => {
const match = PAGE_URL.match(/XID=(\d+)/i);
if (!match) return;
const targetId = match[1];
GM_xmlhttpRequest({
method: 'GET',
url: ${SERVERLESS_BASE_URL}/stats?id=${targetId},
headers: { 'X-Faction-Token': FACTION_SECRET_TOKEN },
onload: (res) => {
if (res.status !== 200) return;
try {
const data = JSON.parse(res.responseText);
if (!data) return;
if (data.bss || data.def || data.dex) injectStatsCard(data);
if (data.loadout) injectLoadoutBadgeBelowMedals(data);
} catch (_) {}
}
});
});
function injectStatsCard(stats) {
if (document.getElementById('fsl-profile-card')) return;
const observer = new MutationObserver((_, obs) => {
const profileWrapper = document.querySelector('.profile-wrapper, .user-profile');
if (!profileWrapper) return;
obs.disconnect();
const buildTag = detectBuildArchetype(stats);
const updatedDate = stats.updatedAt ? new Date(stats.updatedAt * 1000).toLocaleDateString() : 'Recent';
const card = document.createElement('div');
card.id = 'fsl-profile-card';
card.style.cssText = [
'margin: 8px 0',
'padding: 10px 14px',
'background: #222',
'border: 1px solid #444',
'border-left: 4px solid #4caf50',
'border-radius: 5px',
'color: #eee',
'font-family: Arial, sans-serif',
'font-size: 12px',
'display: flex',
'flex-wrap: wrap',
'justify-content: space-between',
'align-items: center',
'gap: 8px'
].join(';');
card.innerHTML = <div> <strong style="color:#8bc34a;">[Faction Intel]</strong> <span style="margin-left:6px; padding:2px 6px; background:#333; border-radius:3px; color:#ffd54f;">${buildTag}</span> <span style="margin-left:8px; color:#aaa;">BSS: <strong style="color:#fff;">${formatCompactNumber(stats.bss)}</strong></span> </div> <div style="display:flex; gap:12px; flex-wrap:wrap;"> <span><strong>STR:</strong> ${formatCompactNumber(stats.str)}</span> <span><strong>DEF:</strong> ${formatCompactNumber(stats.def)}</span> <span><strong>SPD:</strong> ${formatCompactNumber(stats.spd)}</span> <span><strong>DEX:</strong> ${formatCompactNumber(stats.dex)}</span> </div> <div style="color:#999; font-size:11px;"> ${stats.samples || 1} fight(s) • ${updatedDate} </div>;
profileWrapper.parentNode.insertBefore(card, profileWrapper);
});
observer.observe(document.body, { childList: true, subtree: true });
}
function injectLoadoutBadgeBelowMedals(data) {
if (document.getElementById('fsl-loadout-card')) return;
const observer = new MutationObserver((_, obs) => {
const medalsContainer =
document.querySelector('.medals-wrapper') ||
document.querySelector('[class*="medalsWrapper"]') ||
Array.from(document.querySelectorAll('.title-black, .m-top10')).find(el =>
el.textContent && el.textContent.trim().startsWith('Medals')
)?.parentElement;
if (!medalsContainer || !medalsContainer.parentNode) return;
obs.disconnect();
const gear = data.loadout || {};
const armorText = Array.isArray(gear.armor) && gear.armor.length
? gear.armor.join(', ')
: 'Unknown';
const seenDate = data.updatedAt ? new Date(data.updatedAt * 1000).toLocaleDateString() : 'Recent';
const loadoutBox = document.createElement('div');
loadoutBox.id = 'fsl-loadout-card';
loadoutBox.style.cssText = [
'margin: 8px 0 10px 0',
'background: #2b2b2b',
'border: 1px solid #444',
'border-radius: 5px',
'overflow: hidden',
'font-family: Arial, sans-serif',
'font-size: 12px',
'color: #ddd'
].join(';');
loadoutBox.innerHTML = <div style="background:#1f1f1f; padding:6px 12px; border-bottom:1px solid #3d3d3d; display:flex; justify-content:space-between; align-items:center;"> <strong style="color:#ffb74d; font-size:12px;">Last Known Equipment Loadout</strong> <span style="color:#999; font-size:11px;">Spotted: ${seenDate}</span> </div> <div style="padding:8px 12px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;"> <span style="background:#1c1c1c; border:1px solid #3e3e3e; padding:3px 8px; border-radius:4px;"> <strong style="color:#90caf9;">Primary:</strong> ${gear.primary || 'Unknown'} </span> <span style="background:#1c1c1c; border:1px solid #3e3e3e; padding:3px 8px; border-radius:4px;"> <strong style="color:#90caf9;">Secondary:</strong> ${gear.secondary || 'Unknown'} </span> <span style="background:#1c1c1c; border:1px solid #3e3e3e; padding:3px 8px; border-radius:4px;"> <strong style="color:#90caf9;">Melee:</strong> ${gear.melee || 'Unknown'} </span> <span style="background:#1c1c1c; border:1px solid #3e3e3e; padding:3px 8px; border-radius:4px;"> <strong style="color:#ce93d8;">Temp:</strong> ${gear.temporary || 'Unknown'} </span> <span style="background:#1c1c1c; border:1px solid #3e3e3e; padding:3px 8px; border-radius:4px;"> <strong style="color:#a5d6a7;">Armor:</strong> ${armorText} </span> </div>;
medalsContainer.insertAdjacentElement('afterend', loadoutBox);
});
observer.observe(document.body, { childList: true, subtree: true });
}
}
// =========================================================================
// MODULE 3: FACTION & WAR SCREEN OVERLAY (factions.php)
// =========================================================================
if (PAGE_URL.includes('factions.php')) {
const fetchedIds = new Set();
let batchTimer = null;
function scanWarAndRosterRows() {
const profileLinks = document.querySelectorAll('a[href*="profiles.php?XID="]');
const pendingIds = [];
profileLinks.forEach(link => {
const row = link.closest('li, .table-row, .enemy, .member');
if (!row || row.dataset.fslProcessed) return;
const match = link.href.match(/XID=(\d+)/i);
if (!match) return;
const userId = match[1];
row.dataset.fslUserId = userId;
row.dataset.fslProcessed = 'pending';
if (!fetchedIds.has(userId)) {
fetchedIds.add(userId);
pendingIds.push(userId);
}
});
if (pendingIds.length > 0) {
fetchBatchStats(pendingIds);
}
}
function fetchBatchStats(ids) {
GM_xmlhttpRequest({
method: 'POST',
url: ${SERVERLESS_BASE_URL}/stats-batch,
headers: {
'Content-Type': 'application/json',
'X-Faction-Token': FACTION_SECRET_TOKEN
},
data: JSON.stringify({ ids }),
onload: (res) => {
if (res.status !== 200) return;
try {
const map = JSON.parse(res.responseText);
renderWarBadges(map);
} catch (_) {}
}
});
}
function renderWarBadges(statsMap) {
const rows = document.querySelectorAll('[data-fsl-processed="pending"]');
rows.forEach(row => {
const userId = row.dataset.fslUserId;
const stats = statsMap[userId];
row.dataset.fslProcessed = 'done';
if (!stats || (!stats.bss && !stats.def && !stats.dex)) return;
if (row.querySelector('.fsl-war-badge')) return;
const buildTag = detectBuildArchetype(stats);
const badge = document.createElement('span');
badge.className = 'fsl-war-badge';
badge.style.cssText = [
'display: inline-block',
'margin-left: 6px',
'padding: 1px 6px',
'background: #1e272e',
'border: 1px solid #4caf50',
'border-radius: 3px',
'color: #a5d6a7',
'font-size: 11px',
'font-family: Arial, sans-serif',
'line-height: 1.4',
'vertical-align: middle',
'cursor: help'
].join(';');
badge.textContent = BSS ${formatCompactNumber(stats.bss)} • ${buildTag};
const gear = stats.loadout || {};
const weaponSummary = [gear.primary, gear.melee, gear.temporary].filter(Boolean).join(', ');
badge.title = [
Faction Intel (${stats.samples || 1} fights),
BSS: ${formatCompactNumber(stats.bss)},
STR: ${formatCompactNumber(stats.str)} | DEF: ${formatCompactNumber(stats.def)},
SPD: ${formatCompactNumber(stats.spd)} | DEX: ${formatCompactNumber(stats.dex)},
weaponSummary ? Gear: ${weaponSummary} : ''
].filter(Boolean).join('\n');
const nameLink = row.querySelector('a[href*="profiles.php?XID="]');
if (nameLink && nameLink.parentNode) {
nameLink.parentNode.appendChild(badge);
}
});
}
window.addEventListener('DOMContentLoaded', () => {
const observer = new MutationObserver(() => {
clearTimeout(batchTimer);
batchTimer = setTimeout(scanWarAndRosterRows, 350);
});
observer.observe(document.body, { childList: true, subtree: true });
scanWarAndRosterRows();
});
}
