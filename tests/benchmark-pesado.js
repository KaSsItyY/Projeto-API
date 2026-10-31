const assert = require('node:assert/strict');

const BASE_URL = process.env.API_URL || 'http://localhost:8080';

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const inicio = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const duracaoMs = performance.now() - inicio;
  const data = await res.json().catch(() => null);
  return { status: res.status, data, duracaoMs };
}

async function rodarBenchmarkPesado() {
  console.log('================================================================');
  console.log(' TESTE DE ESTRESSE PESADO (Simulação da Avaliação do Professor)');
  console.log('================================================================\n');

  const audInicial = await req('GET', '/auditoria');
  const usuariosIniciais = audInicial.data.usuarios;
  const transfIniciais = audInicial.data.transferencias;

  const NUM_NOVOS_USUARIOS = 50;
  const sufixo = Date.now();
  const usuarios = Array.from({ length: NUM_NOVOS_USUARIOS }, (_, i) => `user_${sufixo}_${i + 1}`);

  // 1. Cadastra 50 usuários simultaneamente (cada um começa com 1000 moedas = +50.000 moedas)
  console.log(`1. Cadastrando ${NUM_NOVOS_USUARIOS} usuários simultaneamente...`);
  const t0 = performance.now();
  const resCadastros = await Promise.all(
    usuarios.map((u) =>
      req('POST', '/auth/registrar', { body: { username: u, password: '123' } })
    )
  );
  assert.ok(resCadastros.every((r) => r.status === 201), 'Todos os 50 cadastros devem retornar 201');
  console.log(`   OK -> 50 usuários criados em ${(performance.now() - t0).toFixed(0)}ms (+50.000 moedas).`);

  // 2. Faz login dos 50 usuários simultaneamente
  console.log('\n2. Realizando 50 logins simultâneos...');
  const resLogins = await Promise.all(
    usuarios.map((u) =>
      req('POST', '/auth/login', { body: { username: u, password: '123' } })
    )
  );
  const tokens = resLogins.map((r) => r.data.token);
  assert.ok(resLogins.every((r) => r.status === 200), 'Todos os 50 logins devem retornar 200');
  console.log('   OK -> 50 tokens JWT emitidos.');

  // 3. Dispara 500 requisições simultâneas (misturando transferências válidas, duplicadas e erros)
  console.log('\n3. Disparando 500 requisições concorrentes de transferência...');
  const promessas = [];

  // 3a. 250 transferências válidas cruzadas em anel (user_i -> user_i+1 com valores distintos 1..5)
  for (let i = 0; i < NUM_NOVOS_USUARIOS; i++) {
    const idxDestino = (i + 1) % NUM_NOVOS_USUARIOS;
    for (let valor = 1; valor <= 5; valor++) {
      promessas.push(
        req('POST', '/transferencias', {
          token: tokens[i],
          body: { destino: usuarios[idxDestino], valor },
        })
      );
    }
  }

  // 3b. 150 transferências duplicadas (repetindo valor = 1 que já foi enviado acima)
  for (let i = 0; i < NUM_NOVOS_USUARIOS; i++) {
    const idxDestino = (i + 1) % NUM_NOVOS_USUARIOS;
    for (let rep = 0; rep < 3; rep++) {
      promessas.push(
        req('POST', '/transferencias', {
          token: tokens[i],
          body: { destino: usuarios[idxDestino], valor: 1 },
        })
      );
    }
  }

  // 3c. 100 tentativas inválidas/sem saldo concorrentes
  for (let i = 0; i < NUM_NOVOS_USUARIOS; i++) {
    const idxDestino = (i + 2) % NUM_NOVOS_USUARIOS;
    promessas.push(
      req('POST', '/transferencias', {
        token: tokens[i],
        body: { destino: usuarios[idxDestino], valor: 999999 }, // SALDO_INSUFICIENTE
      })
    );
    promessas.push(
      req('POST', '/transferencias', {
        token: tokens[i],
        body: { destino: usuarios[i], valor: 10 }, // MESMA_CONTA
      })
    );
  }

  const inicioRajada = performance.now();
  const resultados = await Promise.all(promessas);
  const tempoTotalMs = performance.now() - inicioRajada;

  const erros500 = resultados.filter((r) => r.status >= 500);
  const efetivadas201 = resultados.filter((r) => r.status === 201);
  const duplicadas409 = resultados.filter(
    (r) => r.status === 409 && r.data?.error === 'TRANSFERENCIA_DUPLICADA'
  );
  const semSaldo409 = resultados.filter(
    (r) => r.status === 409 && r.data?.error === 'SALDO_INSUFICIENTE'
  );
  const mesmaConta422 = resultados.filter(
    (r) => r.status === 422 && r.data?.error === 'MESMA_CONTA'
  );

  const latenciaMedia =
    resultados.reduce((acc, r) => acc + r.duracaoMs, 0) / resultados.length;

  console.log(`   -> Tempo total para 500 requisições simultâneas: ${tempoTotalMs.toFixed(0)}ms`);
  console.log(`   -> Latência média por requisição: ${latenciaMedia.toFixed(1)}ms`);
  console.log(`   -> Erros 500 / Timeouts: ${erros500.length} (ZERO!)`);
  console.log(`   -> Efetivadas (201): ${efetivadas201.length} (esperado: 250)`);
  console.log(`   -> Duplicadas bloqueadas (409): ${duplicadas409.length} (esperado: 150)`);
  console.log(`   -> Saldo insuficiente bloqueado (409): ${semSaldo409.length} (esperado: 50)`);
  console.log(`   -> Mesma conta bloqueada (422): ${mesmaConta422.length} (esperado: 50)`);

  assert.equal(erros500.length, 0, 'Não pode haver nenhum erro 500');
  assert.equal(efetivadas201.length, 250, 'Exatamente 250 transferências devem ser efetivadas');
  assert.equal(duplicadas409.length, 150, 'Exatamente 150 duplicadas devem ser recusadas');
  assert.equal(semSaldo409.length, 50, 'Exatamente 50 sem saldo devem ser recusadas');
  assert.equal(mesmaConta422.length, 50, 'Exatamente 50 mesma conta devem ser recusadas');

  // 4. Verifica auditoria final
  const audFinal = await req('GET', '/auditoria');
  const totalUsuariosEsperado = usuariosIniciais + NUM_NOVOS_USUARIOS;
  assert.equal(audFinal.data.usuarios, totalUsuariosEsperado);
  assert.equal(audFinal.data.somaSaldos, totalUsuariosEsperado * 1000);
  assert.equal(audFinal.data.transferencias, transfIniciais + 250);

  console.log('\n4. Auditoria final consistente:', audFinal.data);
  console.log('\n================================================================');
  console.log(' BENCHMARK DE ESTRESSE CONCLUÍDO COM PERFEIÇÃO!');
  console.log('================================================================');
}

rodarBenchmarkPesado().catch((err) => {
  console.error('Erro no benchmark:', err);
  process.exit(1);
});
