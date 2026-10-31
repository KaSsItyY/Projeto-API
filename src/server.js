const Fastify = require('fastify');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@db:5432/carteira';
const JWT_SECRET =
  process.env.JWT_SECRET || 'chave-jwt-carteira-digital-2026';

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 80),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Erro no pool do PostgreSQL:', err.message);
});

async function queryComRetry(text, params, tentativas = 3) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const transitorio =
        err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        err.code === '57P01' ||
        err.code === '57P03' ||
        err.code === '08006' ||
        err.code === '08003';
      if (!transitorio || i === tentativas) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}

function hashPassword(password) {
  return crypto.createHmac('sha256', JWT_SECRET).update(password).digest('hex');
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

const JWT_HEADER = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function gerarToken(username) {
  const payload = base64UrlEncode(
    JSON.stringify({ sub: username, iat: Math.floor(Date.now() / 1000) })
  );
  const assinatura = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${JWT_HEADER}.${payload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${JWT_HEADER}.${payload}.${assinatura}`;
}

function verificarToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  const partes = token.split('.');
  if (partes.length !== 3) {
    return null;
  }
  const [header, payload, assinatura] = partes;
  const assinaturaEsperada = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const bufRecebida = Buffer.from(assinatura);
  const bufEsperada = Buffer.from(assinaturaEsperada);
  if (
    bufRecebida.length !== bufEsperada.length ||
    !crypto.timingSafeEqual(bufRecebida, bufEsperada)
  ) {
    return null;
  }

  try {
    const dados = JSON.parse(base64UrlDecode(payload));
    if (!dados || typeof dados.sub !== 'string' || dados.sub.length === 0) {
      return null;
    }
    return dados.sub;
  } catch {
    return null;
  }
}

const app = Fastify({
  logger: false,
  trustProxy: true,
  bodyLimit: 65536,
});

const REGEX_VALOR_DECIMAL_NO_JSON = /"valor"\s*:\s*-?\d+(?:\.\d+|[eE][+-]?\d+)/;

function parseBody(_req, body, done) {
  if (!body || body.trim() === '') {
    return done(null, {});
  }
  try {
    const json = JSON.parse(body);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return done(null, { __jsonInvalido: true });
    }
    if (REGEX_VALOR_DECIMAL_NO_JSON.test(body)) {
      json.__valorDecimalNoJson = true;
    }
    return done(null, json);
  } catch {
    return done(null, { __jsonInvalido: true });
  }
}

app.removeContentTypeParser('application/json');
app.removeContentTypeParser('text/plain');
app.addContentTypeParser('application/json', { parseAs: 'string' }, parseBody);
app.addContentTypeParser('*', { parseAs: 'string' }, parseBody);

app.setErrorHandler((_error, request, reply) => {
  if (request.url.startsWith('/transferencias')) {
    return reply.code(422).send({ error: 'VALOR_INVALIDO' });
  }
  if (request.url.startsWith('/auth/')) {
    return reply.code(401).send({ error: 'CREDENCIAIS_INVALIDAS' });
  }
  return reply.code(400).send({ error: 'REQUISICAO_INVALIDA' });
});

app.setNotFoundHandler((_request, reply) => {
  return reply.code(404).send({ error: 'ROTA_INEXISTENTE' });
});

async function autenticar(request, reply) {
  const username = verificarToken(request.headers.authorization);
  if (!username) {
    return reply.code(401).send({ error: 'NAO_AUTENTICADO' });
  }
  request.username = username;
}

app.post('/auth/registrar', async (request, reply) => {
  const body = request.body || {};
  const { username, password } = body;

  if (
    body.__jsonInvalido ||
    typeof username !== 'string' ||
    username.trim().length === 0 ||
    username.length > 100 ||
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > 200
  ) {
    return reply.code(400).send({ error: 'CREDENCIAIS_INVALIDAS' });
  }

  const senhaHash = hashPassword(password);

  const res = await queryComRetry(
    `INSERT INTO usuarios (username, password_hash, saldo)
     VALUES ($1, $2, 1000)
     ON CONFLICT (username) DO NOTHING
     RETURNING username, saldo`,
    [username, senhaHash]
  );

  if (res.rowCount === 0) {
    return reply.code(409).send({ error: 'USUARIO_EXISTENTE' });
  }

  return reply.code(201).send({
    username: res.rows[0].username,
    saldo: Number(res.rows[0].saldo),
  });
});

app.post('/auth/login', async (request, reply) => {
  const body = request.body || {};
  const { username, password } = body;

  if (
    body.__jsonInvalido ||
    typeof username !== 'string' ||
    username.length === 0 ||
    typeof password !== 'string' ||
    password.length === 0
  ) {
    return reply.code(401).send({ error: 'CREDENCIAIS_INVALIDAS' });
  }

  const res = await queryComRetry(
    'SELECT username, password_hash FROM usuarios WHERE username = $1',
    [username]
  );

  if (res.rowCount === 0) {
    return reply.code(401).send({ error: 'CREDENCIAIS_INVALIDAS' });
  }

  const senhaHash = hashPassword(password);
  if (res.rows[0].password_hash !== senhaHash) {
    return reply.code(401).send({ error: 'CREDENCIAIS_INVALIDAS' });
  }

  const token = gerarToken(username);
  return reply.code(200).send({ token });
});

app.get('/conta', { onRequest: [autenticar] }, async (request, reply) => {
  const res = await queryComRetry(
    'SELECT username, saldo FROM usuarios WHERE username = $1',
    [request.username]
  );

  if (res.rowCount === 0) {
    return reply.code(401).send({ error: 'NAO_AUTENTICADO' });
  }

  return reply.code(200).send({
    username: res.rows[0].username,
    saldo: Number(res.rows[0].saldo),
  });
});

app.post('/transferencias', { onRequest: [autenticar] }, async (request, reply) => {
  const body = request.body || {};
  const { destino, valor } = body;
  const origem = request.username;

  if (
    body.__jsonInvalido ||
    body.__valorDecimalNoJson ||
    typeof valor !== 'number' ||
    !Number.isSafeInteger(valor) ||
    valor <= 0
  ) {
    return reply.code(422).send({ error: 'VALOR_INVALIDO' });
  }

  if (destino === origem) {
    return reply.code(422).send({ error: 'MESMA_CONTA' });
  }

  if (typeof destino !== 'string' || destino.length === 0) {
    return reply.code(404).send({ error: 'DESTINO_INEXISTENTE' });
  }

  const res = await queryComRetry(
    'SELECT status_code, erro, transferencia_id, novo_saldo FROM realizar_transferencia($1, $2, $3)',
    [origem, destino, valor]
  );

  const resultado = res.rows[0];

  if (resultado.status_code !== 201) {
    return reply.code(resultado.status_code).send({ error: resultado.erro });
  }

  return reply.code(201).send({
    id: Number(resultado.transferencia_id),
    origem,
    destino,
    valor,
    saldo: Number(resultado.novo_saldo),
  });
});

app.get('/auditoria', async (_request, reply) => {
  const res = await queryComRetry(`
    SELECT
      COUNT(*)::int AS usuarios,
      COALESCE(SUM(saldo), 0)::bigint AS "somaSaldos",
      (SELECT COUNT(*)::int FROM transferencias) AS transferencias
    FROM usuarios
  `);

  const row = res.rows[0];
  return reply.code(200).send({
    usuarios: Number(row.usuarios),
    somaSaldos: Number(row.somaSaldos),
    transferencias: Number(row.transferencias),
  });
});

let bancoProntoPromise = null;

app.addHook('onRequest', async () => {
  if (bancoProntoPromise) {
    await bancoProntoPromise;
  }
});

async function inicializarBanco() {
  const sqlPath = path.join(__dirname, '..', 'sql', 'init.sql');
  const initSql = fs.readFileSync(sqlPath, 'utf8');

  for (let tentativa = 1; tentativa <= 60; tentativa++) {
    try {
      await pool.query(initSql);
      console.log('Banco de dados pronto.');
      return;
    } catch (err) {
      console.log(`Aguardando banco (${tentativa}/60): ${err.message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Falha ao conectar no banco de dados.');
}

async function iniciar() {
  try {
    bancoProntoPromise = inicializarBanco().then(() => {
      bancoProntoPromise = null;
    });
    await app.listen({ port: PORT, host: '0.0.0.0' });
    await bancoProntoPromise;
    console.log(`API rodando na porta ${PORT}`);
  } catch (err) {
    console.error('Erro ao iniciar API:', err);
    process.exit(1);
  }
}

async function encerrar() {
  try {
    await app.close();
    await pool.end();
  } catch (err) {
    console.error('Erro ao encerrar:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

iniciar();
