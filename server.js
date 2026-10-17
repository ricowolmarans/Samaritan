import express from 'express';

const {
  GROQ_API_KEY,
  PORT = 3000,
  STT_MODEL = 'whisper-large-v3-turbo',
  LLM_MODEL = 'openai/gpt-oss-20b',
  TTS_MODEL = 'canopylabs/orpheus-v1-english',
  TTS_VOICE = 'troy'
} = process.env;

if (!GROQ_API_KEY) {
  console.error('Missing GROQ_API_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const GROQ = 'https://api.groq.com/openai/v1';
const auth = { Authorization: `Bearer ${GROQ_API_KEY}` };

const SYSTEM =
  'You are Samaritan, a voice assistant on a small speaker with a screen. ' +
  'Reply in one to three short spoken sentences. No markdown, no lists, no emojis.';

let history = [];

async function transcribe(buf, mime) {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `speech.${ext}`);
  form.append('model', STT_MODEL);
  form.append('response_format', 'json');
  const r = await fetch(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: auth, body: form });
  if (!r.ok) throw new Error(`Speech-to-text failed (${r.status}): ${await r.text()}`);
  return ((await r.json()).text || '').trim();
}

async function chat(text) {
  history.push({ role: 'user', content: text });
  history = history.slice(-12);
  const r = await fetch(`${GROQ}/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      temperature: 0.6,
      reasoning_effort: 'low',
      max_completion_tokens: 800
    })
  });
  if (!r.ok) throw new Error(`Chat failed (${r.status}): ${await r.text()}`);
  const reply = ((await r.json()).choices[0].message.content || '').trim();
  if (!reply) throw new Error('The model returned an empty reply');
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// Keep each speech request short, split on sentences.
function chunk(text, max = 190) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = '';
    }
    cur += s;
    while (cur.length > max) {
      out.push(cur.slice(0, max).trim());
      cur = cur.slice(max);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function speak(text) {
  const r = await fetch(`${GROQ}/audio/speech`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'wav' })
  });
  if (!r.ok) throw new Error(`Text-to-speech failed (${r.status}): ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

const app = express();
app.use(express.static('public'));

app.post('/api/talk', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No audio received' });
    const mime = req.headers['content-type'] || 'audio/webm';

    const heard = await transcribe(req.body, mime);
    if (!heard) return res.json({ heard: '', reply: '', audio: [] });
    console.log('Heard:', heard);

    const reply = await chat(heard);
    console.log('Reply:', reply);

    let audio = [];
    let ttsError = null;
    try {
      audio = await Promise.all(chunk(reply).map(async (s) => (await speak(s)).toString('base64')));
    } catch (e) {
      ttsError = e.message;
      console.error(e.message);
    }
    res.json({ heard, reply, audio, ttsError });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Samaritan running on http://0.0.0.0:${PORT}`));
