/* ==================================================================================
   FOCUS FERT — Back4App Cloud Code
   Разверни этот файл как cloud/main.js в своём Back4App-приложении (Cloud Code).
   Здесь выполняется всё, что нельзя доверять браузеру: секретный ключ CryptoBot,
   продление подписки, подсчёт лидеров, дружба между пользователями.
   ================================================================================== */

/* ------------------------------------------------------------------------------
   НАСТРОЙКА: задай переменную окружения CRYPTOBOT_API_KEY в разделе
   Back4App → App Settings → Server Settings → Environment Variables.
   Никогда не хардкодь ключ прямо в этом файле в публичном репозитории.
   ------------------------------------------------------------------------------ */
const CRYPTOBOT_API_KEY = process.env.CRYPTOBOT_API_KEY || 'ВСТАВЬ_КЛЮЧ_В_ENV_ПЕРЕМЕННУЮ';
const CRYPTOBOT_API_BASE = 'https://pay.crypt.bot/api'; // официальный эндпоинт Crypto Pay API
const ASSET = 'USDT';

// Тарифы — должны совпадать с CryptoPay.PLANS на фронтенде
const PLANS = {
  '1m':  { months:1,  amount:1   },
  '3m':  { months:3,  amount:2.5 },
  '6m':  { months:6,  amount:5   },
  '12m': { months:12, amount:10  }
};

/* ------------------------------------------------------------------------------
   createCryptoInvoice — создаёт счёт в CryptoBot и сохраняет его в классе Invoice
   ------------------------------------------------------------------------------ */
Parse.Cloud.define('createCryptoInvoice', async (request) => {
  const user = request.user;
  if (!user) throw new Parse.Error(141, 'Нужно авторизоваться');

  const planKey = request.params.planKey;
  const plan = PLANS[planKey];
  if (!plan) throw new Parse.Error(141, 'Неизвестный тариф');

  const body = {
    asset: ASSET,
    amount: String(plan.amount),
    description: `Focus Fert Premium — ${plan.months} мес.`,
    payload: JSON.stringify({ userId: user.id, planKey }),
    paid_btn_name: 'openBot',
    paid_btn_url: 'https://t.me/CryptoBot'
  };

  const res = await Parse.Cloud.httpRequest({
    method: 'POST',
    url: `${CRYPTOBOT_API_BASE}/createInvoice`,
    headers: {
      'Content-Type': 'application/json',
      'Crypto-Pay-API-Token': CRYPTOBOT_API_KEY
    },
    body: JSON.stringify(body)
  }).catch(err => { throw new Parse.Error(141, 'Ошибка обращения к CryptoBot: ' + err.message); });

  const data = res.data;
  if (!data || !data.ok) {
    throw new Parse.Error(141, 'CryptoBot API: ' + (data && data.error && data.error.name || 'неизвестная ошибка'));
  }

  const Invoice = Parse.Object.extend('Invoice');
  const invoice = new Invoice();
  invoice.set('user', user);
  invoice.set('invoiceId', String(data.result.invoice_id));
  invoice.set('planKey', planKey);
  invoice.set('months', plan.months);
  invoice.set('amount', plan.amount);
  invoice.set('asset', ASSET);
  invoice.set('status', 'pending');
  const acl = new Parse.ACL(user);
  invoice.setACL(acl);
  await invoice.save(null, { useMasterKey: true });

  return {
    invoiceId: String(data.result.invoice_id),
    payUrl: data.result.pay_url || data.result.bot_invoice_url
  };
});

/* ------------------------------------------------------------------------------
   checkCryptoInvoice — проверяет статус счёта и, если оплачен, продлевает подписку
   ------------------------------------------------------------------------------ */
Parse.Cloud.define('checkCryptoInvoice', async (request) => {
  const user = request.user;
  if (!user) throw new Parse.Error(141, 'Нужно авторизоваться');
  const invoiceId = request.params.invoiceId;
  if (!invoiceId) throw new Parse.Error(141, 'Не передан invoiceId');

  const Invoice = Parse.Object.extend('Invoice');
  const q = new Parse.Query(Invoice);
  q.equalTo('invoiceId', String(invoiceId));
  q.equalTo('user', user);
  const invoiceObj = await q.first({ useMasterKey: true });
  if (!invoiceObj) throw new Parse.Error(141, 'Счёт не найден');

  if (invoiceObj.get('status') === 'paid') {
    return { status: 'paid' };
  }

  const res = await Parse.Cloud.httpRequest({
    method: 'GET',
    url: `${CRYPTOBOT_API_BASE}/getInvoices?invoice_ids=${encodeURIComponent(invoiceId)}`,
    headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_API_KEY }
  }).catch(err => { throw new Parse.Error(141, 'Ошибка обращения к CryptoBot: ' + err.message); });

  const data = res.data;
  const item = data && data.ok && data.result && data.result.items && data.result.items[0];
  if (!item) return { status: 'unknown' };

  if (item.status === 'paid') {
    await activateSubscription(user, invoiceObj.get('months'));
    invoiceObj.set('status', 'paid');
    await invoiceObj.save(null, { useMasterKey: true });
    return { status: 'paid' };
  }

  return { status: item.status };
});

/* Продлевает/активирует подписку: от текущей даты окончания (если ещё активна) или от сейчас */
async function activateSubscription(user, months) {
  const now = Date.now();
  const currentExp = user.get('subscriptionExpires');
  const base = (currentExp && new Date(currentExp).getTime() > now) ? new Date(currentExp).getTime() : now;
  const next = new Date(base + months * 30 * 24 * 60 * 60 * 1000);
  user.set('subscriptionExpires', next);
  await user.save(null, { useMasterKey: true });
}

/* ------------------------------------------------------------------------------
   (опционально, но рекомендуется) webhook от CryptoBot для мгновенного подтверждения
   вместо polling. Настраивается в @CryptoBot → Crypto Pay → Webhooks.
   Требует Cloud Code Express: https://docs.back4app.com/docs/parse-server/cloud-code/express/
   ------------------------------------------------------------------------------ */
// const express = require('express');
// const app = express();
// app.use(express.json());
// app.post('/cryptobot-webhook', async (req, res) => {
//   const update = req.body;
//   if (update.update_type === 'invoice_paid') {
//     const payload = JSON.parse(update.payload.payload || '{}');
//     const Invoice = Parse.Object.extend('Invoice');
//     const q = new Parse.Query(Invoice);
//     q.equalTo('invoiceId', String(update.payload.invoice_id));
//     const invoiceObj = await q.first({ useMasterKey: true });
//     if (invoiceObj && invoiceObj.get('status') !== 'paid') {
//       const userQuery = new Parse.Query(Parse.User);
//       const user = await userQuery.get(payload.userId, { useMasterKey: true });
//       await activateSubscription(user, invoiceObj.get('months'));
//       invoiceObj.set('status', 'paid');
//       await invoiceObj.save(null, { useMasterKey: true });
//     }
//   }
//   res.json({ ok: true });
// });
// Parse.Cloud.app.use('/webhooks', app);

/* ------------------------------------------------------------------------------
   logSession — засчитывает завершённую фокус-сессию (сервер — источник истины)
   ------------------------------------------------------------------------------ */
Parse.Cloud.define('logSession', async (request) => {
  const user = request.user;
  if (!user) throw new Parse.Error(141, 'Нужно авторизоваться');
  const minutes = Math.max(1, Math.min(180, Number(request.params.minutes) || 0));
  const streak = Math.max(0, Number(request.params.streak) || 0);

  user.increment('totalSessions', 1);
  user.increment('totalMinutes', minutes);
  user.set('currentStreak', streak);
  await user.save(null, { useMasterKey: true });
  return { ok: true };
});

/* ------------------------------------------------------------------------------
   unlockAchievement — добавляет id значка в achievementsList (без дублей)
   ------------------------------------------------------------------------------ */
Parse.Cloud.define('unlockAchievement', async (request) => {
  const user = request.user;
  if (!user) throw new Parse.Error(141, 'Нужно авторизоваться');
  const id = request.params.id;
  if (!id) throw new Parse.Error(141, 'Не передан id достижения');
  const list = user.get('achievementsList') || [];
  if (!list.includes(id)) {
    user.addUnique('achievementsList', id);
    await user.save(null, { useMasterKey: true });
  }
  return { ok: true };
});

/* ------------------------------------------------------------------------------
   getLeaderboard — топ пользователей по сессиям или минутам
   ------------------------------------------------------------------------------ */
Parse.Cloud.define('getLeaderboard', async (request) => {
  if (!request.user) throw new Parse.Error(141, 'Нужно авторизоваться');
  const metric = request.params.metric === 'minutes' ? 'totalMinutes' : 'totalSessions';
  const limit = Math.min(100, Number(request.params.limit) || 50);

  const q = new Parse.Query(Parse.User);
  q.greaterThan(metric, 0);
  q.descending(metric);
  q.limit(limit);
  q.select('username', 'avatar', 'totalSessions', 'totalMinutes');
  const users = await q.find({ useMasterKey: true });

  return users.map(u => ({
    id: u.id,
    username: u.get('username'),
    avatarUrl: u.get('avatar') ? u.get('avatar').url() : null,
    totalSessions: u.get('totalSessions') || 0,
    totalMinutes: u.get('totalMinutes') || 0
  }));
});

/* ------------------------------------------------------------------------------
   searchUsers — поиск пользователей по подстроке никнейма (без учёта регистра)
   ------------------------------------------------------------------------------ */
Parse.Cloud.define('searchUsers', async (request) => {
  const me = request.user;
  if (!me) throw new Parse.Error(141, 'Нужно авторизоваться');
  const query = String(request.params.query || '').trim();
  if (query.length < 2) return [];

  const q = new Parse.Query(Parse.User);
  q.matches('username', query, 'i');
  q.notEqualTo('objectId', me.id);
  q.limit(20);
  q.select('username', 'avatar', 'totalSessions');
  const users = await q.find({ useMasterKey: true });

  const [friendIds, pendingIds] = await Promise.all([getFriendIds(me), getOutgoingPendingIds(me)]);

  return users.map(u => ({
    id: u.id,
    username: u.get('username'),
    avatarUrl: u.get('avatar') ? u.get('avatar').url() : null,
    totalSessions: u.get('totalSessions') || 0,
    friendStatus: friendIds.has(u.id) ? 'friends' : (pendingIds.has(u.id) ? 'pending' : 'none')
  }));
});

/* ------------------------------------------------------------------------------
   sendFriendRequest / respondFriendRequest / getFriendsData
   Класс FriendRequest: fromUser (Pointer<_User>), toUser (Pointer<_User>),
   status ('pending' | 'accepted' | 'declined')
   ------------------------------------------------------------------------------ */
Parse.Cloud.define('sendFriendRequest', async (request) => {
  const me = request.user;
  if (!me) throw new Parse.Error(141, 'Нужно авторизоваться');
  const toUserId = request.params.toUserId;
  if (!toUserId || toUserId === me.id) throw new Parse.Error(141, 'Некорректный получатель');

  const friendIds = await getFriendIds(me);
  if (friendIds.has(toUserId)) throw new Parse.Error(141, 'Вы уже друзья');

  const FriendRequest = Parse.Object.extend('FriendRequest');
  const existing = new Parse.Query(FriendRequest);
  existing.equalTo('fromUser', me);
  existing.equalTo('toUser', Parse.User.createWithoutData(toUserId));
  existing.equalTo('status', 'pending');
  if (await existing.first({ useMasterKey: true })) throw new Parse.Error(141, 'Заявка уже отправлена');

  const toUser = Parse.User.createWithoutData(toUserId);
  const fr = new FriendRequest();
  fr.set('fromUser', me);
  fr.set('toUser', toUser);
  fr.set('status', 'pending');
  const acl = new Parse.ACL();
  acl.setReadAccess(me.id, true);
  acl.setReadAccess(toUserId, true);
  acl.setWriteAccess(me.id, true);
  acl.setWriteAccess(toUserId, true);
  fr.setACL(acl);
  await fr.save(null, { useMasterKey: true });
  return { ok: true };
});

Parse.Cloud.define('respondFriendRequest', async (request) => {
  const me = request.user;
  if (!me) throw new Parse.Error(141, 'Нужно авторизоваться');
  const { requestId, accept } = request.params;

  const FriendRequest = Parse.Object.extend('FriendRequest');
  const q = new Parse.Query(FriendRequest);
  q.include('fromUser');
  const fr = await q.get(requestId, { useMasterKey: true });
  if (fr.get('toUser').id !== me.id) throw new Parse.Error(141, 'Эта заявка не для тебя');

  fr.set('status', accept ? 'accepted' : 'declined');
  await fr.save(null, { useMasterKey: true });
  return { ok: true };
});

Parse.Cloud.define('getFriendsData', async (request) => {
  const me = request.user;
  if (!me) throw new Parse.Error(141, 'Нужно авторизоваться');

  const FriendRequest = Parse.Object.extend('FriendRequest');

  const acceptedQ1 = new Parse.Query(FriendRequest);
  acceptedQ1.equalTo('fromUser', me);
  acceptedQ1.equalTo('status', 'accepted');
  acceptedQ1.include('toUser');
  const acceptedQ2 = new Parse.Query(FriendRequest);
  acceptedQ2.equalTo('toUser', me);
  acceptedQ2.equalTo('status', 'accepted');
  acceptedQ2.include('fromUser');
  const [asFrom, asTo] = await Promise.all([
    acceptedQ1.find({ useMasterKey: true }),
    acceptedQ2.find({ useMasterKey: true })
  ]);
  const friends = [
    ...asFrom.map(r => r.get('toUser')),
    ...asTo.map(r => r.get('fromUser'))
  ].map(u => ({
    id: u.id,
    username: u.get('username'),
    avatarUrl: u.get('avatar') ? u.get('avatar').url() : null,
    totalSessions: u.get('totalSessions') || 0
  }));

  const pendingQ = new Parse.Query(FriendRequest);
  pendingQ.equalTo('toUser', me);
  pendingQ.equalTo('status', 'pending');
  pendingQ.include('fromUser');
  const pending = await pendingQ.find({ useMasterKey: true });
  const requests = pending.map(r => ({
    requestId: r.id,
    fromUser: {
      id: r.get('fromUser').id,
      username: r.get('fromUser').get('username'),
      avatarUrl: r.get('fromUser').get('avatar') ? r.get('fromUser').get('avatar').url() : null,
      totalSessions: r.get('fromUser').get('totalSessions') || 0
    }
  }));

  return { friends, requests };
});

Parse.Cloud.define('getUserProfile', async (request) => {
  if (!request.user) throw new Parse.Error(141, 'Нужно авторизоваться');
  const userId = request.params.userId;
  const q = new Parse.Query(Parse.User);
  const u = await q.get(userId, { useMasterKey: true });
  return {
    username: u.get('username'),
    avatarUrl: u.get('avatar') ? u.get('avatar').url() : null,
    totalSessions: u.get('totalSessions') || 0,
    totalMinutes: u.get('totalMinutes') || 0,
    currentStreak: u.get('currentStreak') || 0,
    achievementsList: u.get('achievementsList') || []
  };
});

/* ------------------------------------------------------------------------------
   Вспомогательные функции
   ------------------------------------------------------------------------------ */
async function getFriendIds(me) {
  const FriendRequest = Parse.Object.extend('FriendRequest');
  const q1 = new Parse.Query(FriendRequest);
  q1.equalTo('fromUser', me); q1.equalTo('status', 'accepted');
  const q2 = new Parse.Query(FriendRequest);
  q2.equalTo('toUser', me); q2.equalTo('status', 'accepted');
  const [r1, r2] = await Promise.all([q1.find({ useMasterKey: true }), q2.find({ useMasterKey: true })]);
  const ids = new Set();
  r1.forEach(r => ids.add(r.get('toUser').id));
  r2.forEach(r => ids.add(r.get('fromUser').id));
  return ids;
}

async function getOutgoingPendingIds(me) {
  const FriendRequest = Parse.Object.extend('FriendRequest');
  const q = new Parse.Query(FriendRequest);
  q.equalTo('fromUser', me); q.equalTo('status', 'pending');
  const rows = await q.find({ useMasterKey: true });
  return new Set(rows.map(r => r.get('toUser').id));
}
