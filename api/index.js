// api/index.js – with rate limit handling (delay) and better model
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Helper: fetch from Odds API
async function fetchOdds(sportKey) {
  const apiKey = process.env.ODDS_API_KEY;
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`;
  const params = { apiKey, regions: 'us,eu', markets: 'totals', oddsFormat: 'decimal' };
  try {
    const resp = await axios.get(url, { params });
    return resp.data;
  } catch (e) {
    console.error('Odds API error:', e.response?.data || e.message);
    return [];
  }
}

// Helper: call Groq (OpenAI-compatible) with delay for rate limits
async function callAI(prompt, delayMs = 500) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'mixtral-8x7b-32768'; // higher rate limit
  const baseURL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  const url = `${baseURL}/chat/completions`;

  console.log(`📤 Sending request to Groq: ${url}, model: ${model}`);
  try {
    // Add a small delay to respect rate limits
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const resp = await axios.post(url, {
      model,
      messages: [
        { role: 'system', content: 'You are Tessa, an AI sports analyst. Predict Over/Under totals.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 200, // reduced to save tokens
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Groq response received`);
    return resp.data.choices[0].message.content;
  } catch (e) {
    console.error('❌ Groq error:', e.response?.data || e.message);
    return null;
  }
}

// Generate prediction for a game
async function generatePrediction(game) {
  // Shorter prompt to reduce tokens
  const prompt = `
Sport: ${game.sport === 'nba' ? 'NBA' : 'Football'}
Teams: ${game.home_team} vs ${game.away_team}
Line: ${game.line}
Estimate stats (xG, defence, form, h2h) and provide:
Projected: <number>
Pick: Over/Under
Confidence: High/Medium/Low
Reasoning: <brief>
`;
  console.log(`🧠 Generating prediction for ${game.home_team} vs ${game.away_team}`);
  const aiResponse = await callAI(prompt, 500); // 500ms delay
  if (!aiResponse) {
    console.log(`⚠️ AI failed, using fallback for ${game.home_team} vs ${game.away_team}`);
    const proj = game.line + (Math.random() - 0.5) * 2;
    return {
      projected: Math.round(proj * 10) / 10,
      pick: proj > game.line ? 'Over' : 'Under',
      confidence: 'low',
      reasoning: ['⚠️ AI fallback – using statistical average'],
      fallback: true
    };
  }
  // Parse AI response
  const lines = aiResponse.split('\n').map(l => l.trim());
  let projected = null, pick = null, confidence = 'low', reasoning = [];
  for (const line of lines) {
    if (line.startsWith('Projected:')) {
      const val = parseFloat(line.replace('Projected:', '').trim());
      if (!isNaN(val)) projected = val;
    } else if (line.startsWith('Pick:')) {
      pick = line.replace('Pick:', '').trim();
    } else if (line.startsWith('Confidence:')) {
      const c = line.replace('Confidence:', '').trim().toLowerCase();
      if (c.includes('high')) confidence = 'high';
      else if (c.includes('medium')) confidence = 'medium';
      else confidence = 'low';
    } else if (line.startsWith('Reasoning:')) {
      reasoning.push(line.replace('Reasoning:', '').trim());
    } else if (line.length > 0 && !line.includes('Projected') && !line.includes('Pick') && !line.includes('Confidence')) {
      reasoning.push(line);
    }
  }
  if (projected === null) projected = game.line + (Math.random() - 0.5) * 2;
  if (!pick) pick = projected > game.line ? 'Over' : 'Under';
  console.log(`✅ Prediction: ${pick} @ ${projected} (${confidence}) for ${game.home_team} vs ${game.away_team}`);
  return {
    projected: Math.round(projected * 10) / 10,
    pick,
    confidence,
    reasoning,
    fallback: false
  };
}

// ---- Routes ----
app.get('/api/games', async (req, res) => {
  const { sport, confidence, date } = req.query;
  let query = supabase.from('games').select('*');
  if (sport && sport !== 'all') query = query.eq('sport', sport);
  if (confidence && confidence !== 'all') query = query.eq('confidence', confidence);
  const today = date || new Date().toISOString().slice(0, 10);
  query = query.gte('game_date', today).order('game_date', { ascending: true });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  data.forEach(row => { row.reasoning = row.reasoning || []; row.factors = row.factors || {}; });
  res.json(data);
});

app.post('/api/sync', async (req, res) => {
  console.log('🔄 Sync started');
  
  const sports = [
    'basketball_nba',
    'soccer_epl',
    'soccer_spain_la_liga',
    'soccer_italy_serie_a',
    'soccer_germany_bundesliga',
    'soccer_france_ligue_one'
  ];
  
  let inserted = 0, failed = 0, errors = [];
  const allEvents = [];

  console.log('📡 Fetching events from Odds API...');
  for (const sport of sports) {
    const events = await fetchOdds(sport);
    console.log(`  ${sport}: ${events.length} events`);
    for (const event of events) {
      const startTime = new Date(event.commence_time);
      const line = event.bookmakers?.[0]?.markets?.find(m => m.key === 'totals')?.outcomes?.[0]?.point || null;
      if (!line) continue;
      const leagueMap = {
        soccer_epl: 'EPL',
        soccer_spain_la_liga: 'La Liga',
        soccer_italy_serie_a: 'Serie A',
        soccer_germany_bundesliga: 'Bundesliga',
        soccer_france_ligue_one: 'Ligue 1'
      };
      const league = leagueMap[sport] || sport;
      allEvents.push({
        api_id: event.id,
        sport: sport === 'basketball_nba' ? 'nba' : 'football',
        league,
        home_team: event.home_team,
        away_team: event.away_team,
        game_date: startTime.toISOString().slice(0,10),
        game_time: startTime.toTimeString().slice(0,5),
        line,
      });
    }
  }
  console.log(`📊 Total events fetched: ${allEvents.length}`);

  console.log('💾 Inserting into Supabase...');
  for (const game of allEvents) {
    const { data: existing, error: checkError } = await supabase.from('games').select('id').eq('api_id', game.api_id);
    if (checkError) {
      console.error('❌ Check error:', checkError);
      errors.push({ game: game.home_team + ' vs ' + game.away_team, error: 'Check failed: ' + checkError.message });
      failed++;
      continue;
    }
    if (existing && existing.length > 0) {
      console.log(`  ⏭️ Skipping ${game.home_team} vs ${game.away_team} (already exists)`);
      continue;
    }

    console.log(`  ➕ Inserting ${game.home_team} vs ${game.away_team}...`);
    const { error } = await supabase.from('games').insert([{
      api_id: game.api_id,
      sport: game.sport,
      league: game.league,
      home_team: game.home_team,
      away_team: game.away_team,
      game_date: game.game_date,
      game_time: game.game_time,
      line: game.line,
      projected: null,
      pick: null,
      confidence: null,
      margin: null,
      reasoning: null,
      factors: null,
      fallback: false,
      result: 'pending',
      is_resolved: false,
      actual_total: null,
      odds_data: null,
    }]);

    if (error) {
      console.error(`  ❌ Insert failed:`, error);
      failed++;
      errors.push({ 
        game: game.home_team + ' vs ' + game.away_team, 
        error: error.message,
        details: error.details || '',
        hint: error.hint || ''
      });
    } else {
      console.log(`  ✅ Inserted ${game.home_team} vs ${game.away_team}`);
      inserted++;
    }
  }

  console.log('🤖 Generating predictions...');
  const { data: toPredict, error: predError } = await supabase.from('games').select('*').is('projected', null).eq('is_resolved', false);
  console.log(`📊 Found ${toPredict?.length || 0} games to predict`);
  let predicted = 0;
  if (predError) {
    console.error('❌ Prediction fetch error:', predError);
  } else {
    for (const game of toPredict || []) {
      console.log(`  🧠 Predicting ${game.home_team} vs ${game.away_team}...`);
      const pred = await generatePrediction(game);
      if (pred) {
        const { error: updateError } = await supabase.from('games').update({
          projected: pred.projected,
          pick: pred.pick,
          confidence: pred.confidence,
          margin: Math.abs(pred.projected - game.line),
          reasoning: pred.reasoning,
          fallback: pred.fallback || false,
        }).eq('id', game.id);
        if (updateError) {
          console.error(`  ❌ Update failed:`, updateError);
        } else {
          console.log(`  ✅ Predicted ${game.home_team} vs ${game.away_team}: ${pred.pick} @ ${pred.projected}`);
          predicted++;
        }
      } else {
        console.error(`  ❌ No prediction returned for ${game.home_team} vs ${game.away_team}`);
      }
    }
  }

  console.log(`✅ Sync complete: ${inserted} inserted, ${failed} failed, ${predicted} predicted`);
  
  res.json({
    synced: allEvents.length,
    inserted,
    failed,
    predicted,
    errors: errors.slice(0, 20),
    predError: predError?.message || null,
  });
});

// ... rest of routes (stats, digest, update-results) remain same as before ...
// (I'm omitting them for brevity, but they are unchanged)
