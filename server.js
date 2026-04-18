require('dotenv').config({ override: true });
const { serve } = require('@hono/node-server');
const { Hono } = require('hono');
const { serveStatic } = require('@hono/node-server/serve-static');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const MOCK_MODE = !process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_api_key_here';
const JWT_SECRET = process.env.JWT_SECRET || 'reviewmate-dev-secret';

const PLANS = {
  free:  { limit: 5,   name: 'Free' },
  solo:  { limit: 50,  name: 'Solo',  price: 1500 },
  team:  { limit: 500, name: 'Team',  price: 8000 },
};

let anthropic;
if (!MOCK_MODE) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const app = new Hono();

async function getUser(c) {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return db.findUserById(payload.userId);
  } catch { return null; }
}

// ── 静的ファイル ──
app.get('/', serveStatic({ path: './public/landing.html' }));
app.get('/app', serveStatic({ path: './public/index.html' }));
app.get('/login', serveStatic({ path: './public/login.html' }));
app.get('/upgrade', serveStatic({ path: './public/upgrade.html' }));

// ── 認証API ──
app.post('/api/auth/signup', async (c) => {
  const { email, password } = await c.req.json();
  if (!email || !password) return c.json({ error: 'メールアドレスとパスワードを入力してください' }, 400);
  if (password.length < 8) return c.json({ error: 'パスワードは8文字以上にしてください' }, 400);
  if (db.findUserByEmail(email)) return c.json({ error: 'このメールアドレスは既に登録されています' }, 409);
  const hashed = await bcrypt.hash(password, 10);
  const user = db.createUser({ id: uuidv4(), email, password: hashed, plan: 'free', createdAt: new Date().toISOString() });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  return c.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
});

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json();
  const user = db.findUserByEmail(email);
  if (!user) return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401);
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  return c.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
});

app.get('/api/auth/me', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const usage = db.getMonthlyUsage(user.id);
  const plan = PLANS[user.plan] || PLANS.free;
  return c.json({ user: { id: user.id, email: user.email, plan: user.plan }, usage, limit: plan.limit });
});

// ── レビューAPI ──
app.post('/api/review', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'ログインが必要です', code: 'UNAUTHORIZED' }, 401);

  const plan = PLANS[user.plan] || PLANS.free;
  const usage = db.getMonthlyUsage(user.id);
  if (usage >= plan.limit) {
    return c.json({ error: `今月の利用上限（${plan.limit}回）に達しました`, code: 'LIMIT_EXCEEDED', usage, limit: plan.limit }, 429);
  }

  const { code, reviewType, language } = await c.req.json();
  if (!code || !code.trim()) return c.json({ error: 'コードを入力してください' }, 400);

  const reviewPrompts = {
    all:          'バグ・セキュリティ・パフォーマンス・可読性の4観点で総合レビューしてください。',
    bug:          'バグや論理エラーを探して指摘してください。修正案も提示してください。',
    security:     'セキュリティの脆弱性（インジェクション、認証不備、データ漏洩等）を指摘してください。',
    performance:  'パフォーマンス上の問題点と改善案を指摘してください。',
    readability:  'コードの可読性・保守性を改善するためのアドバイスをしてください。',
  };

  const prompt = `あなたは経験豊富なシニアエンジニアです。以下の${language || 'コード'}をレビューしてください。

【レビュー観点】
${reviewPrompts[reviewType] || reviewPrompts.all}

【コード】
\`\`\`${language || ''}
${code}
\`\`\`

【出力形式】
Markdown形式で、以下の構成で回答してください：
- ## 総合評価（S/A/B/C/Dで評価 + 一言コメント）
- ## 指摘事項（番号付きリスト。各項目に【重要度: 高/中/低】を付ける）
- ## 改善後のコード（修正点がある場合のみ）
- ## まとめ

日本語で回答してください。`;

  if (MOCK_MODE) {
    db.incrementUsage(user.id);
    return c.json({
      result: `## 総合評価\n**B** — 概ね問題ありませんが、いくつか改善点があります。\n\n## 指摘事項\n1. 【重要度: 中】エラーハンドリングが不足しています。try-catchを追加することを推奨します。\n2. 【重要度: 低】変数名をより説明的にすることで可読性が向上します。\n\n## まとめ\n全体的に読みやすいコードです。エラーハンドリングを追加すれば品質が上がります。\n\n※ モックモード（API Key未設定）`,
      usage: usage + 1,
      limit: plan.limit,
    });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    db.incrementUsage(user.id);
    return c.json({ result: message.content[0].text, usage: usage + 1, limit: plan.limit });
  } catch (err) {
    console.error('Claude API error:', err.message);
    return c.json({ error: 'レビュー生成に失敗しました: ' + err.message }, 500);
  }
});

// ── チェックアウト ──
app.post('/api/checkout', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'ログインが必要です' }, 401);
  const { planId } = await c.req.json();
  if (!planId || planId === 'free') return c.json({ error: '無効なプランです' }, 400);
  const linkMap = {
    solo: process.env.STRIPE_LINK_SOLO || 'https://buy.stripe.com/test_eVqdR91eX5nUgUN6fY9bO00',
    team: process.env.STRIPE_LINK_TEAM || 'https://buy.stripe.com/test_bJecN58Hp7w28ohawe9bO01',
  };
  const url = linkMap[planId];
  if (!url) return c.json({ error: '無効なプランです' }, 400);
  return c.json({ url });
});

const PORT = parseInt(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`ReviewMate running on http://localhost:${PORT}`);
  if (MOCK_MODE) console.log('⚠️  MOCK MODE (no API key)');
});
