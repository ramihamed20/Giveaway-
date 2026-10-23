// Supabase Edge Function: contest-api
// Deploy with verify_jwt = false: public calls are protected by Turnstile,
// privileged calls explicitly verify an Auth user AND an admin allowlist.
import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

const API_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET') ?? '';
const IP_HASH_SECRET = Deno.env.get('IP_HASH_SECRET') ?? SERVICE_KEY;
const ALLOWED_ORIGIN = (Deno.env.get('ALLOWED_ORIGIN') ?? 'https://ramihamed20.github.io').replace(/\/$/, '');
const supabase = createClient(API_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const json = (body: unknown, status = 200, origin = '*') => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  }
});

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
function randomTicket() {
  const data = crypto.getRandomValues(new Uint8Array(20));
  return 'LK-' + [...data].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function masked(code: string, hidden: number) {
  return [...code].map((v, i) => i === hidden ? '●' : v).join('');
}
function isValidName(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length >= 2 && s.trim().length <= 50 && !/[\r\n<>]/.test(s);
}
function errorMessage(message: string, status: number, origin: string) { return json({ error: message }, status, origin); }

async function getSettings() {
  const { data, error } = await supabase.from('contest_settings')
    .select('registration_open').eq('id', true).single();
  if (error) throw error;
  return data;
}
async function getPrizeList() {
  const { data, error } = await supabase.from('contest_prizes')
    .select('id,title,winner_limit').order('id');
  if (error) throw error;
  return data;
}
async function getDraws() {
  const { data, error } = await supabase.from('contest_draws')
    .select('id,prize_id,entry_id,hidden_position,published,claimed_at,created_at,contest_entries!contest_draws_entry_id_fkey(display_name,chosen_code)')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
async function getEntryCount() {
  const { count, error } = await supabase.from('contest_entries')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}
function entryData(draw: any) {
  return draw.contest_entries as { display_name: string, chosen_code: string };
}
function asPublished(draw: any, prizes: any[]) {
  const entry = entryData(draw);
  const prize = prizes.find(p => p.id === draw.prize_id);
  return {
    id: draw.id,
    name: entry.display_name,
    masked_code: masked(entry.chosen_code, draw.hidden_position),
    prize: prize?.title ?? '',
    prize_id: draw.prize_id,
    claimed: Boolean(draw.claimed_at),
    created_at: draw.created_at
  };
}
async function checkAdmin(req: Request) {
  const header = req.headers.get('authorization') ?? '';
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return false;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return false;
  const { data, error: adminError } = await supabase.from('contest_admins')
    .select('user_id').eq('user_id', user.id).maybeSingle();
  return !adminError && Boolean(data);
}
async function checkCaptcha(token: string, ip: string) {
  if (!TURNSTILE_SECRET) throw Error('TURNSTILE_NOT_CONFIGURED');
  const form = new FormData();
  form.append('secret', TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form
  });
  if (!res.ok) throw Error('CAPTCHA_UNAVAILABLE');
  const verification = await res.json();
  if (!verification.success) return false;
  // Optionally require a specific hostname for live deployments.
  const expected = Deno.env.get('TURNSTILE_HOSTNAME');
  if (expected && verification.hostname !== expected) return false;
  return true;
}
async function register(body: any, req: Request, origin: string) {
  const name = body?.name;
  const code = body?.code;
  const captcha = body?.captcha;
  if (!isValidName(name) || typeof code !== 'string' || !/^\d{5}$/.test(code))
    return errorMessage('الاسم أو الكود غير صالح. الكود لازم يكون 5 أرقام بالضبط.', 400, origin);
  const ip = (req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? '').split(',')[0]?.trim() ?? '';
  if (TURNSTILE_SECRET) {
    if (!captcha || typeof captcha !== 'string')
      return errorMessage('أكمل اختبار التحقق قبل التسجيل.', 400, origin);
    const validCaptcha = await checkCaptcha(captcha, ip);
    if (!validCaptcha) return errorMessage('اختبار التحقق فشل. حاول مرة ثانية.', 400, origin);
  } else if (!ip) {
    return errorMessage('تعذّر التحقق من الشبكة. حاول لاحقًا.', 503, origin);
  }

  let ipDigest: string | null = null;
  if (IP_HASH_SECRET && ip) ipDigest = await sha256(`${IP_HASH_SECRET}:lockin-giveaway:${ip}`);

  const ticket = randomTicket();
  const receiptDigest = await sha256(ticket);
  const { data, error } = await supabase.rpc('contest_register', {
    p_name: name.trim().replace(/\s+/g, ' '),
    p_code: code,
    p_receipt_digest: receiptDigest,
    p_ip_digest: ipDigest
  });
  if (error?.code === '23505') return errorMessage('هذا الكود مستخدم. جرّب كود ثاني.', 409, origin);
  if (error) {
    if (error.message.includes('REGISTRATION_CLOSED')) return errorMessage('التسجيل مغلق.', 409, origin);
    if (error.message.includes('IP_RATE_LIMIT')) return errorMessage('تم بلوغ حد المشاركات من هذه الشبكة في المسابقة.', 429, origin);
    if (error.message.includes('IP_WAIT')) return errorMessage('انتظر قليلًا قبل تسجيل مشاركة جديدة.', 429, origin);
    throw error;
  }
  return json({ ok: true, name: name.trim().replace(/\s+/g, ' '), code, ticket }, 201, origin);
}

Deno.serve(async (req: Request) => {
  const originHeader = (req.headers.get('Origin') ?? '').replace(/\/$/, '');
  const origin = ALLOWED_ORIGIN ? (originHeader === ALLOWED_ORIGIN ? originHeader : 'null') : '*';
  if (req.method === 'OPTIONS') return json({ ok: true }, 200, origin);
  if (ALLOWED_ORIGIN && originHeader && originHeader !== ALLOWED_ORIGIN)
    return errorMessage('Origin not permitted', 403, origin);

  try {
    if (!API_URL || !SERVICE_KEY) throw Error('SUPABASE_CONFIG_MISSING');
    const url = new URL(req.url);
    if (req.method === 'GET') {
      if (url.searchParams.get('action') !== 'state') return errorMessage('Not found', 404, origin);
      const [settings, prizes, draws, entryCount] = await Promise.all([
        getSettings(), getPrizeList(), getDraws(), getEntryCount()
      ]);
      return json({
        registration_open: settings.registration_open,
        participant_count: entryCount,
        prizes,
        winners: draws.filter(d => d.published).map(d => asPublished(d, prizes))
      }, 200, origin);
    }

    if (req.method !== 'POST') return errorMessage('Method not allowed', 405, origin);
    const body = await req.json();
    if (body?.action === 'register') return await register(body, req, origin);

    if (!await checkAdmin(req)) return errorMessage('غير مسموح: يلزم الدخول بحساب مسؤول مخوّل.', 403, origin);

    if (body?.action === 'admin_state') {
      const [settings, prizes, draws, entryCount] = await Promise.all([
        getSettings(), getPrizeList(), getDraws(), getEntryCount()
      ]);
      return json({ registration_open: settings.registration_open, participant_count: entryCount,
        prizes,
        draws: draws.map(d => ({ ...asPublished(d, prizes), published: d.published,
          full_code: entryData(d).chosen_code, hidden_position: d.hidden_position,
          claimed_at: d.claimed_at }))
      }, 200, origin);
    }
    if (body?.action === 'toggle_signup') {
      if (typeof body.open !== 'boolean') return errorMessage('Invalid value', 400, origin);
      const { error } = await supabase.rpc('contest_set_registration', { p_open: body.open });
      if (error) {
        if (error.message.includes('CANNOT_REOPEN_AFTER_DRAW'))
          return errorMessage('لا يمكن فتح التسجيل بعد بدء السحب حفاظًا على عدالة المسابقة.', 409, origin);
        throw error;
      }
      return json({ ok: true }, 200, origin);
    }
    if (body?.action === 'draw') {
      const prizeId = Number(body.prize_id);
      if (![1,2,3,4].includes(prizeId)) return errorMessage('Invalid prize', 400, origin);
      const { data, error } = await supabase.rpc('contest_draw', { p_prize_id: prizeId });
      if (error) {
        const msg = String(error.message);
        if (msg.includes('CLOSE_REGISTRATION_FIRST')) return errorMessage('اقفل التسجيل قبل السحب.', 409, origin);
        if (msg.includes('PRIZE_FINISHED')) return errorMessage('اكتمل عدد الفائزين لهذه الجائزة.', 409, origin);
        if (msg.includes('NO_ELIGIBLE_ENTRIES')) return errorMessage('مافيش مشاركين متاحين للسحب.', 409, origin);
        throw error;
      }
      return json({ ok: true, draw_id: data }, 200, origin);
    }
    if (body?.action === 'publish') {
      if (typeof body.draw_id !== 'string' || typeof body.published !== 'boolean')
        return errorMessage('Invalid request', 400, origin);
      const { data, error } = await supabase.from('contest_draws')
        .update({ published: body.published }).eq('id', body.draw_id).select('id').maybeSingle();
      if (error) throw error;
      if (!data) return errorMessage('الفائز غير موجود.', 404, origin);
      return json({ ok: true }, 200, origin);
    }
    if (body?.action === 'verify') {
      if (typeof body.draw_id !== 'string' || typeof body.ticket !== 'string' ||
          typeof body.digit !== 'string' || !/^\d$/.test(body.digit))
        return errorMessage('أدخل رقمًا واحدًا وتذكرة الإثبات.', 400, origin);
      const { data: draw, error } = await supabase.from('contest_draws')
        .select('id,hidden_position,published,claimed_at,contest_entries!contest_draws_entry_id_fkey(chosen_code,receipt_digest)')
        .eq('id', body.draw_id).maybeSingle();
      if (error) throw error;
      if (!draw) return errorMessage('الفائز غير موجود.', 404, origin);
      if (!draw.published) return errorMessage('انشر النتيجة أولًا.', 409, origin);
      if (draw.claimed_at) return errorMessage('هذه الجائزة تم تسليمها بالفعل.', 409, origin);
      const entry: any = draw.contest_entries;
      const actualHash = await sha256(body.ticket.trim().toUpperCase());
      if (entry.chosen_code[draw.hidden_position] !== body.digit || entry.receipt_digest !== actualHash)
        return errorMessage('الرقم الناقص أو تذكرة الإثبات غير صحيح.', 400, origin);
      const { error: updateError } = await supabase.from('contest_draws')
        .update({ claimed_at: new Date().toISOString() }).eq('id', draw.id).is('claimed_at', null);
      if (updateError) throw updateError;
      return json({ ok: true }, 200, origin);
    }
    return errorMessage('Unknown action', 400, origin);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('contest-api error:', message);
    if (message === 'TURNSTILE_NOT_CONFIGURED' || message === 'SUPABASE_CONFIG_MISSING')
      return errorMessage('إعداد السيرفر غير مكتمل. راجع Secrets.', 503, origin);
    if (message === 'CAPTCHA_UNAVAILABLE')
      return errorMessage('التحقق غير متاح مؤقتًا. حاول لاحقًا.', 503, origin);
    return errorMessage('حصل خطأ غير متوقع. حاول مرة ثانية.', 500, origin);
  }
});
