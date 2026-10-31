# Projeto: Transferências

API de carteira digital desenvolvida com Node.js (Fastify) e PostgreSQL 16.

## Como rodar

```bash
docker compose down -v
docker compose up --build -d
```

A API fica disponível em `http://localhost:8080`.

## Estratégia de Concorrência

O controle de concorrência e consistência é feito diretamente no PostgreSQL através da função `realizar_transferencia` (`sql/init.sql`), mantendo a API stateless:

1. **Prevenção de Race Condition e Saldo Negativo:** Utiliza `SELECT ... FOR UPDATE` para travar as linhas das contas envolvidas durante a transação, além da constraint `CHECK (saldo >= 0)` na tabela `usuarios`.
2. **Prevenção de Deadlock:** Os locks das duas contas (`origem` e `destino`) são sempre adquiridos em ordem alfabética usando `LEAST(p_origem, p_destino)` e `GREATEST(p_origem, p_destino)`, evitando espera circular em transferências cruzadas simultâneas.
3. **Duplicidade (60 segundos):** A verificação na tabela `transferencias` com `clock_timestamp() - INTERVAL '60 seconds'` ocorre após adquirir o lock das contas e antes de validar o saldo, garantindo que requisições repetidas retornem `409 TRANSFERENCIA_DUPLICADA` mesmo quando o saldo atual for insuficiente.
4. **Atomicidade em Quedas:** Débito, crédito e registro da transferência rodam na mesma transação no banco. Se a API cair durante a execução, o PostgreSQL realiza `ROLLBACK` automático caso a transação não tenha sido concluída.

## Endpoints

| Rota | Método | Auth | Sucesso | Erros |
| :--- | :--- | :--- | :--- | :--- |
| `/auth/registrar` | `POST` | Pública | `201 Created` | `409 USUARIO_EXISTENTE` |
| `/auth/login` | `POST` | Pública | `200 OK` | `401 CREDENCIAIS_INVALIDAS` |
| `/conta` | `GET` | Bearer | `200 OK` | `401 NAO_AUTENTICADO` |
| `/transferencias` | `POST` | Bearer | `201 Created` | `401 NAO_AUTENTICADO`, `422 VALOR_INVALIDO`, `422 MESMA_CONTA`, `404 DESTINO_INEXISTENTE`, `409 TRANSFERENCIA_DUPLICADA`, `409 SALDO_INSUFICIENTE` |
| `/auditoria` | `GET` | Pública | `200 OK` | - |

## Testes

```bash
node tests/stress-test.js
```
