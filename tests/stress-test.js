const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

const BASE_URL = process.env.API_URL || 'http://localhost:8080';

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data };
}

async function aguardarApiPronta(tentativas = 30) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await req('GET', '/auditoria');
      if (r.status === 200) return;
    } catch {
      // aguarda a API subir
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(
    '\n[ERRO] A API não está respondendo em http://localhost:8080.\n' +
      'Verifique se o aplicativo "Docker Desktop" está aberto (com status "Engine running") e se o comando "docker compose up --build -d" rodou sem erros.\n'
  );
  process.exit(1);
}

async function runTests() {
  console.log('==========================================================');
  console.log(' Iniciando Bateria de Testes e Concorrência - API Carteira');
  console.log('==========================================================\n');

  await aguardarApiPronta();

  let totalTransferenciasEsperadas = 0;

  // 1. Auditoria inicial
  console.log('1. Testando GET /auditoria inicial...');
  const aud0 = await req('GET', '/auditoria');
  assert.equal(aud0.status, 200);
  assert.deepEqual(aud0.data, { usuarios: 0, somaSaldos: 0, transferencias: 0 });
  console.log('   OK ->', aud0.data);

  // 2. Cadastro e concorrência no cadastro
  console.log('\n2. Testando POST /auth/registrar (incluindo rajada simultânea)...');
  const cadastrosJoao = await Promise.all(
    Array.from({ length: 15 }, () =>
      req('POST', '/auth/registrar', {
        body: { username: 'joao', password: 'senha123' },
      })
    )
  );
  const criadosJoao = cadastrosJoao.filter((r) => r.status === 201);
  const duplicadosJoao = cadastrosJoao.filter(
    (r) => r.status === 409 && r.data?.error === 'USUARIO_EXISTENTE'
  );
  assert.equal(criadosJoao.length, 1, 'Exatamente 1 cadastro deve retornar 201');
  assert.equal(duplicadosJoao.length, 14, 'Os outros 14 devem retornar 409 USUARIO_EXISTENTE');

  // Cadastra mais usuários para os testes
  for (const nome of ['maria', 'pedro', 'ana', 'lucas']) {
    const r = await req('POST', '/auth/registrar', {
      body: { username: nome, password: 'senha123' },
    });
    assert.equal(r.status, 201);
  }
  console.log('   OK -> 5 usuários cadastrados (concorrência no registro validada).');

  // 3. Login e Rejeições de Autenticação
  console.log('\n3. Testando POST /auth/login e validações de token...');
  const loginInvalido = await req('POST', '/auth/login', {
    body: { username: 'joao', password: 'errada' },
  });
  assert.equal(loginInvalido.status, 401);
  assert.deepEqual(loginInvalido.data, { error: 'CREDENCIAIS_INVALIDAS' });

  const loginInexistente = await req('POST', '/auth/login', {
    body: { username: 'naoexiste', password: 'senha123' },
  });
  assert.equal(loginInexistente.status, 401);
  assert.deepEqual(loginInexistente.data, { error: 'CREDENCIAIS_INVALIDAS' });

  const loginJoao = await req('POST', '/auth/login', {
    body: { username: 'joao', password: 'senha123' },
  });
  assert.equal(loginJoao.status, 200);
  assert.ok(loginJoao.data.token.startsWith('eyJhbGc'), 'Token deve ser JWT iniciando com eyJhbGc');
  const tokenJoao = loginJoao.data.token;

  const tokenMaria = (
    await req('POST', '/auth/login', { body: { username: 'maria', password: 'senha123' } })
  ).data.token;
  const tokenPedro = (
    await req('POST', '/auth/login', { body: { username: 'pedro', password: 'senha123' } })
  ).data.token;
  console.log('   OK -> Login e geração de JWT validados.');

  // 4. GET /conta
  console.log('\n4. Testando GET /conta e proteção de rotas...');
  const contaSemToken = await req('GET', '/conta');
  assert.equal(contaSemToken.status, 401);
  assert.deepEqual(contaSemToken.data, { error: 'NAO_AUTENTICADO' });

  const contaTokenFalso = await req('GET', '/conta', { token: 'token.invalido.aqui' });
  assert.equal(contaTokenFalso.status, 401);
  assert.deepEqual(contaTokenFalso.data, { error: 'NAO_AUTENTICADO' });

  const contaJoao = await req('GET', '/conta', { token: tokenJoao });
  assert.equal(contaJoao.status, 200);
  assert.deepEqual(contaJoao.data, { username: 'joao', saldo: 1000 });
  console.log('   OK ->', contaJoao.data);

  // 5. Rejeições de POST /transferencias
  console.log('\n5. Testando todas as rejeições padronizadas de POST /transferencias...');
  const casosInvalidos = [
    { body: { destino: 'maria' }, status: 422, error: 'VALOR_INVALIDO', desc: 'valor ausente' },
    { body: { destino: 'maria', valor: '150' }, status: 422, error: 'VALOR_INVALIDO', desc: 'valor string "150"' },
    { body: { destino: 'maria', valor: 150.5 }, status: 422, error: 'VALOR_INVALIDO', desc: 'valor decimal 150.5' },
    { body: { destino: 'maria', valor: 0 }, status: 422, error: 'VALOR_INVALIDO', desc: 'valor zero' },
    { body: { destino: 'maria', valor: -10 }, status: 422, error: 'VALOR_INVALIDO', desc: 'valor negativo' },
    { body: { destino: 'maria', valor: null }, status: 422, error: 'VALOR_INVALIDO', desc: 'valor null' },
    { body: { destino: 'joao', valor: 100 }, status: 422, error: 'MESMA_CONTA', desc: 'destino igual à origem' },
    { body: { destino: 'fantasma', valor: 100 }, status: 404, error: 'DESTINO_INEXISTENTE', desc: 'destino não cadastrado' },
  ];

  for (const caso of casosInvalidos) {
    const res = await req('POST', '/transferencias', { token: tokenJoao, body: caso.body });
    assert.equal(res.status, caso.status, `Falha no status para ${caso.desc}`);
    assert.deepEqual(res.data, { error: caso.error }, `Falha no payload de erro para ${caso.desc}`);
  }

  // Testa "valor": 150.0 (notação float com .0 no JSON bruto) -> deve retornar 422 VALOR_INVALIDO
  const resFloatZero = await fetch(`${BASE_URL}/transferencias`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenJoao}`, 'Content-Type': 'application/json' },
    body: '{"destino": "maria", "valor": 150.0}',
  });
  assert.equal(resFloatZero.status, 422, '150.0 no JSON deve retornar 422');
  assert.deepEqual(await resFloatZero.json(), { error: 'VALOR_INVALIDO' });
  console.log('   OK -> Todas as validações 422 e 404 (incluindo 150.0 no JSON bruto) retornaram exatamente { "error": "<CODIGO>" }.');

  // 6. Concorrência: 30 requisições idênticas simultâneas (valor 600, saldo 1000)
  // Testa AO MESMO TEMPO:
  // a) Exatamente 1 transferência efetivada sob rajada simultânea
  // b) As outras 29 retornam TRANSFERENCIA_DUPLICADA mesmo o saldo tendo caído para 400 (< 600)!
  console.log('\n6. Testando rajada de 30 transferências idênticas simultâneas (joao -> maria, 600)...');
  const rajadaDuplicada = await Promise.all(
    Array.from({ length: 30 }, () =>
      req('POST', '/transferencias', {
        token: tokenJoao,
        body: { destino: 'maria', valor: 600 },
      })
    )
  );

  const efetivadas = rajadaDuplicada.filter((r) => r.status === 201);
  const duplicadas = rajadaDuplicada.filter(
    (r) => r.status === 409 && r.data?.error === 'TRANSFERENCIA_DUPLICADA'
  );

  assert.equal(efetivadas.length, 1, 'Exatamente 1 transferência deve ser efetivada');
  assert.equal(
    duplicadas.length,
    29,
    'Todas as 29 restantes devem retornar 409 TRANSFERENCIA_DUPLICADA (mesmo com saldo 400 < 600)'
  );
  assert.deepEqual(efetivadas[0].data, {
    id: 1,
    origem: 'joao',
    destino: 'maria',
    valor: 600,
    saldo: 400,
  });
  totalTransferenciasEsperadas += 1;
  console.log('   OK -> 1 efetivada (201) e 29 recusadas com TRANSFERENCIA_DUPLICADA (409).');

  // 7. Concorrência: Disputa de saldo insuficiente (joao tem 400, envia 3x de 250 para destinos diferentes)
  console.log('\n7. Testando disputa simultânea de saldo (joao tem 400, tenta 3 envios distintos de 250)...');
  const disputaSaldo = await Promise.all([
    req('POST', '/transferencias', { token: tokenJoao, body: { destino: 'maria', valor: 250 } }),
    req('POST', '/transferencias', { token: tokenJoao, body: { destino: 'pedro', valor: 250 } }),
    req('POST', '/transferencias', { token: tokenJoao, body: { destino: 'ana', valor: 250 } }),
    req('POST', '/transferencias', { token: tokenJoao, body: { destino: 'lucas', valor: 250 } }),
  ]);

  const SucessoDisputa = disputaSaldo.filter((r) => r.status === 201);
  const FalhaSaldo = disputaSaldo.filter(
    (r) => r.status === 409 && r.data?.error === 'SALDO_INSUFICIENTE'
  );

  assert.equal(SucessoDisputa.length, 1, 'Exatamente 1 envio de 250 deve passar');
  assert.equal(FalhaSaldo.length, 3, 'Os outros 3 devem falhar com 409 SALDO_INSUFICIENTE');
  assert.equal(SucessoDisputa[0].data.saldo, 150, 'Saldo final do joao deve ser 150');
  totalTransferenciasEsperadas += 1;
  console.log('   OK -> 1 efetivada (saldo: 150) e 3 recusadas com SALDO_INSUFICIENTE.');

  // 8. Concorrência Pesada e Prevenção de Deadlock (transferências cruzadas simultâneas maria <-> pedro)
  console.log('\n8. Testando prevenção de Deadlock (40 transferências cruzadas maria <-> pedro simultâneas)...');
  const cruzadas = [];
  for (let valor = 1; valor <= 20; valor++) {
    cruzadas.push(
      req('POST', '/transferencias', { token: tokenMaria, body: { destino: 'pedro', valor } })
    );
    cruzadas.push(
      req('POST', '/transferencias', { token: tokenPedro, body: { destino: 'maria', valor } })
    );
  }
  const resCruzadas = await Promise.all(cruzadas);
  const sucessoCruzadas = resCruzadas.filter((r) => r.status === 201);
  assert.equal(sucessoCruzadas.length, 40, 'Todas as 40 transferências cruzadas devem ter sucesso sem deadlock');
  totalTransferenciasEsperadas += 40;
  console.log('   OK -> 40 transferências cruzadas concluídas simultaneamente com ZERO deadlock e ZERO erro 500.');

  // 9. Teste de Resiliência a Queda/Reinício do Container da API
  console.log('\n9. Testando persistência e janela de 60s após reinício do container api...');
  execSync('docker compose restart api', { stdio: 'ignore' });

  // Aguarda a API voltar a responder após o restart
  for (let i = 0; i < 30; i++) {
    try {
      const ping = await req('GET', '/auditoria');
      if (ping.status === 200) break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Verifica se a janela de 60s de duplicidade sobreviveu à queda da API
  const dupPosQueda = await req('POST', '/transferencias', {
    token: tokenJoao,
    body: { destino: 'maria', valor: 600 },
  });
  assert.equal(dupPosQueda.status, 409);
  assert.deepEqual(dupPosQueda.data, { error: 'TRANSFERENCIA_DUPLICADA' });
  console.log('   OK -> Container api reiniciado; dados, tokens e janela de 60s preservados.');

  // 10. Auditoria Final (Invariante de Conservação de Moedas)
  console.log('\n10. Verificando invariante final em GET /auditoria...');
  const audFinal = await req('GET', '/auditoria');
  assert.equal(audFinal.status, 200);
  assert.deepEqual(audFinal.data, {
    usuarios: 5,
    somaSaldos: 5000,
    transferencias: totalTransferenciasEsperadas,
  });
  console.log('   OK ->', audFinal.data);

  console.log('\n==========================================================');
  console.log(' TODOS OS TESTES PASSARAM COM 100% DE SUCESSO!');
  console.log('==========================================================');
}

runTests().catch((err) => {
  console.error('\nERRO NOS TESTES:', err);
  process.exit(1);
});
