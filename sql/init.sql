CREATE TABLE IF NOT EXISTS usuarios (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  saldo BIGINT NOT NULL DEFAULT 1000 CHECK (saldo >= 0)
);

CREATE TABLE IF NOT EXISTS transferencias (
  id SERIAL PRIMARY KEY,
  origem TEXT NOT NULL REFERENCES usuarios(username),
  destino TEXT NOT NULL REFERENCES usuarios(username),
  valor BIGINT NOT NULL CHECK (valor > 0),
  criada_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (origem <> destino)
);

CREATE INDEX IF NOT EXISTS idx_transferencias_duplicidade
  ON transferencias (origem, destino, valor, criada_em DESC);

CREATE OR REPLACE FUNCTION realizar_transferencia(
  p_origem TEXT,
  p_destino TEXT,
  p_valor BIGINT
) RETURNS TABLE (
  status_code INT,
  erro TEXT,
  transferencia_id INT,
  novo_saldo BIGINT
) LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_primeiro TEXT;
  v_segundo TEXT;
  v_achou_primeiro BOOLEAN;
  v_achou_segundo BOOLEAN;
  v_achou_origem BOOLEAN;
  v_achou_destino BOOLEAN;
  v_saldo_origem BIGINT;
  v_id INT;
BEGIN
  -- Trava as duas contas em ordem alfabetica para evitar deadlock
  v_primeiro := LEAST(p_origem, p_destino);
  v_segundo  := GREATEST(p_origem, p_destino);

  PERFORM 1 FROM usuarios WHERE username = v_primeiro FOR UPDATE;
  v_achou_primeiro := FOUND;

  PERFORM 1 FROM usuarios WHERE username = v_segundo FOR UPDATE;
  v_achou_segundo := FOUND;

  IF p_origem = v_primeiro THEN
    v_achou_origem  := v_achou_primeiro;
    v_achou_destino := v_achou_segundo;
  ELSE
    v_achou_origem  := v_achou_segundo;
    v_achou_destino := v_achou_primeiro;
  END IF;

  IF NOT v_achou_origem THEN
    RETURN QUERY SELECT 401, 'NAO_AUTENTICADO'::TEXT, NULL::INT, NULL::BIGINT;
    RETURN;
  END IF;

  IF NOT v_achou_destino THEN
    RETURN QUERY SELECT 404, 'DESTINO_INEXISTENTE'::TEXT, NULL::INT, NULL::BIGINT;
    RETURN;
  END IF;

  -- Verifica duplicidade nos ultimos 60s antes de checar o saldo
  IF EXISTS (
    SELECT 1
    FROM transferencias t
    WHERE t.origem = p_origem
      AND t.destino = p_destino
      AND t.valor = p_valor
      AND t.criada_em > clock_timestamp() - INTERVAL '60 seconds'
  ) THEN
    RETURN QUERY SELECT 409, 'TRANSFERENCIA_DUPLICADA'::TEXT, NULL::INT, NULL::BIGINT;
    RETURN;
  END IF;

  SELECT u.saldo INTO v_saldo_origem
  FROM usuarios u
  WHERE u.username = p_origem;

  IF v_saldo_origem < p_valor THEN
    RETURN QUERY SELECT 409, 'SALDO_INSUFICIENTE'::TEXT, NULL::INT, NULL::BIGINT;
    RETURN;
  END IF;

  UPDATE usuarios
  SET saldo = saldo - p_valor
  WHERE username = p_origem
  RETURNING saldo INTO v_saldo_origem;

  UPDATE usuarios
  SET saldo = saldo + p_valor
  WHERE username = p_destino;

  INSERT INTO transferencias (origem, destino, valor, criada_em)
  VALUES (p_origem, p_destino, p_valor, clock_timestamp())
  RETURNING id INTO v_id;

  RETURN QUERY SELECT 201, NULL::TEXT, v_id, v_saldo_origem;
END;
$$;
