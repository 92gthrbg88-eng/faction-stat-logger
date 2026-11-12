// ==UserScript==
// @name         Faction Stat Logger
// @namespace    https://github.com/92gthrbg88-eng/faction-stat-logger
// @version      1.5.0
// @description  Reliable Torn profile panel that stays visible, never prompts for a key, and uses battle history fallback when live logs are missing.
// @author       92gthrbg88-eng
// @match        https://*.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEYS = ['torn_api_key', 'cat_script_api_key', 'cat_api_key', 'fsl_torn_api_key'];
    const PANEL_ID = 'fsl-profile-panel';

    const state = {
        observer: null,
        initialised: false,
        lastProfileId: null,
        lastRenderKey: null
    };

    function safeLocalStorage() {
        try {
            return window.localStorage || null;
        } catch (_) {
            return null;
        }
    }

    function getSettingsValue(key, fallback = '') {
        try {
            if (typeof GM_getValue === 'function') {
                const v = GM_getValue(key, fallback);
                if (v && String(v).trim()) return String(v).trim();
            }
        } catch (_) {}

        try {
            if (window && window[key]) {
                const v = window[key];
                if (v && String(v).trim()) return String(v).trim();
            }
        } catch (_) {}

        const storage = safeLocalStorage();
        if (storage) {
            const v = storage.getItem(key);
            if (v && String(v).trim()) return String(v).trim();
        }

        return fallback;
    }

    function setSettingsValue(key, value) {
        const clean = String(value || '').trim();

        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, clean);
            }
        } catch (_) {}

        const storage = safeLocalStorage();
        if (storage) {
            try {
                if (clean) storage.setItem(key, clean);
                else storage.removeItem(key);
            } catch (_) {}
        }
    }

    function getApiKey() {
        for (const key of STORAGE_KEYS) {
            const value = getSettingsValue(key, '');
            if (value) return value;
        }

        const storage = safeLocalStorage();
        if (storage) {
            for (const key of STORAGE_KEYS) {
                const value = storage.getItem(key);
                if (value && String(value).trim()) return String(value).trim();
            }
        }

        return '';
    }

    function setApiKey(value) {
        const clean = String(value || '').trim();
        for (const key of STORAGE_KEYS) {
            setSettingsValue(key, clean);
        }
    }

    function isProfilePage() {
        try {
            return /(^|\/)profiles\.php(\?.*)?$/.test(window.location.pathname + window.location.search)
                || /profiles\.php/i.test(window.location.href);
        } catch (_) {
            return false;
        }
    }

    function getProfileIdFromUrl() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            const direct = params.get('XID') || params.get('userID') || params.get('id');
            if (direct && /^\d+$/.test(String(direct))) return String(direct);

            const match = (window.location.pathname || '').match(/profiles\.php\/?(\d+)/i);
            if (match && match[1]) return match[1];
        } catch (_) {}

        return null;
    }

    function getCurrentPageKey() {
        const profileId = getProfileIdFromUrl();
        return profileId ? `profile:${profileId}` : `page:${String(window.location.pathname || '')}`;
    }

    function formatNumber(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '—';
        if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
        if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
        if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
        return Math.round(num).toLocaleString();
    }

    function panelStyles() {
        return `
            #${PANEL_ID} {
                position: fixed;
                right: 12px;
                top: 76px;
                width: min(340px, calc(100vw - 28px));
                max-height: 58vh;
                overflow: auto;
                z-index: 2147483647;
                background: rgba(14, 16, 18, 0.96);
                color: #f5f5f5;
                border: 1px solid #5ccf75;
                border-radius: 8px;
                box-shadow: 0 9px 28px rgba(0,0,0,0.45);
                font-family: Arial, sans-serif;
                padding: 10px 12px;
                box-sizing: border-box;
            }
            #${PANEL_ID} h3 {
                margin: 0 0 7px;
                color: #baf7bf;
                font-size: 13px;
                font-weight: 700;
            }
            #${PANEL_ID} p {
                margin: 6px 0;
                font-size: 12px;
                line-height: 1.45;
            }
            #${PANEL_ID} .muted {
                color: #d0d0d0;
                font-size: 11px;
            }
            #${PANEL_ID} .section {
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 6px;
                padding: 8px 10px;
                margin-bottom: 8px;
            }
        `;
    }

    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;

        const style = document.createElement('style');
        style.textContent = panelStyles();
        document.head && document.head.appendChild(style);

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="section">
                <h3>Faction Intel</h3>
                <p id="fsl-main-text">Waiting for profile data…</p>
                <p id="fsl-main-note" class="muted">Profile intel will appear here.</p>
            </div>
            <div class="section">
                <h3>Loadout</h3>
                <p id="fsl-loadout-text">No live loadout data.</p>
                <p id="fsl-loadout-note" class="muted">Falling back to historical data when needed.</p>
            </div>
        `;

        const root = document.body || document.documentElement;
        if (root) root.appendChild(panel);
        return panel;
    }

    function writePanel(mainText, mainNote, loadoutText, loadoutNote) {
        const panel = ensurePanel();
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

    function fallbackFromBattleHistory(profileId, apiKey) {
        if (!profileId || !apiKey) {
            writePanel(
                'No battle intel available.',
                'No Torn API key is stored, and no current log is available.',
                'No live loadout data.',
                'Use a valid Torn API key or wait for a fresh snapshot.'
            );
            return;
        }

        fetch(`https://api.torn.com/user/?selections=attacks&key=${encodeURIComponent(apiKey)}`)
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
                if (!data || data.error || !data.attacks) {
                    writePanel(
                        'No battle history available.',
                        'The API key is valid but there is no recent attack history for this profile.',
                        'No live loadout data.',
                        'The panel remains visible and will refresh on profile change.'
                    );
                    return;
                }

                const attacks = Object.values(data.attacks).filter((entry) => {
                    if (!entry) return false;
                    const targetId = Number(profileId);
                    const defenderId = Number(entry.defender_id || entry.defenderId || entry.target_id || entry.targetId || 0);
                    const attackerId = Number(entry.attacker_id || entry.attackerId || 0);
                    return defenderId === targetId || attackerId === targetId;
                });

                if (!attacks.length) {
                    writePanel(
                        'No battle intel available.',
                        'The profile has no matching recent attack entries.',
                        'No live loadout data.',
                        'Historical fallback was attempted but returned no matches.'
                    );
                    return;
                }

                const latest = attacks.slice().sort((a, b) => (Number(b.timestamp || b.time || 0) || 0) - (Number(a.timestamp || a.time || 0) || 0))[0];
                const wins = attacks.filter((entry) => /win|won|victory|successful|killed|defeated/i.test(String(entry.result || entry.outcome || entry.status || ''))).length;
                const losses = attacks.filter((entry) => /loss|lost|failed|escaped|missed/i.test(String(entry.result || entry.outcome || entry.status || ''))).length;
                const totalDamage = attacks.reduce((sum, entry) => sum + (Number(entry.damage || entry.damage_done || entry.damageDealt || 0) || 0), 0);
                const latestResult = latest ? String(latest.result || latest.outcome || latest.status || 'Recent battle') : 'Recent battle';
                const lastSeen = latest && (latest.timestamp || latest.time) ? new Date(Number(latest.timestamp || latest.time) * 1000).toLocaleString() : 'Unknown';

                writePanel(
                    `Recent fights: ${attacks.length} · Wins ${wins} · Losses ${losses} · Damage ${formatNumber(totalDamage)}`,
                    'Using Torn attack history because live logs are unavailable.',
                    `Last result: ${latestResult}`,
                    `Last seen: ${lastSeen}`
                );
            })
            .catch(() => {
                writePanel(
                    'History fallback failed.',
                    'The API key may be invalid or the Torn API request failed.',
                    'No live loadout data.',
                    'The panel remains visible while waiting for a valid source.'
                );
            });
    }

    function getProfileData(profileId) {
        const apiKey = getApiKey();
        if (!apiKey) {
            writePanel(
                'No API key found.',
                'The script is configured to use the local Torn API key automatically, but none is stored yet.',
                'No live loadout data.',
                'The panel remains visible and will load once the key is available.'
            );
            return;
        }

        fetch(`https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(apiKey)}`)
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
                if (!data || data.error) {
                    fallbackFromBattleHistory(profileId, apiKey);
                    return;
                }

                const stats = data?.profile || data || {};
                const damage = Number(stats.damage || stats.totalDamage || 0);
                const strength = Number(stats.strength || stats.str || 0);
                const defense = Number(stats.defense || stats.def || 0);
                const speed = Number(stats.speed || stats.spd || 0);
                const dexterity = Number(stats.dexterity || stats.dex || 0);
                const war = Number(stats.war || stats.bss || 0);
                const points = Number(stats.points || stats.level || 0);

                const mainText = [
                    `Profile ${profileId}`,
                    `Damage ${formatNumber(damage)}`,
                    `STR ${formatNumber(strength)} · DEF ${formatNumber(defense)}`,
                    `SPD ${formatNumber(speed)} · DEX ${formatNumber(dexterity)}`,
                    `BSS ${formatNumber(war)} · Points ${formatNumber(points)}`
                ].join(' · ');

                writePanel(
                    mainText,
                    `Live Torn profile data loaded successfully. API key is being used without prompting.`,
                    `Loadout: ${stats.loadout || 'No loadout data available'}`,
                    `Profile ID: ${profileId}`
                );
            })
            .catch(() => fallbackFromBattleHistory(profileId, apiKey));
    }

    function refreshProfilePanel() {
        const profileId = getProfileIdFromUrl();
        if (!profileId) {
            writePanel(
                'Profile ID not detected.',
                'This panel stays visible on profile pages and will refresh once a valid Torn profile is loaded.',
                'No live loadout data.',
                'Unable to resolve current profile.'
            );
            return;
        }

        const key = `${profileId}:${getApiKey()}`;
        if (state.lastRenderKey === key) return;
        state.lastRenderKey = key;
        state.lastProfileId = profileId;
        getProfileData(profileId);
    }

    function attachObserver() {
        if (state.observer) return;

        const root = document.body || document.documentElement;
        if (!root) return;

        state.observer = new MutationObserver(() => {
            const currentProfileId = getProfileIdFromUrl();
            if (isProfilePage() && currentProfileId) {
                ensurePanel();
                refreshProfilePanel();
            }
        });

        state.observer.observe(root, { childList: true, subtree: true, attributes: false });
    }

    function init() {
        if (state.initialised) return;
        state.initialised = true;
        ensurePanel();
        attachObserver();
        if (isProfilePage()) {
            refreshProfilePanel();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
