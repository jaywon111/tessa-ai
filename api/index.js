const express = require('express');
const cors = require('cors');
const { put, list } = require('@vercel/blob');

const app = express();
app.use(cors());
app.use(express.json());

const FD_BASE = 'https://api.football-data.org/v4';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PICKS_PATH = 'tessa/picks.json';
const LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
const OU_LINES = [1.5, 2.5, 3.5];
const DEFAULT_LINE = 2.5;
const MAX_GAMES = 10;
const FORM_N = 8;   // overall recent matches per team
const SPLIT_N = 5;  // home-only / away-only recent matches per team

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Confidence tiers (stricter: high needs 75+)
// Matches Jay's spec: high >=70, medium 55-69, low 40-54.
const tier = s => (s >= 70 ? 'high' : s >= 55 ? 'medium' : s >= 40 ? 'low' : 'pass');

// Old picks have no market field: they were all Over/Under 2.5.
function normalizePick(p) {
    const market = p.market || 'OU';
    return {
        ...p,
        market,
        line: market === 'BTTS' ? null : (p.line ?? DEFAULT_LINE),
        confidence: p.confidence_score != null ? tier(p.confidence_score) : p.confidence,
    };
}

// Human label used everywhere: "Over 2.5", "Under 1.5", "BTTS Yes", "BTTS No"
function pickLabel(p) {
    if (p.market === 'BTTS') return `BTTS ${p.pick}`;
    return `${p.pick} ${p.line ?? DEFAULT_LINE}`;
}

// ---------- storage (Vercel Blob) ----------
async function loadPicks() {
    const { blobs } = await list({ prefix: PICKS_PATH, limit: 1 });
    const blob = blobs.find(b => b.pathname === PICKS_PATH);
    if (!blob) return [];
    const r = await fetch(blob.url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`blob read failed: ${r.status}`);
    const arr = await r.json();
    return arr.map(normalizePick);
}
async function savePicks(picks) {
    await put(PICKS_PATH, JSON.stringify(picks), {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 0,
    });
}

// ---------- football-data.org (rate limit: 10 req/min, throttled) ----------
let lastFdCall = 0;
async function fd(path) {
    const wait = 6500 - (Date.now() - lastFdCall);
    if (wait > 0) await sleep(wait);
    lastFdCall = Date.now();
    // football-data intermittently returns 400 "invalid token" on a valid key; retry with short backoff.
    let r;
    for (let attempt = 1; attempt <= 4; attempt++) {
        r = await fetch(`${FD_BASE}${path}`, { headers: { 'x-auth-token': process.env.FOOTBALL_DATA_TOKEN.trim() } });
        if (r.status !== 400 && r.status !== 429) break;
        if (attempt < 4) {
            await sleep(1000 * attempt);
            lastFdCall = Date.now();
            await sleep(Math.max(0, 6500 - (Date.now() - lastFdCall)));
            lastFdCall = Date.now();
        }
    }
    if (r.status === 429) throw new Error('football-data rate limited (429)');
    if (!r.ok) throw new Error(`football-data ${path} -> ${r.status}`);
    return await r.json();
}

const iso = d => d.toISOString().slice(0, 10);

// ---------- Gemini ----------
async function askGemini(prompt) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
    });
    if (!r.ok) throw new Error(`gemini -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// Validate one graded line (Over/Under) or BTTS side. Returns null when unusable (no reasoning, bad side).
function validSide(v, sides) {
    if (!v || !sides.includes(v.pick) || !v.reasoning || !String(v.reasoning).trim()) return null;
    return v;
}

// Settle one pick from final full-time score.
function settle(p, home, away) {
    if (p.market === 'BTTS') {
        const btts = home > 0 && away > 0;
        return (p.pick === 'Yes') === btts ? 'won' : 'lost';
    }
    const line = p.line ?? DEFAULT_LINE;
    const total = home + away;
    if (total === line) return 'push'; // only possible on whole-number lines (not 1.5/2.5/3.5)
    return (p.pick === 'Over') === (total > line) ? 'won' : 'lost';
}

// ---------- The Odds API (free tier: 500 credits/month) ----------
// Cost per request = markets x regions = 1 credit (totals, uk only). One request per league.
// Odds are cached in blob for 24h, so each league costs at most 1 credit per day
// (6 leagues max = ~180 credits/month). Max 6 requests per sync run.
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_CACHE_PATH = 'tessa/odds-cache.json';
const ODDS_TTL_MS = 24 * 3600 * 1000;
const ODDS_MAX_REQUESTS = 6;
const ODDS_SPORT = {
    PL: 'soccer_epl', PD: 'soccer_spain_la_liga', SA: 'soccer_italy_serie_a',
    BL1: 'soccer_germany_bundesliga', FL1: 'soccer_france_ligue_one', CL: 'soccer_uefa_champs_league',
};

async function loadOddsCache() {
    try {
        const { blobs } = await list({ prefix: ODDS_CACHE_PATH, limit: 1 });
        const blob = blobs.find(b => b.pathname === ODDS_CACHE_PATH);
        if (!blob) return {};
        const r = await fetch(blob.url, { cache: 'no-store' });
        return r.ok ? await r.json() : {};
    } catch (e) { return {}; }
}
async function saveOddsCache(cache) {
    await put(ODDS_CACHE_PATH, JSON.stringify(cache), {
        access: 'public', addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json', cacheControlMaxAge: 0,
    });
}

// Average vig-removed P(over) per line across bookmakers, plus best prices.
function summarizeTotals(bookmakers = []) {
    const lines = {};
    for (const bk of bookmakers) {
        const mk = (bk.markets || []).find(x => x.key === 'totals');
        if (!mk) continue;
        for (const o of mk.outcomes || []) {
            const line = String(o.point);
            lines[line] = lines[line] || { probs: [], best_over: null, best_under: null, books: 0 };
        }
        const byLine = {};
        for (const o of mk.outcomes || []) {
            const k = String(o.point);
            byLine[k] = byLine[k] || {};
            byLine[k][o.name] = o.price;
        }
        for (const [line, sides] of Object.entries(byLine)) {
            const L = lines[line];
            if (sides.Over) L.best_over = Math.max(L.best_over || 0, sides.Over);
            if (sides.Under) L.best_under = Math.max(L.best_under || 0, sides.Under);
            if (sides.Over && sides.Under) {
                const io = 1 / sides.Over, iu = 1 / sides.Under;
                L.probs.push(io / (io + iu));
                L.books++;
            }
        }
    }
    const out = {};
    for (const [line, L] of Object.entries(lines)) {
        if (!L.books) continue;
        const avg = L.probs.reduce((a, b) => a + b, 0) / L.probs.length;
        out[line] = {
            implied_over_pct: Math.round(avg * 1000) / 10,
            implied_under_pct: Math.round((100 - avg * 100) * 10) / 10,
            books: L.books,
            best_over: L.best_over,
            best_under: L.best_under,
        };
    }
    return out;
}

async function fetchLeagueOdds(code) {
    const key = ODDS_SPORT[code];
    const url = `${ODDS_BASE}/sports/${key}/odds?apiKey=${encodeURIComponent(process.env.ODDS_API_KEY.trim())}&regions=uk&markets=totals&oddsFormat=decimal&dateFormat=iso`;
    const r = await fetch(url, { cache: 'no-store' });
    const remaining = r.headers.get('x-requests-remaining');
    if (!r.ok) throw new Error(`odds ${key} -> ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const events = await r.json();
    return {
        fetched_at: new Date().toISOString(),
        requests_remaining: remaining,
        events: events.map(e => ({
            home: e.home_team, away: e.away_team, commence: e.commence_time,
            totals: summarizeTotals(e.bookmakers),
        })),
    };
}

const normName = s => String(s || '').toLowerCase().replace(/\b(fc|afc|cf|sc|ac|club)\b/g, '').replace(/[^a-z0-9]/g, '');
const sameTeam = (a, b) => { const x = normName(a), y = normName(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };

// Find the cached odds for one fixture (same teams, kickoff within 6h).
function findOdds(m, cache) {
    const bucket = cache[ODDS_SPORT[m.competition?.code]];
    if (!bucket) return null;
    const t = new Date(m.utcDate).getTime();
    const ev = bucket.events.find(e => sameTeam(e.home, m.homeTeam.name) && sameTeam(e.away, m.awayTeam.name)
        && Math.abs(new Date(e.commence).getTime() - t) < 6 * 3600 * 1000);
    if (!ev || !Object.keys(ev.totals).length) return null;
    return { source: 'the-odds-api', fetched_at: bucket.fetched_at, totals: ev.totals };
}

function oddsLine(o) {
    if (!o) return 'Bookmaker odds: none found for this fixture (rely on form only).';
    const parts = Object.entries(o.totals).sort(([a], [b]) => Number(a) - Number(b))
        .map(([line, t]) => `Over/Under ${line}: market implied P(over)=${t.implied_over_pct}% (P(under)=${t.implied_under_pct}%), ${t.books} UK books`);
    return `Bookmaker odds (vig removed): ${parts.join('; ')}.`;
}

// ---------- routes ----------

// GET /api/games - picks for the dashboard (pending + last 3 days resolved)
app.get('/api/games', async (req, res) => {
    try {
        const picks = await loadPicks();
        const cutoff = Date.now() - 3 * 86400000;
        const games = picks
            .filter(p => p.result === 'pending' || new Date(p.resolved_at || p.game_time).getTime() >= cutoff)
            .sort((a, b) => new Date(a.game_time) - new Date(b.game_time));
        res.json({ games });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET|POST /api/sync - daily prediction run (cron + Sync button)
app.all('/api/sync', async (req, res) => {
    try {
        const today = new Date();
        const end = new Date(Date.now() + 2 * 86400000);
        const upcoming = await fd(`/matches?dateFrom=${iso(today)}&dateTo=${iso(end)}&status=SCHEDULED,TIMED`);
        // Drop games we already have BEFORE applying the cap, otherwise already-picked games
        // fill the MAX_GAMES slots and new fixtures are never picked.
        const existing = await loadPicks();
        // Lines already graded per fixture, keys like "OU|2.5" or "BTTS".
        const haveLines = new Map();
        for (const p of existing) {
            if (!haveLines.has(p.api_id)) haveLines.set(p.api_id, new Set());
            haveLines.get(p.api_id).add(p.market === 'BTTS' ? 'BTTS' : `OU|${p.line ?? DEFAULT_LINE}`);
        }
        const needsWork = m => { const h = haveLines.get(m.id) || new Set(); return OU_LINES.some(l => !h.has(`OU|${l}`)); };
        const candidates = (upcoming.matches || [])
            .filter(m => LEAGUES.includes(m.competition?.code))
            .filter(needsWork)
            .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
            .slice(0, MAX_GAMES);

        if (candidates.length === 0) return res.json({ success: true, processed: 0, added: 0, message: 'no new upcoming games in supported leagues' });

        // Bookmaker odds: fetch only leagues whose cache is older than 24h, capped per run.
        const oddsCache = await loadOddsCache();
        const oddsNotes = [];
        let oddsRequests = 0, oddsFetched = 0;
        const oddsCodes = [...new Set(candidates.map(m => m.competition.code))].filter(c => ODDS_SPORT[c]);
        if (process.env.ODDS_API_KEY) {
            for (const code of oddsCodes) {
                const key = ODDS_SPORT[code];
                const age = oddsCache[key] ? Date.now() - new Date(oddsCache[key].fetched_at).getTime() : Infinity;
                if (age < ODDS_TTL_MS) continue;
                if (oddsRequests >= ODDS_MAX_REQUESTS) { oddsNotes.push(`${key}: skipped, per-run cap reached`); continue; }
                try {
                    oddsCache[key] = await fetchLeagueOdds(code);
                    oddsRequests++; oddsFetched++;
                } catch (e) {
                    oddsRequests++;
                    oddsNotes.push(e.message);
                }
            }
            if (oddsFetched) await saveOddsCache(oddsCache);
        } else {
            oddsNotes.push('ODDS_API_KEY not set: sync ran on form only');
        }
        const candOdds = candidates.map(m => findOdds(m, oddsCache));

        // Team recent form: one finished-matches call per league (covers all teams at once)
        const codes = [...new Set(candidates.map(m => m.competition.code))];
        const finished = {};
        for (const code of codes) {
            const d = await fd(`/competitions/${code}/matches?status=FINISHED`);
            finished[code] = (d.matches || []).filter(m => m.score?.fullTime?.home != null);
        }

        // Per-team form: recent goals scored/conceded, home-only and away-only splits, and market hit rates.
        const teamForm = (code, teamId) => {
            const side = m => m.homeTeam.id === teamId;
            const gf = m => (side(m) ? m.score.fullTime.home : m.score.fullTime.away);
            const ga = m => (side(m) ? m.score.fullTime.away : m.score.fullTime.home);
            const tot = m => m.score.fullTime.home + m.score.fullTime.away;
            const avg = (arr, f) => (arr.length ? (arr.reduce((s, m) => s + f(m), 0) / arr.length).toFixed(2) : 'n/a');
            const rate = (arr, pred) => (arr.length ? `${arr.filter(pred).length}/${arr.length}` : 'n/a');

            const all = finished[code]
                .filter(m => m.homeTeam.id === teamId || m.awayTeam.id === teamId)
                .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));
            const last = all.slice(0, FORM_N);
            const homeOnly = all.filter(side).slice(0, SPLIT_N);
            const awayOnly = all.filter(m => !side(m)).slice(0, SPLIT_N);

            return {
                n: last.length,
                gf: avg(last, gf),
                ga: avg(last, ga),
                o15: rate(last, m => tot(m) > 1.5),
                o25: rate(last, m => tot(m) > 2.5),
                o35: rate(last, m => tot(m) > 3.5),
                btts: rate(last, m => gf(m) > 0 && ga(m) > 0),
                homeN: homeOnly.length,
                homeGf: avg(homeOnly, gf),
                homeGa: avg(homeOnly, ga),
                awayN: awayOnly.length,
                awayGf: avg(awayOnly, gf),
                awayGa: avg(awayOnly, ga),
                rows: last.map(m => `${side(m) ? 'H' : 'A'} ${gf(m)}-${ga(m)}`).join('; '),
            };
        };

        const describe = (name, f) =>
            `${name}: last${f.n} goals for/against avg ${f.gf}/${f.ga}; ` +
            `over1.5 ${f.o15}, over2.5 ${f.o25}, over3.5 ${f.o35}, BTTS ${f.btts}; ` +
            `HOME-only last${f.homeN} gf/ga ${f.homeGf}/${f.homeGa}; ` +
            `AWAY-only last${f.awayN} gf/ga ${f.awayGf}/${f.awayGa}; ` +
            `recent (newest first, H/A own-team view): ${f.rows || 'none'}`;

        const table = candidates.map((m, i) => {
            const h = teamForm(m.competition.code, m.homeTeam.id);
            const a = teamForm(m.competition.code, m.awayTeam.id);
            return `#${i + 1} ${m.competition.code} ${m.homeTeam.name} vs ${m.awayTeam.name} (kickoff ${m.utcDate})\n  ${describe('HOME ' + m.homeTeam.name, h)}\n  ${describe('AWAY ' + m.awayTeam.name, a)}\n  ${oddsLine(candOdds[i])}`;
        }).join('\n');

        const prompt = `You are a football betting analyst. For each match, grade ALL THREE over/under lines separately: 1.5, 2.5 and 3.5 goals (full time). For each line, choose Over or Under and give your own confidence for THAT line. Lines can disagree (e.g. Over 1.5 with Under 3.5). Also give an optional BTTS (both teams to score) Yes or No pick, or null if you see no edge.

Confidence (0-100) is your calibrated probability that that specific pick wins. Use 70+ only when the stats clearly agree. 55-69 is a moderate edge. 40-54 is a weak edge. Below 40 means no real edge. Samples are small (5-8 matches), so be conservative. Use the home-only and away-only splits when the match venue matters. Bookmaker odds, when given, are the market's own probability (vig removed) for each line: weigh them against form, lean toward the market unless the form edge is strong.
reasoning is REQUIRED for every line: one sentence citing the specific numbers behind that line's pick.

Return ONLY a JSON array, one object per match, in order:
{"index": number, "projected_total": number (expected total goals), "lines": {"1.5": {"pick": "Over" or "Under", "confidence": integer 0-100, "reasoning": string}, "2.5": {same shape}, "3.5": {same shape}}, "btts": {"pick": "Yes" or "No", "confidence": integer 0-100, "reasoning": string} or null}

${table}`;

        const ai = await askGemini(prompt);
        const aiList = Array.isArray(ai) ? ai : (ai.matches || ai.predictions || []);

        const picks = existing;
        let added = 0, skipped_invalid = 0;
        candidates.forEach((m, i) => {
            // Match Gemini's answer by its index only. Falling back to array position
            // can attach a pick to the wrong match if Gemini skipped one.
            const raw = aiList.find(x => Number(x.index) === i + 1);
            const h = haveLines.get(m.id) || new Set();
            const projected = Number(raw?.projected_total) || null;
            const base = {
                api_id: m.id,
                sport: `soccer_${m.competition.code}`,
                league: m.competition.name,
                home_team: m.homeTeam.name,
                away_team: m.awayTeam.name,
                game_time: m.utcDate,
                projected,
                result: 'pending',
                actual_total: null,
                actual_home: null,
                actual_away: null,
                is_resolved: false,
                created_at: new Date().toISOString(),
                odds: candOdds[i],
            };
            const push = (market, line, v) => {
                const conf = Math.max(0, Math.min(100, Math.round(Number(v.confidence) || 0)));
                picks.push(normalizePick({
                    ...base,
                    id: market === 'BTTS' ? `${m.id}-BTTS` : `${m.id}-OU-${line}`,
                    market,
                    line,
                    pick: v.pick,
                    confidence_score: conf,
                    confidence: tier(conf),
                    margin: projected && line != null ? Math.abs(projected - line) : null,
                    reasoning: [String(v.reasoning).trim()],
                }));
                added++;
            };
            if (!raw) { skipped_invalid += OU_LINES.filter(l => !h.has(`OU|${l}`)).length; return; }
            for (const line of OU_LINES) {
                if (h.has(`OU|${line}`)) continue;
                const v = validSide(raw.lines?.[String(line)], ['Over', 'Under']);
                if (!v) { skipped_invalid++; continue; }
                push('OU', line, v);
            }
            // BTTS only on a brand-new fixture (no O/U picks yet).
            if (h.size === 0 && raw.btts) {
                const b = validSide(raw.btts, ['Yes', 'No']);
                if (b) push('BTTS', null, b); else skipped_invalid++;
            }
        });

        await savePicks(picks);
        res.json({ success: true, candidates: candidates.length, added, skipped_invalid, lines: OU_LINES, odds: { requests: oddsRequests, fetched: oddsFetched, matched: candOdds.filter(Boolean).length, notes: oddsNotes } });
    } catch (err) {
        console.error('sync error', err);
        res.status(500).json({ error: err.message });
    }
});

// GET|POST /api/update-results - settle picks from final scores (cron + button)
app.all('/api/update-results', async (req, res) => {
    try {
        const picks = await loadPicks();
        const pending = picks.filter(p => p.result === 'pending' && new Date(p.game_time) < new Date());
        if (pending.length === 0) return res.json({ success: true, updated: 0, message: 'nothing to settle' });

        const dates = pending.map(p => new Date(p.game_time).getTime());
        const from = new Date(Math.min(...dates) - 86400000);
        const to = new Date(Math.max(...dates) + 86400000);
        const d = await fd(`/matches?dateFrom=${iso(from)}&dateTo=${iso(to)}&status=FINISHED`);
        const byId = new Map((d.matches || []).map(m => [m.id, m]));

        let updated = 0;
        for (const p of pending) {
            const m = byId.get(p.api_id);
            if (!m || !m.score?.fullTime || m.score.fullTime.home == null) continue;
            const home = m.score.fullTime.home;
            const away = m.score.fullTime.away;
            const result = settle(p, home, away);
            Object.assign(p, {
                actual_home: home,
                actual_away: away,
                actual_total: home + away,
                result,
                is_resolved: true,
                resolved_at: new Date().toISOString(),
            });
            updated++;
        }
        if (updated) await savePicks(picks);
        res.json({ success: true, updated });
    } catch (err) {
        console.error('update-results error', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/stats - accuracy dashboard
app.get('/api/stats', async (req, res) => {
    try {
        const all = await loadPicks();
        const games = all.filter(g => g.is_resolved)
            .sort((a, b) => new Date(b.game_time) - new Date(a.game_time));
        let wins = 0, losses = 0, streak = 0, counting = true;
        const byConf = { high: { wins: 0, losses: 0 }, medium: { wins: 0, losses: 0 }, low: { wins: 0, losses: 0 } };
        const byMarket = { OU: { wins: 0, losses: 0 }, BTTS: { wins: 0, losses: 0 } };
        const byLine = { '1.5': { wins: 0, losses: 0 }, '2.5': { wins: 0, losses: 0 }, '3.5': { wins: 0, losses: 0 } };
        for (const g of games) {
            if (g.result === 'push') continue;
            const isWin = g.result === 'won';
            if (isWin) wins++; else losses++;
            if (byConf[g.confidence]) byConf[g.confidence][isWin ? 'wins' : 'losses']++;
            if (byMarket[g.market]) byMarket[g.market][isWin ? 'wins' : 'losses']++;
            if (g.market === 'OU' && byLine[String(g.line)]) byLine[String(g.line)][isWin ? 'wins' : 'losses']++;
            if (counting) {
                if (streak === 0) streak = isWin ? 1 : -1;
                else if (streak > 0 && isWin) streak++;
                else if (streak < 0 && !isWin) streak--;
                else counting = false;
            }
        }
        res.json({
            total: all.length,
            totalResolved: wins + losses,
            wins,
            losses,
            streak,
            recent: games.slice(0, 10),
            byConfidence: byConf,
            byMarket,
            byLine,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;
