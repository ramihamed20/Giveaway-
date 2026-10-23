const C = window.LOCKIN_GIVEAWAY_CONFIG || {};
const isSet = Boolean(
  /^https:\/\/[\w-]+\.supabase\.co\/?$/.test(C.SUPABASE_URL || '') &&
  C.SUPABASE_PUBLISHABLE_KEY &&
  !C.SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_ME') &&
  C.TURNSTILE_SITE_KEY &&
  C.TURNSTILE_SITE_KEY !== 'TURNSTILE_PUBLIC_SITE_KEY'
);
const $ = id => document.getElementById(id);
const adminMode = new URLSearchParams(location.search).has('admin');
const baseApi = `${(C.SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/contest-api`;
const REC_KEY = 'lockin_giveaway_receipt_v1';
const AUTH_KEY = 'lockin_giveaway_admin_session_v1';
let publicState = null;
let adminState = null;
let widgetId = null;
let turnstileToken = '';
let session = null;
let pending = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function normalizeDigits(value) {
  return String(value || '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '').slice(0, 5);
}
function notice(id, text, kind = 'error') {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.className = `feedback ${kind}`;
}
function busy(button, on, message = 'جارٍ التنفيذ…') {
  if (!button) return;
  if (on) {
    button.dataset.oldText = button.textContent;
    button.textContent = message;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.oldText ?? button.textContent;
    button.disabled = false;
  }
}
async function api(action, payload = {}, auth = false) {
  if (!isSet) throw Error('إعداد المشروع غير مكتمل. راجع ملف config.js');
  const headers = { 'Content-Type': 'application/json', apikey: C.SUPABASE_PUBLISHABLE_KEY };
  if (auth) headers.Authorization = `Bearer ${await validAccessToken()}`;
  const response = await fetch(baseApi, {
    method: 'POST', headers, body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `حدث خطأ (${response.status})`);
  return data;
}
async function loadPublic() {
  if (!isSet) {
    $('entriesCount').textContent = '—';
    $('configWarning').classList.remove('hidden');
    $('signupButton').disabled = true;
    return;
  }
  try {
    const response = await fetch(`${baseApi}?action=state`, {
      headers: { apikey: C.SUPABASE_PUBLISHABLE_KEY }, cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'تعذّر الاتصال بالخادم');
    publicState = data;
    $('entriesCount').textContent = Number(data.participant_count || 0).toLocaleString('en-US');
    $('closedWarning').classList.toggle('hidden', Boolean(data.registration_open));
    $('signupButton').disabled = !data.registration_open;
    if (!data.registration_open) $('signupForm').classList.add('hidden');
    renderWinners(data.winners || []);
  } catch (e) {
    notice('signupFeedback', `تعذّر تحميل المسابقة: ${e.message}`);
  }
}
function winnerHtml(winner) {
  return `<article class="winner-card" aria-label="فائز بجائزة ${esc(winner.prize)}">
      <div class="winner-brand"><img src="./assets/lockin-logo.png" alt="" width="42" height="42"><span>Lock-in<small>GIVEAWAY 2026</small></span></div>
      <span class="winner-kicker">مبروك للفائز!</span>
      <h3>${esc(winner.prize)}</h3>
      <div class="winner-name">${esc(winner.name)}</div>
      <div class="winner-code" dir="ltr">${esc(winner.masked_code)}</div>
      <div class="winner-foot"><span>خمن الرقم المخفي</span><span>${winner.claimed ? '✓ تم استلام الجائزة' : 'احتفظ بتذكرة إثباتك'}</span></div>
    </article>`;
}
function renderWinners(winners) {
  const grid = $('winnersGrid');
  if (!winners.length) {
    grid.innerHTML = `<div class="empty-winners"><div class="empty-star">☆</div><h3>لم يبدأ السحب بعد</h3><p>سيتم عرض الفائزين بعد الإعلان عن النتائج.</p></div>`;
    return;
  }
  grid.innerHTML = winners.map(winnerHtml).join('');
}
function showReceipt(record) {
  $('signupForm').classList.add('hidden');
  $('receiptPanel').classList.remove('hidden');
  $('receiptKey').textContent = record.ticket;
  $('receiptDetail').textContent = `${record.name} · الكود ${record.code}`;
}
function renderCaptcha() {
  if (adminMode || !isSet || widgetId !== null) return;
  if (!window.turnstile) return;
  widgetId = window.turnstile.render('#turnstileWidget', {
    sitekey: C.TURNSTILE_SITE_KEY,
    callback: token => { turnstileToken = token; },
    'expired-callback': () => { turnstileToken = ''; },
    'error-callback': () => { turnstileToken = ''; }
  });
}
async function handleRegistration(event) {
  event.preventDefault();
  if (pending) return;
  const name = $('entryName').value.trim().replace(/\s+/g, ' ');
  const code = normalizeDigits($('entryCode').value);
  if (name.length < 2 || name.length > 50 || !/^\d{5}$/.test(code)) {
    notice('signupFeedback', 'الاسم لازم يكون من 2 إلى 50 حرف، والكود 5 أرقام.');
    return;
  }
  if (!turnstileToken) {
    notice('signupFeedback', 'أكمل اختبار الأمان قبل المشاركة.');
    return;
  }
  const button = $('signupButton');
  pending = true;
  busy(button, true);
  notice('signupFeedback', '');
  try {
    const data = await api('register', { name, code, captcha: turnstileToken });
    const record = { name: data.name, code: data.code, ticket: data.ticket };
    try { localStorage.setItem(REC_KEY, JSON.stringify(record)); } catch { /* private browsing */ }
    showReceipt(record);
    loadPublic();
  } catch (e) {
    notice('signupFeedback', e.message);
  } finally {
    pending = false;
    busy(button, false);
    turnstileToken = '';
    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  }
}
function savedSession() {
  try { return JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
}
function storeSession(info) {
  session = {
    access_token: info.access_token,
    refresh_token: info.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(info.expires_in || 3500)
  };
  sessionStorage.setItem(AUTH_KEY, JSON.stringify(session));
}
async function authRequest(grant, body) {
  const url = `${C.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/token?grant_type=${grant}`;
  const response = await fetch(url, {
    method: 'POST', headers: { apikey: C.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.msg || data.error_description || data.error || 'تعذّر الدخول');
  return data;
}
async function validAccessToken() {
  if (!session) throw Error('يلزم تسجيل الدخول أولًا.');
  if (session.expires_at > Math.floor(Date.now() / 1000) + 60) return session.access_token;
  try {
    const fresh = await authRequest('refresh_token', { refresh_token: session.refresh_token });
    storeSession(fresh);
    return session.access_token;
  } catch (e) {
    logout();
    throw Error('انتهت جلسة الدخول. سجّل دخولك من جديد.');
  }
}
function logout() {
  session = null;
  sessionStorage.removeItem(AUTH_KEY);
  $('adminDashboard').classList.add('hidden');
  $('loginPanel').classList.remove('hidden');
  $('adminPassword').value = '';
}
async function handleLogin(event) {
  event.preventDefault();
  const button = $('loginForm').querySelector('button[type=submit]');
  busy(button, true);
  notice('loginFeedback', '');
  try {
    const info = await authRequest('password', {
      email: $('adminEmail').value.trim(), password: $('adminPassword').value
    });
    storeSession(info);
    await loadAdmin();
  } catch (e) {
    notice('loginFeedback', e.message);
    logout();
  } finally {
    busy(button, false);
  }
}
async function loadAdmin() {
  const data = await api('admin_state', {}, true);
  adminState = data;
  $('loginPanel').classList.add('hidden');
  $('adminDashboard').classList.remove('hidden');
  $('adminEntriesCount').textContent = Number(data.participant_count || 0).toLocaleString('en-US');
  $('adminDrawsCount').textContent = `${data.draws.length} / 6`;
  $('toggleSignupButton').textContent = data.registration_open ? 'إغلاق التسجيل' : 'فتح التسجيل';
  $('toggleSignupButton').className = `button ${data.registration_open ? 'button-primary' : 'button-secondary'}`;
  $('adminPrizes').innerHTML = data.prizes.map(prize => {
    const count = data.draws.filter(draw => draw.prize_id === prize.id).length;
    const canDraw = !data.registration_open && count < prize.winner_limit;
    return `<div class="admin-prize"><h3>${esc(prize.title)}</h3><p>تم اختيار ${count} من ${prize.winner_limit}</p>
      <button class="button button-primary" type="button" data-draw="${prize.id}" ${canDraw ? '' : 'disabled'}>${count === prize.winner_limit ? 'اكتمل السحب ✓' : 'اسحب فائزًا عشوائيًا'}</button></div>`;
  }).join('');
  $('adminDraws').innerHTML = data.draws.length
    ? data.draws.map(draw => `<div class="admin-draw">
        ${winnerHtml(draw)}
        <p class="admin-draw-meta">للمسؤول فقط: الكود الكامل <code dir="ltr">${esc(draw.full_code)}</code> · ${draw.published ? 'النتيجة منشورة' : 'لم تُنشر بعد'}</p>
        <div class="admin-actions">
          <button type="button" class="button button-primary" data-publish="${esc(draw.id)}" data-published="${!draw.published}">${draw.published ? 'إخفاء من الموقع' : 'نشر في الموقع'}</button>
          <button type="button" class="button button-secondary" data-shot="${esc(draw.id)}">عرض للتصوير</button>
        </div>
        ${draw.claimed
          ? '<p class="admin-caption">✓ تم التحقق من صاحب التذكرة واستلام الجائزة.</p>'
          : `<form class="admin-verify" data-verify="${esc(draw.id)}">
              <input class="digit" name="digit" inputmode="numeric" type="text" maxlength="1" pattern="[0-9]" required placeholder="الرقم الناقص" aria-label="الرقم الناقص">
              <input name="ticket" type="text" dir="ltr" required placeholder="تذكرة LK-..." aria-label="تذكرة الإثبات">
              <button class="button button-outline" type="submit">تحقق</button>
            </form>`}
      </div>`).join('')
    : '<div class="admin-empty">ما تم السحب على أي جائزة إلى الآن.</div>';
}
async function runAdminAction(action, values, confirmText, successText) {
  if (pending) return;
  if (confirmText && !confirm(confirmText)) return;
  pending = true;
  notice('adminFeedback', '');
  try {
    await api(action, values, true);
    notice('adminFeedback', successText || 'تم التنفيذ.', 'success');
    await loadAdmin();
  } catch (e) {
    notice('adminFeedback', e.message);
  } finally { pending = false; }
}
function showShot(id) {
  const winner = adminState?.draws.find(d => d.id === id);
  if (!winner) return;
  $('shotFrame').innerHTML = winnerHtml(winner);
  $('shotOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeShot() {
  $('shotOverlay').classList.add('hidden');
  document.body.style.overflow = '';
}
function initAdminActions() {
  $('toggleSignupButton').addEventListener('click', () => runAdminAction('toggle_signup',
    { open: !adminState.registration_open },
    adminState.registration_open ? 'تأكيد إغلاق باب التسجيل؟ لن يستطيع أحد المشاركة بعد ذلك، ويمكنك بدء السحب.' : 'فتح التسجيل من جديد؟ هذا غير مسموح بعد بدء السحب لضمان العدالة.',
    'تم تحديث حالة التسجيل.'));
  $('refreshAdminButton').addEventListener('click', () => loadAdmin().catch(e => notice('adminFeedback', e.message)));
  $('signoutButton').addEventListener('click', logout);
  $('adminPrizes').addEventListener('click', event => {
    const b = event.target.closest('[data-draw]');
    if (!b) return;
    const prize = adminState.prizes.find(p => p.id === Number(b.dataset.draw));
    runAdminAction('draw', { prize_id: Number(b.dataset.draw) },
      `سحب عشوائي نهائي لجائزة «${prize?.title || ''}»؟ لا يمكن إعادة اختيار الفائز.`, 'تم السحب بنجاح! جهّز بطاقة الفائز ونشرها.');
  });
  $('adminDraws').addEventListener('click', event => {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.dataset.publish) runAdminAction('publish',
      { draw_id: b.dataset.publish, published: b.dataset.published === 'true' },
      'تأكيد تغيير ظهور هذه النتيجة للمشاركين؟', 'تم تحديث ظهور النتيجة.');
    if (b.dataset.shot) showShot(b.dataset.shot);
  });
  $('adminDraws').addEventListener('submit', event => {
    const form = event.target.closest('[data-verify]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const digit = normalizeDigits(data.get('digit'));
    runAdminAction('verify', {
      draw_id: form.dataset.verify, digit,
      ticket: String(data.get('ticket') || '').trim()
    }, 'هل سلّمت الجائزة فعلًا لهذا الشخص بعد التأكد من هويته؟ سيتم تسجيلها كمستلمة.',
    'تطابق الرقم مع تذكرة الإثبات. تم تسجيل تسليم الجائزة.');
  });
}

if (adminMode) {
  $('publicPage').classList.add('hidden');
  $('adminPage').classList.remove('hidden');
  $('loginForm').addEventListener('submit', handleLogin);
  initAdminActions();
  $('closeShot').addEventListener('click', closeShot);
  $('shotOverlay').addEventListener('click', e => { if (e.target === $('shotOverlay')) closeShot(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeShot(); });
  session = savedSession();
  if (session && isSet) loadAdmin().catch(() => logout());
  if (!isSet) notice('loginFeedback', 'اربط مشروع Supabase في config.js أولًا.');
} else {
  $('signupForm').addEventListener('submit', handleRegistration);
  $('entryCode').addEventListener('input', e => { e.target.value = normalizeDigits(e.target.value); });
  $('copyReceipt').addEventListener('click', async () => {
    const value = $('receiptKey').textContent;
    try { await navigator.clipboard.writeText(value); $('copyReceipt').textContent = 'تم النسخ ✓'; }
    catch { $('copyReceipt').textContent = 'حدد الرقم وانسخه يدويًا'; }
  });
  $('resetReceipt').addEventListener('click', () => {
    $('receiptPanel').classList.add('hidden');
    if (publicState?.registration_open !== false) $('signupForm').classList.remove('hidden');
  });
  try {
    const record = JSON.parse(localStorage.getItem(REC_KEY) || 'null');
    if (record && record.ticket && record.name && record.code) showReceipt(record);
  } catch { /* private browsing */ }
  const captchaTimer = setInterval(() => {
    if (window.turnstile) {
      clearInterval(captchaTimer);
      try { renderCaptcha(); } catch { notice('signupFeedback', 'تعذّر تحميل التحقق، حدّث الصفحة.'); }
    }
  }, 250);
  setTimeout(() => clearInterval(captchaTimer), 15000);
  loadPublic();
}
