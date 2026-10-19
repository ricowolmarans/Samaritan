import express from 'express';

const {
  GROQ_API_KEY,
  PORT = 3000,
  STT_MODEL = 'whisper-large-v3-turbo',
  LLM_MODEL = 'openai/gpt-oss-20b',
  TTS_MODEL = 'canopylabs/orpheus-v1-english',
  TTS_VOICE = 'troy',
  HA_URL = '',
  HA_TOKEN = '',
  HA_ALLOW_UNLOCK = ''
} = process.env;

if (!GROQ_API_KEY) {
  console.error('Missing GROQ_API_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const GROQ = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const HA_ENABLED = Boolean(HA_URL && HA_TOKEN);
const auth = { Authorization: `Bearer ${GROQ_API_KEY}` };

const SYSTEM =
  'You are Samaritan, a voice assistant on a small speaker with a screen. ' +
  'Reply in one to three short spoken sentences. No markdown, no lists, no emojis.';

const HA_RULES =
  ' You can control the home through Home Assistant tools. Use only entity ids from the device list, ' +
  'or find others with search_entities. After a tool call, confirm in a few words, and only say it worked ' +
  'if the tool result says ok. If a tool returns an error, say so briefly.';

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

// ---- Home Assistant ----
const CONTROL = ['light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'lock', 'scene', 'script', 'input_boolean', 'button'];
const NAME = /^[a-z0-9_]+$/;
let cache = { at: 0, states: [] };

async function ha(path, body) {
  const r = await fetch(`${HA_URL.replace(/\/$/, '')}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`Home Assistant ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function states() {
  if (Date.now() - cache.at > 30000) cache = { at: Date.now(), states: await ha('states') };
  return cache.states;
}

const line = (st) => `${st.entity_id} | ${st.attributes.friendly_name || ''} | ${st.state}`;

async function deviceList() {
  const all = await states();
  return all
    .filter((st) => CONTROL.includes(st.entity_id.split('.')[0]))
    .slice(0, 150)
    .map(line)
    .join('\n');
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'call_service',
      description:
        'Control a device in Home Assistant, for example light.turn_on, light.turn_off, switch.toggle, ' +
        'cover.close_cover, climate.set_temperature, media_player.volume_set, scene.turn_on.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'For example light, switch, climate' },
          service: { type: 'string', description: 'For example turn_on, turn_off, set_temperature' },
          entity_id: { type: 'string', description: 'One entity id, for example light.living_room' },
          data: { type: 'object', description: 'Optional extras, for example {"brightness_pct": 40} or {"temperature": 21}' }
        },
        required: ['domain', 'service', 'entity_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_state',
      description: 'Get the current state of one entity, for example a sensor, a light or a door.',
      parameters: {
        type: 'object',
        properties: { entity_id: { type: 'string' } },
        required: ['entity_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_entities',
      description: 'Find entities (including sensors) by name when the device list does not include them.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  }
];

async function runTool(name, args) {
  try {
    if (name === 'search_entities') {
      const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = (await states()).filter((st) => {
        const hay = `${st.entity_id} ${st.attributes.friendly_name || ''}`.toLowerCase();
        return terms.length && terms.every((t) => hay.includes(t));
      });
      return { results: hits.slice(0, 10).map(line) };
    }
    if (name === 'get_state') {
      if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(String(args.entity_id))) return { error: 'Bad entity_id' };
      const st = await ha(`states/${args.entity_id}`);
      const { friendly_name, unit_of_measurement, device_class } = st.attributes;
      return { entity_id: st.entity_id, state: st.state, friendly_name, unit_of_measurement, device_class };
    }
    if (name === 'call_service') {
      const { domain, service, entity_id, data } = args;
      if (!NAME.test(String(domain)) || !NAME.test(String(service))) return { error: 'Bad domain or service' };
      if (!CONTROL.includes(domain)) return { error: `The ${domain} domain is not allowed` };
      if (typeof entity_id !== 'string' || !entity_id.startsWith(`${domain}.`)) {
        return { error: 'entity_id must be one id in that domain' };
      }
      if (domain === 'lock' && ['unlock', 'open'].includes(service) && HA_ALLOW_UNLOCK !== 'true') {
        return { error: 'Unlocking by voice is turned off' };
      }
      await ha(`services/${domain}/${service}`, { ...(data && typeof data === 'object' ? data : {}), entity_id });
      cache.at = 0;
      return { ok: true };
    }
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: e.message };
  }
}

async function chat(text) {
  history.push({ role: 'user', content: text });
  history = history.slice(-12);

  let system = SYSTEM;
  if (HA_ENABLED) {
    system += HA_RULES;
    try {
      system += `\n\nHome devices (entity_id | name | state):\n${await deviceList()}`;
    } catch (e) {
      console.error(e.message);
      system += '\n\nHome Assistant is not reachable right now, so say you cannot control the home.';
    }
  }
  const messages = [{ role: 'system', content: system }, ...history];

  for (let step = 0; step < 4; step++) {
    const r = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature: 0.6,
        reasoning_effort: 'low',
        max_completion_tokens: 800,
        ...(HA_ENABLED ? { tools, tool_choice: 'auto' } : {})
      })
    });
    if (!r.ok) throw new Error(`Chat failed (${r.status}): ${await r.text()}`);
    const msg = (await r.json()).choices[0].message;

    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* bad JSON from the model */ }
        console.log('Tool:', tc.function.name, JSON.stringify(args));
        const result = await runTool(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const reply = (msg.content || '').trim();
    if (!reply) throw new Error('The model returned an empty reply');
    history.push({ role: 'assistant', content: reply });
    return reply;
  }
  throw new Error('Too many tool steps in one turn');
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

if (HA_ENABLED) {
  ha('')
    .then(() => console.log('Home Assistant connected'))
    .catch((e) => console.error('Home Assistant check failed:', e.message));
} else {
  console.log('Home Assistant is off (set HA_URL and HA_TOKEN in .env to turn it on)');
}
