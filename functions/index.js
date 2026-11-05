// دوال الخادم: ربط الطلبات بأي API، إشعارات تيليجرام، Meta/TikTok Conversions API، وواجهة API خارجية.
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();
const db = admin.firestore();

const GRAPH_VERSION = 'v21.0'; // تحقق من أحدث إصدار في وثائق Meta قبل الاستعمال

async function cfg() { const s = await db.doc('private/integrations').get(); return s.exists ? s.data() : {}; }
async function pixels() { const s = await db.doc('settings/public').get(); try { return JSON.parse((s.data() || {}).dz_pixels || '{}'); } catch (e) { return {}; } }
const sha = v => crypto.createHash('sha256').update(String(v || '').trim().toLowerCase()).digest('hex');
function phone(p) { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '213' + d.slice(1); return d; }
function render(t, ctx, json) {
  return String(t || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => {
    let v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), ctx);
    v = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return json ? JSON.stringify(v).slice(1, -1) : v;
  });
}
async function post(url, opts) { try { const r = await fetch(url, opts); if (!r.ok) console.error('HTTP', r.status, url.split('?')[0], (await r.text()).slice(0, 300)); } catch (e) { console.error('fetch fail', url.split('?')[0], e.message); } }

async function runIntegrations(event, order, c) {
  for (const i of (c.integrations || [])) {
    if (i.event !== event || !i.url) continue;
    let headers = { 'Content-Type': 'application/json' };
    try { if (i.headers) headers = { ...headers, ...JSON.parse(render(i.headers, { order }, true)) }; } catch (e) { console.error('headers JSON', i.name); }
    const opts = { method: i.method || 'POST', headers };
    if (opts.method !== 'GET') opts.body = render(i.body || JSON.stringify({ order }), { order }, true);
    await post(render(i.url, { order }, false), opts);
  }
}
async function telegram(order, c) {
  if (!c.telegramToken || !c.telegramChat) return;
  const text = `🛒 طلب جديد\n${order.fullName} - ${order.phone}\n${order.wilaya} / ${order.commune}\n${order.productName}\nالمجموع: ${order.finalTotal} دج`;
  await post(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.telegramChat, text }) });
}
async function conversions(order, c) {
  const px = await pixels(); const t = Math.floor(Date.now() / 1000);
  if (c.metaToken && px.meta) {
    await post(`https://graph.facebook.com/${GRAPH_VERSION}/${px.meta}/events?access_token=${encodeURIComponent(c.metaToken)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [{ event_name: 'Purchase', event_time: t, event_id: order.id, action_source: 'website', user_data: { ph: [sha(phone(order.phone))] }, custom_data: { value: order.finalTotal, currency: 'DZD' } }] }) });
  }
  if (c.tiktokToken && px.tiktok) { // الصيغة تحتاج مراجعة مع وثائق TikTok الحالية قبل الاعتماد عليها
    await post('https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': c.tiktokToken },
      body: JSON.stringify({ event_source: 'web', event_source_id: px.tiktok, data: [{ event: 'PlaceAnOrder', event_time: t, event_id: order.id, user: { phone: sha(phone(order.phone)) }, properties: { value: order.finalTotal, currency: 'DZD' } }] }) });
  }
}

exports.onOrderCreated = onDocumentCreated('orders/{id}', async (e) => {
  const order = { id: e.params.id, ...e.data.data() }; const c = await cfg();
  await telegram(order, c); await runIntegrations('order.created', order, c);
  if (!c.purchaseStatus) await conversions(order, c);
});
exports.onOrderUpdated = onDocumentUpdated('orders/{id}', async (e) => {
  const b = e.data.before.data(), a = e.data.after.data(); if (b.status === a.status) return;
  const order = { id: e.params.id, ...a }; const c = await cfg();
  await runIntegrations('order.updated', order, c);
  if (c.purchaseStatus && String(a.status || '').includes(c.purchaseStatus) && !a.conversionSent) {
    await conversions(order, c); await e.data.after.ref.update({ conversionSent: true });
  }
});

// واجهة API خارجية محمية بمفتاح: GET /api/products، GET /api/orders، POST /api/products، PATCH /api/orders/:id
exports.api = onRequest({ cors: true }, async (req, res) => {
  const c = await cfg(); const k = String(req.get('x-api-key') || '');
  const ok = c.apiKey && k.length === c.apiKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(c.apiKey));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  const path = req.path.replace(/^\/api/, '').replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && path === '/products') { const s = await db.collection('products').get(); return res.json(s.docs.map(d => ({ id: d.id, ...d.data() }))); }
    if (req.method === 'GET' && path === '/orders') { const s = await db.collection('orders').orderBy('createdAt', 'desc').limit(200).get(); return res.json(s.docs.map(d => ({ id: d.id, ...d.data() }))); }
    if (req.method === 'POST' && path === '/products') {
      const b = req.body || {}; if (!b.name || !b.price) return res.status(400).json({ error: 'name and price required' });
      const ref = await db.collection('products').add({ name: String(b.name), category: b.category || '', colors: b.colors || '', sizes: b.sizes || '', buyPrice: Number(b.buyPrice) || 0, price: Number(b.price), stock: Number(b.stock) || 10, description: b.description || '', imageUrls: b.imageUrls || [], videoUrls: b.videoUrls || [], createdAt: new Date() });
      return res.status(201).json({ id: ref.id });
    }
    const m = path.match(/^\/orders\/([\w-]+)$/);
    if (req.method === 'PATCH' && m) { await db.doc('orders/' + m[1]).update({ status: String((req.body || {}).status || '') }); return res.json({ ok: true }); }
    return res.status(404).json({ error: 'not found' });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'server error' }); }
});
