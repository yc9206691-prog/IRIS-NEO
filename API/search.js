// api/search.js — Vercel Serverless Function
// Privacy-First AI Search: DuckDuckGo scraper + Gemini AI + Vision (Image Search)

const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];
const getUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ── Collect Gemini Keys ───────────────────────────────────────────────────────
function getKeys() {
  return [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ].filter(Boolean);
}

// ── DuckDuckGo HTML Scraper ───────────────────────────────────────────────────
async function scrapeResults(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': getUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://duckduckgo.com/',
      'Cache-Control': 'no-cache',
    },
    timeout: 10000,
  });

  const $ = cheerio.load(data);
  const results = [];

  $('.result__body, .result').each((i, el) => {
    if (results.length >= 8) return false;
    const titleEl = $(el).find('.result__title a, .result__a');
    const snippetEl = $(el).find('.result__snippet');
    const title = titleEl.text().trim();
    const snippet = snippetEl.text().trim();
    let url = titleEl.attr('href') || '';
    if (url.includes('uddg=')) {
      try { const m = url.match(/uddg=([^&]+)/); if(m) url = decodeURIComponent(m[1]); } catch(_){}
    }
    if (title && snippet) results.push({ title, snippet, url: url || '#' });
  });

  if (results.length === 0) {
    $('h2 a, h3 a').each((i, el) => {
      if (results.length >= 8) return false;
      const title = $(el).text().trim();
      const url = $(el).attr('href') || '#';
      const snippet = $(el).closest('div').find('p').first().text().trim() || '';
      if (title) results.push({ title, snippet, url });
    });
  }

  return results;
}

// ── Gemini Text Call with Key Rotation ───────────────────────────────────────
async function callGemini(payload, keys) {
  const errors = [];
  for (const apiKey of keys) {
    if (!apiKey) continue;
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        { ...payload, generationConfig: { temperature: 0.7, maxOutputTokens: 900 } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
      );
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text.trim();
    } catch (err) {
      errors.push(`[${err.response?.status||'ERR'}] ${err.response?.data?.error?.message || err.message}`);
      continue;
    }
  }
  throw new Error('All keys failed: ' + errors.join(' | '));
}

// ── Image Analysis ────────────────────────────────────────────────────────────
async function analyzeImage(imageBase64, imageMime, lang, keys) {
  const langInstruction = lang === 'hi'
    ? 'Respond in Hindi (Devanagari script). Use clear, simple Hindi.'
    : 'Respond in English.';

  const payload = {
    contents: [{
      parts: [
        {
          inline_data: {
            mime_type: imageMime || 'image/jpeg',
            data: imageBase64,
          }
        },
        {
          text: `Analyze this image thoroughly. Describe what you see, identify any text, objects, people, places, or notable elements. Then provide any useful context or information about what's shown. ${langInstruction}`
        }
      ]
    }]
  };

  return await callGemini(payload, keys);
}

// ── File Analysis ─────────────────────────────────────────────────────────────
async function analyzeFile(fileName, fileContent, fileType, isTextFile, query, lang, keys) {
  const langInstruction = lang === 'hi'
    ? 'Respond in Hindi (Devanagari script). Use clear, simple Hindi.'
    : 'Respond in English.';

  const userQuestion = query
    ? `User's question about this file: "${query}"`
    : `Provide a comprehensive summary and key insights from this file.`;

  let payload;

  if (isTextFile) {
    const truncated = fileContent.length > 12000
      ? fileContent.slice(0, 12000) + '\n\n[... content truncated ...]'
      : fileContent;

    payload = {
      contents: [{
        parts: [{
          text: `You are analyzing a file uploaded by the user.\n\nFile name: ${fileName}\nFile type: ${fileType || 'text'}\n\n--- FILE CONTENT START ---\n${truncated}\n--- FILE CONTENT END ---\n\n${userQuestion}\n\nGive a clear, well-structured response. ${langInstruction}`
        }]
      }]
    };
  } else {
    payload = {
      contents: [{
        parts: [
          { inline_data: { mime_type: fileType || 'application/pdf', data: fileContent } },
          { text: `File name: ${fileName}\n\n${userQuestion}\n\nGive a clear, well-structured response. ${langInstruction}` }
        ]
      }]
    };
  }

  return await callGemini(payload, keys);
}


function buildPrompt(query, results, lang) {
  const snippets = results.slice(0, 5)
    .map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}`)
    .join('\n\n');
  const langInstr = lang === 'hi'
    ? 'Respond in Hindi (Devanagari script). Use clear, simple Hindi.'
    : 'Respond in English.';
  return `You are a helpful AI assistant in a privacy-first search browser.
User searched: "${query}"

Top web results:
---
${snippets}
---

Synthesize a clear, concise, human-friendly answer (3-5 sentences max). ${langInstr}
Do NOT mention reading search results. Just answer naturally.`;
}

// ── Main Handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const keys = getKeys();

  // ── POST: Image Analysis / File Analysis ─────────────────────────────────
  if (req.method === 'POST') {
    const { imageBase64, imageMime, fileName, fileContent, fileType, isTextFile, query, lang = 'en' } = req.body || {};

    if (keys.length === 0) return res.status(503).json({ error: 'No Gemini API keys configured.' });

    // File upload
    if (fileName && fileContent) {
      try {
        const answer = await analyzeFile(fileName, fileContent, fileType, isTextFile, query, lang, keys);
        return res.status(200).json({ aiAnswer: answer, mode: 'FILE_ANALYSIS', fileName });
      } catch (err) {
        return res.status(503).json({ error: 'File analysis failed: ' + err.message });
      }
    }

    // Image analysis
    if (imageBase64) {
      try {
        const answer = await analyzeImage(imageBase64, imageMime, lang, keys);
        return res.status(200).json({ aiAnswer: answer, mode: 'IMAGE_VISION' });
      } catch (err) {
        return res.status(503).json({ error: 'Image analysis failed: ' + err.message });
      }
    }

    return res.status(400).json({ error: 'Provide either imageBase64 or fileName + fileContent.' });
  }

  // ── GET: Text Search ──────────────────────────────────────────────────────
  const { q: query, lang = 'en' } = req.query;
  if (!query?.trim()) return res.status(400).json({ error: 'Query `q` is required.' });

  let results = [], scrapeError = null;

  try {
    results = await scrapeResults(query.trim());
  } catch (err) {
    scrapeError = err.message;
    console.error('[SCRAPE]', scrapeError);
  }

  // AI + Results
  if (keys.length > 0 && results.length > 0) {
    try {
      const prompt = buildPrompt(query.trim(), results, lang);
      const answer = await callGemini({ contents: [{ parts: [{ text: prompt }] }] }, keys);
      return res.status(200).json({ query, aiAnswer: answer, results, mode: 'AI+WEB', count: results.length });
    } catch (aiErr) {
      return res.status(200).json({ query, aiAnswer: null, results, mode: 'WEB_ONLY', count: results.length, error: 'AI unavailable: ' + aiErr.message.split('|')[0] });
    }
  }

  // AI only (no scrape results)
  if (keys.length > 0 && results.length === 0) {
    try {
      const langInstr = lang === 'hi' ? 'Respond in Hindi.' : 'Respond in English.';
      const prompt = `Answer briefly (3-5 sentences): "${query}"\n${langInstr}`;
      const answer = await callGemini({ contents: [{ parts: [{ text: prompt }] }] }, keys);
      return res.status(200).json({ query, aiAnswer: answer, results: [], mode: 'AI_ONLY', count: 0, error: scrapeError ? 'Web scrape failed' : undefined });
    } catch (aiErr) {
      return res.status(503).json({ query, error: 'All systems failed. Try again.', results: [] });
    }
  }

  // Raw results only
  if (results.length > 0) {
    return res.status(200).json({ query, aiAnswer: null, results, mode: 'WEB_ONLY', count: results.length, error: 'No Gemini API keys. Add GEMINI_API_KEY_1 in Vercel env vars.' });
  }

  return res.status(503).json({ query, error: scrapeError || 'No results found.', results: [] });
};
