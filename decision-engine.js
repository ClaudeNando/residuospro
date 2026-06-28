/* ============================================================================
 * decision-engine.js  —  Cerrado Ambiental / ResíduosPRO
 * ----------------------------------------------------------------------------
 * INFRAESTRUTURA para futuras funcionalidades inteligentes de decisão
 * (precificação, escolha de parceiro, rentabilidade, avaliação de contrato).
 *
 * ESTADO: ESQUELETO. Nada aqui é chamado pelo app ainda.
 * - Não altera regra de negócio, tela, cálculo, Firebase, banco ou localStorage.
 * - Todas as funções são puras (sem efeito colateral) e hoje retornam um
 *   objeto de exemplo ou null. A assinatura/contrato é o que importa agora.
 *
 * CONVENÇÕES (alinhadas ao PROJECT_STATE.md):
 * - Imposto padrão: 15,45% (DAS 11% + ISS) sobre a receita bruta.
 * - Margem incide SOBRE O PREÇO, nunca sobre o custo:
 *     preco = custo / (1 - imposto - margem)
 * - Distâncias sempre ida + volta.
 * - Furgão (veículo próprio): custo cheio ~R$6,46/km; variável ~R$1,39/km;
 *   piso marginal ~R$1,64/km (break-even) e ~R$2,55/km (30%) quando o fixo
 *   já está coberto por contratos.
 * - Valores monetários em R$ (number). Distância em km (number). Sem I/O.
 *
 * NAMESPACE: tudo exposto sob window.DecisionEngine para não poluir o escopo
 * global do index.html nem colidir com funções existentes (calcular, etc.).
 * ========================================================================== */

(function (global) {
  'use strict';

  /* Constantes de referência (espelham as decisões do projeto).
   * Mantidas aqui apenas como DEFAULTS; quando as funções forem ligadas,
   * os valores reais devem vir de cfg/dados, não destas constantes. */
  var DEFAULTS = {
    imposto: 0.1545,        // DAS + ISS
    margemMin: 0.30,        // mínima
    margemIdeal: 0.38,      // ideal
    furgao: {
      custoCheioKm: 6.46,   // custo totalmente rateado
      custoVariavelKm: 1.39,// só o que varia com o km
      fixoMes: 10214,       // custo fixo mensal do veículo próprio
      capacidadeKg: 1500,
      capacidadeM3: 8
    },
    motorista: {            // custos de motorista em viagem de Furgão (TASK-025)
      limiarAjudaKm: 100,   // ida+volta acima disto → ajuda fixa
      ajudaValor: 100,      // R$ pago na FOLHA (entra no custo, não no desembolso)
      blocoDiariaKm: 800,   // a cada bloco = 1 diária cheia (4 itens)
      cafe: 40, almoco: 40, jantar: 40, hospedagem: 200
    }
  };

  /* --------------------------------------------------------------------------
   * calcularPrecoMinimo(params)
   * --------------------------------------------------------------------------
   * RESPONSABILIDADE
   *   Dado um custo total e uma margem-alvo, devolver o preço mínimo de venda
   *   que respeita a regra "margem sobre o preço, descontado o imposto".
   *   No futuro, também devolverá o piso MARGINAL (para encaixar avulso em
   *   capacidade ociosa quando o custo fixo já está coberto por contratos).
   *
   * ENTRADAS (futuras) — params: {
   *   custoTotal:      number   // R$, custo da operação (sem imposto)
   *   imposto?:        number   // fração (default 0.1545)
   *   margemAlvo?:     number   // fração (default 0.30)
   *   km?:             number   // distância ida+volta (p/ cálculos por km)
   *   veiculo?:        string   // 'FURGAO' | 'BAU' | 'MAIOR'
   *   modo?:           string   // 'cheio' | 'marginal'
   *   fixoCoberto?:    boolean  // se contratos já cobrem o fixo (modo marginal)
   * }
   *
   * SAÍDA (futura) — objeto: {
   *   precoMinimo:     number   // R$ que garante a margemAlvo após imposto
   *   precoBreakEven:  number   // R$ que zera o resultado (margem 0)
   *   margemResultante:number   // fração, para conferência
   *   pisoMarginalKm?: number   // R$/km marginal, quando aplicável
   *   base:            string   // 'cheio' | 'marginal'
   * }
   *
   * DEPENDÊNCIAS FUTURAS
   *   cfg.imposto, cfg.margemMin; parâmetros de custo do veículo.
   * ------------------------------------------------------------------------ */
  /* Normaliza imposto/margem: aceita fração (0.1545) ou percentual (15.45). */
  function _frac(x, def) {
    if (x == null || isNaN(x)) return def;
    x = Number(x);
    return x > 1 ? x / 100 : x;
  }

  function calcularPrecoMinimo(params) {
    params = params || {};
    var imposto = _frac(params.imposto, DEFAULTS.imposto);
    var margemAlvo = _frac(params.margemAlvo != null ? params.margemAlvo : params.margem, DEFAULTS.margemMin);

    // custo base (sem imposto): explícito, ou km × custo/km
    var custo = null;
    if (params.custoTotal != null) custo = Number(params.custoTotal);
    else if (params.km != null && params.custoKm != null) custo = Number(params.km) * Number(params.custoKm);
    if (custo == null || isNaN(custo)) {
      return { precoMinimo: null, precoBreakEven: null, margemResultante: null, pisoMarginalKm: null, breakEvenKm: null, base: params.modo || 'cheio' };
    }

    var denom = 1 - imposto - margemAlvo;
    var precoMinimo = denom > 0 ? custo / denom : null;
    var precoBreakEven = (1 - imposto) > 0 ? custo / (1 - imposto) : null;
    // margem resultante recalculada (conferência): deve igualar margemAlvo
    var margemResultante = precoMinimo ? (precoMinimo - custo - precoMinimo * imposto) / precoMinimo : null;

    var km = params.km != null ? Number(params.km) : null;
    // Opcional: margem de um preço proposto sobre esta base de custo (mesma identidade do sistema)
    var precoProposto = params.precoProposto != null ? Number(params.precoProposto) : null;
    var margemProposta = (precoProposto && precoProposto > 0) ? (precoProposto - custo - precoProposto * imposto) / precoProposto : null;
    return {
      custoBase: custo,
      precoMinimo: precoMinimo,
      precoBreakEven: precoBreakEven,
      margemResultante: margemResultante,
      pisoMarginalKm: (km && precoMinimo != null) ? precoMinimo / km : null,
      breakEvenKm: (km && precoBreakEven != null) ? precoBreakEven / km : null,
      precoProposto: precoProposto,
      margemProposta: margemProposta,
      base: params.modo || 'cheio'
    };
  }

  /* --------------------------------------------------------------------------
   * escolherMelhorParceiro(params)
   * --------------------------------------------------------------------------
   * RESPONSABILIDADE
   *   Comparar transportadores parceiros (e o furgão próprio) para uma rota e
   *   recomendar o de menor custo viável, considerando tarifa R$/km de cada um,
   *   distância ida+volta e capacidade necessária.
   *
   * ENTRADAS (futuras) — params: {
   *   km:              number          // ida+volta
   *   pesoKg?:         number          // p/ checar capacidade
   *   volumeM3?:       number          // p/ checar capacidade
   *   parceiros:       Array<{         // candidatos
   *     nome: string, custoKm: number,
   *     capacidadeKg?: number, capacidadeM3?: number, uf?: string
   *   }>
   *   incluirFurgao?:  boolean         // considerar o veículo próprio
   * }
   *
   * SAÍDA (futura) — objeto: {
   *   recomendado:     { nome, custoKm, custoTotal } | null
   *   ranking:         Array<{ nome, custoKm, custoTotal, viavel: boolean }>
   *   motivo:          string          // por que foi escolhido
   * }
   *
   * DEPENDÊNCIAS FUTURAS
   *   Cadastro de transportadores parceiros (pendente, item 3 do roadmap);
   *   custo do furgão (R$6,46/km).
   * ------------------------------------------------------------------------ */
  function escolherMelhorParceiro(params) {
    params = params || {};
    var km = Number(params.km) || 0;
    var pesoKg = params.pesoKg != null ? Number(params.pesoKg) : null;
    var volumeM3 = params.volumeM3 != null ? Number(params.volumeM3) : null;
    var candidatos = (params.parceiros || []).slice();

    if (params.incluirFurgao) {
      candidatos.push({ nome: 'Furgão (próprio)', custoKm: DEFAULTS.furgao.custoCheioKm, capacidadeKg: DEFAULTS.furgao.capacidadeKg, capacidadeM3: DEFAULTS.furgao.capacidadeM3 });
    }

    var ranking = candidatos.map(function (p) {
      var viavel = true, motivos = [];
      if (pesoKg != null && p.capacidadeKg != null && pesoKg > p.capacidadeKg) { viavel = false; motivos.push('peso acima da capacidade'); }
      if (volumeM3 != null && p.capacidadeM3 != null && volumeM3 > p.capacidadeM3) { viavel = false; motivos.push('volume acima da capacidade'); }
      var custoTotal = (Number(p.custoKm) || 0) * km;
      return { nome: p.nome, custoKm: Number(p.custoKm) || 0, custoTotal: custoTotal, viavel: viavel, motivo: motivos.join('; ') || null };
    }).sort(function (a, b) {
      if (a.viavel !== b.viavel) return a.viavel ? -1 : 1; // viáveis primeiro
      return a.custoTotal - b.custoTotal;                  // depois, menor custo
    });

    var rec = ranking.filter(function (r) { return r.viavel; })[0] || null;
    return {
      recomendado: rec ? { nome: rec.nome, custoKm: rec.custoKm, custoTotal: rec.custoTotal } : null,
      ranking: ranking,
      motivo: rec ? ('Menor custo total entre os parceiros viáveis (' + rec.nome + ').') : 'Nenhum parceiro viável para a capacidade exigida.'
    };
  }

  /* --------------------------------------------------------------------------
   * analisarRentabilidadeCliente(params)
   * --------------------------------------------------------------------------
   * RESPONSABILIDADE
   *   A partir do histórico de orçamentos/viagens de um cliente, calcular
   *   indicadores de rentabilidade (faturamento, margem média, R$/km, peso na
   *   carteira) e classificar o cliente.
   *
   * ENTRADAS (futuras) — params: {
   *   cliente:         string
   *   registros:       Array<{         // orçamentos OU viagens do cliente
   *     tot?: number, fat?: number,    // receita
   *     sob?: number,                  // sobra/lucro (orçamento)
   *     custo?: number,                // desembolso (viagem)
   *     mar?: number, km?: number, data?: string
   *   }>
   *   imposto?:        number          // default 0.1545
   * }
   *
   * SAÍDA (futura) — objeto: {
   *   faturamentoTotal:number
   *   margemMedia:     number          // fração
   *   reaisPorKm:      number
   *   nViagens:        number
   *   classificacao:   string          // ex.: 'alta' | 'média' | 'baixa'
   *   alerta?:         string          // ex.: margem abaixo do mínimo
   * }
   *
   * DEPENDÊNCIAS FUTURAS
   *   rpro_hist (orçamentos) e/ou fp2_viagens (viagens do furgão).
   * ------------------------------------------------------------------------ */
  function analisarRentabilidadeCliente(params) {
    params = params || {};
    var regs = (params.registros || []).filter(function (r) { return r; });
    var n = regs.length;
    if (!n) {
      return { cliente: params.cliente || null, faturamentoTotal: 0, lucroTotal: 0, margemMedia: null,
               reaisPorKm: null, ticketMedio: null, kmTotal: 0, nViagens: 0, classificacao: null, alerta: 'Sem registros.' };
    }
    var imposto = _frac(params.imposto, DEFAULTS.imposto);
    var fatTotal = 0, lucroTotal = 0, kmTotal = 0, margSum = 0, margN = 0;
    regs.forEach(function (r) {
      var receita = (r.fat != null ? Number(r.fat) : Number(r.tot)) || 0;   // orçamento usa tot; viagem usa fat
      fatTotal += receita;
      if (r.sob != null) lucroTotal += Number(r.sob) || 0;                  // orçamento já traz a sobra
      else if (r.custo != null) lucroTotal += receita - (Number(r.custo) || 0) - receita * imposto; // viagem: deriva
      kmTotal += Number(r.km) || 0;
      if (r.mar != null) { margSum += Number(r.mar); margN++; }
    });
    var margemMedia = margN ? margSum / margN : (fatTotal > 0 ? lucroTotal / fatTotal : null);
    var reaisPorKm = kmTotal > 0 ? fatTotal / kmTotal : null;
    var ticketMedio = fatTotal / n;
    var classificacao;
    if (margemMedia == null) classificacao = null;
    else if (margemMedia < DEFAULTS.margemMin) classificacao = 'baixa';
    else if (margemMedia >= DEFAULTS.margemIdeal) classificacao = 'alta';
    else classificacao = 'média';
    var alerta = (margemMedia != null && margemMedia < DEFAULTS.margemMin) ? 'Margem média abaixo do mínimo.' : null;
    return {
      cliente: params.cliente || null,
      faturamentoTotal: fatTotal,
      lucroTotal: lucroTotal,
      margemMedia: margemMedia,
      reaisPorKm: reaisPorKm,
      ticketMedio: ticketMedio,
      kmTotal: kmTotal,
      nViagens: n,
      classificacao: classificacao,
      alerta: alerta
    };
  }

  /* --------------------------------------------------------------------------
   * avaliarContrato(params)
   * --------------------------------------------------------------------------
   * RESPONSABILIDADE
   *   Avaliar a saúde de um contrato recorrente: quanto cobre do custo fixo,
   *   margem ao longo do prazo, e risco de corrosão por inflação quando não há
   *   cláusula de reajuste (relevante para contratos longos, ex.: 36 meses).
   *
   * ENTRADAS (futuras) — params: {
   *   valorMensal:     number
   *   kmMes?:          number          // ida+volta no mês
   *   custoVariavelKm?:number          // default 1.39
   *   fixoMes?:        number          // default 10214 (rateio do furgão)
   *   imposto?:        number          // default 0.1545
   *   duracaoMeses:    number
   *   mesesDecorridos?:number
   *   reajusteIndice?: string|null     // 'IPCA' | 'IGPM' | null (sem reajuste)
   *   inflacaoAnual?:  number          // fração, p/ projeção
   * }
   *
   * SAÍDA (futura) — objeto: {
   *   contribuicaoMes: number          // R$ que sobra p/ cobrir fixo (após var+imposto)
   *   coberturaFixo:   number          // fração do fixo coberta
   *   margemAtual:     number          // fração
   *   margemProjetadaFim:number        // fração ao fim do prazo (com inflação)
   *   risco:           string          // ex.: 'sem reajuste — margem corrói'
   *   mesesRestantes:  number
   * }
   *
   * DEPENDÊNCIAS FUTURAS
   *   Cadastro de contratos recorrentes (pendente, item 1 do roadmap / próxima tarefa).
   * ------------------------------------------------------------------------ */
  function avaliarContrato(params) {
    params = params || {};
    var receita = Number(params.valorMensal) || 0;
    if (receita <= 0) {
      return { receitaMes: 0, impostoMes: 0, custoVariavelMes: 0, contribuicaoMes: 0, margemContribuicao: null,
               coberturaFixo: null, margemAtual: null, margemProjetadaFim: null, risco: 'Valor mensal inválido.', mesesRestantes: null };
    }
    var imposto = _frac(params.imposto, DEFAULTS.imposto);
    var kmMes = Number(params.kmMes) || 0;
    var custoVarKm = params.custoVariavelKm != null ? Number(params.custoVariavelKm) : DEFAULTS.furgao.custoVariavelKm;
    var fixoMes = params.fixoMes != null ? Number(params.fixoMes) : DEFAULTS.furgao.fixoMes;
    var duracao = Number(params.duracaoMeses) || 0;
    var decorridos = Number(params.mesesDecorridos) || 0;
    var indice = params.reajusteIndice || null;            // 'IPCA' | 'IGPM' | null
    var semReajuste = !indice || indice === 'sem' || indice === 'nenhum';
    var inflacao = _frac(params.inflacaoAnual, 0.045);     // 4,5% a.a. default

    var impostoMes = receita * imposto;
    var custoVariavelMes = kmMes * custoVarKm;
    var contribuicaoMes = receita - impostoMes - custoVariavelMes;   // margem de contribuição (antes do fixo)
    var margemContribuicao = contribuicaoMes / receita;
    var coberturaFixo = fixoMes > 0 ? contribuicaoMes / fixoMes : null;

    // Margem líquida só é calculável se houver rateio de fixo informado (fixoAlocadoMes)
    var margemAtual = null;
    if (params.fixoAlocadoMes != null) {
      margemAtual = (receita - impostoMes - custoVariavelMes - Number(params.fixoAlocadoMes)) / receita;
    }

    // Projeção ao fim do prazo: sem reajuste, custos sobem com a inflação e a receita fica fixa.
    var anos = duracao > 0 ? duracao / 12 : 0;
    var margemProjetadaFim = margemContribuicao;
    if (semReajuste && anos > 0) {
      var fator = Math.pow(1 + inflacao, anos);
      var custoVarFim = custoVariavelMes * fator;
      margemProjetadaFim = (receita - impostoMes - custoVarFim) / receita;
    }

    var mesesRestantes = duracao > 0 ? Math.max(0, duracao - decorridos) : null;

    var risco;
    if (contribuicaoMes <= 0) risco = 'Crítico: não cobre nem o custo variável.';
    else if (semReajuste && (margemContribuicao - margemProjetadaFim) >= 0.05) risco = 'Atenção: contrato longo sem reajuste — a margem corrói ao longo do prazo.';
    else if (semReajuste) risco = 'Sem cláusula de reajuste; monitorar inflação.';
    else risco = 'OK: contrato com reajuste previsto.';

    return {
      receitaMes: receita,
      impostoMes: impostoMes,
      custoVariavelMes: custoVariavelMes,
      contribuicaoMes: contribuicaoMes,
      margemContribuicao: margemContribuicao,
      coberturaFixo: coberturaFixo,
      margemAtual: margemAtual,
      margemProjetadaFim: margemProjetadaFim,
      mesesRestantes: mesesRestantes,
      reajuste: { indice: indice, semReajuste: semReajuste, inflacaoAnual: inflacao },
      risco: risco
    };
  }

  /* --------------------------------------------------------------------------
   * calcularAnaliseNegociacao(orcamento, cfg)   [IMPLEMENTADA]
   * --------------------------------------------------------------------------
   * RESPONSABILIDADE
   *   A partir de um orçamento JÁ CALCULADO pelo sistema, derivar uma análise
   *   de negociação: preço mínimo (na margem mínima configurada), folga para
   *   negociar, simulação de cenários e uma recomendação. NÃO recalcula a
   *   regra de negócio — reaproveita o custo que o sistema já produziu e usa a
   *   MESMA fórmula (margem sobre o preço, descontado o imposto).
   *
   * ENTRADAS
   *   orcamento: objeto ultimoCalculo do app, com pelo menos:
   *     { ctf, cdf, tot, mar }   // custo transporte, custo destinação,
   *                              // total (preço atual), margem (fração)
   *   cfg:       { imposto (ex.: 15.45), margemMin (ex.: 30) }
   *
   * SAÍDA
   *   {
   *     precoMinimo, precoAtual, margemAtual, folgaNegociacao, margemMin,
   *     simulacoes: [ { label, preco, lucro, margem } ],
   *     recomendacao
   *   }
   *   Retorna null se o orçamento não tiver total.
   *
   * FÓRMULAS (idênticas às do sistema)
   *   custoBase   = ctf + cdf                       (custo sem imposto)
   *   precoMinimo = custoBase / (1 - imposto - margemMin)
   *   por cenário: imp = preco*imposto; lucro = preco - custoBase - imp;
   *                margem = lucro / preco
   * ------------------------------------------------------------------------ */
  function calcularAnaliseNegociacao(orcamento, cfg) {
    if (!orcamento || !orcamento.tot) return null;
    var imposto   = (cfg && cfg.imposto   != null ? cfg.imposto   : 15.45) / 100;
    var margemMin = (cfg && cfg.margemMin != null ? cfg.margemMin : 30)    / 100;
    var custoBase = (orcamento.ctf || 0) + (orcamento.cdf || 0) + (orcamento.ped || 0) + ((orcamento.cmot && orcamento.cmot.custoTotal) || 0);
    var precoAtual = orcamento.tot;
    var denom = 1 - imposto - margemMin;
    var precoMinimo = denom > 0 ? custoBase / denom : null;
    var folga = (precoMinimo != null) ? (precoAtual - precoMinimo) : null;

    function cenario(label, preco) {
      var imp = preco * imposto;
      var lucro = preco - custoBase - imp;
      var margem = preco > 0 ? lucro / preco : 0;
      return { label: label, preco: preco, lucro: lucro, margem: margem };
    }

    var simulacoes = [
      cenario('Preço atual', precoAtual),
      cenario('Preço −5%', precoAtual * 0.95),
      cenario('Preço −10%', precoAtual * 0.90)
    ];
    if (precoMinimo != null) {
      simulacoes.push(cenario('Preço mínimo (' + (margemMin * 100).toFixed(0) + '%)', precoMinimo));
    }

    var pct = (orcamento.mar || 0) * 100;
    var mmPct = margemMin * 100;
    var recomendacao;
    if (pct > 40)          recomendacao = 'Existe boa margem para negociação.';
    else if (pct >= 35)    recomendacao = 'Negociação moderada recomendada.';
    else if (pct >= mmPct) recomendacao = 'Pouca margem disponível.';
    else                   recomendacao = 'Não recomendado reduzir este orçamento.';

    return {
      precoMinimo: precoMinimo,
      precoAtual: precoAtual,
      margemAtual: orcamento.mar,
      folgaNegociacao: folga,
      margemMin: margemMin,
      simulacoes: simulacoes,
      recomendacao: recomendacao
    };
  }

  /* --------------------------------------------------------------------------
   * aplicarReajuste(params)   [IMPLEMENTADA]
   * Aplica o reajuste anual composto ao valor de um contrato conforme o tempo
   * decorrido. Mantém a regra financeira no Decision Engine (não na UI).
   * ENTRADAS: { valorBase, percentualAnual, mesesDecorridos }
   * SAÍDA: { valorAtual, reajustesAplicados, proximoReajusteEmMeses, percentualAnual }
   * ------------------------------------------------------------------------ */
  function aplicarReajuste(params) {
    params = params || {};
    var v = Number(params.valorBase) || 0;
    var p = _frac(params.percentualAnual, 0);
    var meses = Number(params.mesesDecorridos) || 0;
    var anos = Math.floor(meses / 12);
    var valorAtual = v * Math.pow(1 + p, anos);
    return {
      valorAtual: valorAtual,
      reajustesAplicados: anos,
      proximoReajusteEmMeses: Math.max(0, (anos + 1) * 12 - meses),
      percentualAnual: p
    };
  }

  /* --------------------------------------------------------------------------
   * calcularCustoMotoristaViagem(kmIdaVolta, cfg)   [IMPLEMENTADA — TASK-025]
   * --------------------------------------------------------------------------
   * Custos de motorista numa viagem de Furgão, em função da distância ida+volta:
   *  - Ajuda fixa: d > limiar → valor fixo. É paga na FOLHA → entra no custo do
   *    orçamento, mas NÃO no desembolso em dinheiro da viagem.
   *  - Diárias escalonadas (acumulam desde o início): a cada (bloco/4) km libera-se
   *    o próximo item do ciclo [café, almoço, jantar, hospedagem]; bloco completo
   *    (800 km) = 1 diária cheia. As diárias entram no custo E são o desembolso.
   *  Ex.: 100→0; 200→café(40); 800→320 (1 diária); 900→320; 1000→360 (1 diária+café).
   *
   * SAÍDA: {
   *   km, ajuda, diarias, diariasCheias,
   *   itens: [{ nome, qtd, valor, subtotal }],   // agrupado p/ exibição
   *   custoTotal,   // ajuda + diarias  → soma ao custo do orçamento (preço/margem)
   *   desembolso    // só diarias       → dinheiro na mão do motorista (sem a ajuda)
   * }
   * Os parâmetros vêm de cfg.motorista (com fallback para DEFAULTS.motorista).
   * ------------------------------------------------------------------------ */
  function calcularCustoMotoristaViagem(kmIdaVolta, cfg) {
    var m = (cfg && cfg.motorista) || {};
    var d = Number(kmIdaVolta) || 0;
    function _num(v, def) { return (v == null || isNaN(v)) ? def : Number(v); }
    var limiar     = _num(m.limiarAjudaKm, DEFAULTS.motorista.limiarAjudaKm);
    var ajudaValor = _num(m.ajudaValor,    DEFAULTS.motorista.ajudaValor);
    var bloco      = _num(m.blocoDiariaKm, DEFAULTS.motorista.blocoDiariaKm);
    var ciclo = [
      { nome: 'Café da manhã', valor: _num(m.cafe,       DEFAULTS.motorista.cafe) },
      { nome: 'Almoço',        valor: _num(m.almoco,     DEFAULTS.motorista.almoco) },
      { nome: 'Jantar',        valor: _num(m.jantar,     DEFAULTS.motorista.jantar) },
      { nome: 'Hospedagem',    valor: _num(m.hospedagem, DEFAULTS.motorista.hospedagem) }
    ];

    var ajuda = d > limiar ? ajudaValor : 0;
    var passo = bloco > 0 ? bloco / 4 : 0;          // 4 itens por diária (passo de 200 km)
    var n = passo > 0 ? Math.floor(d / passo) : 0;  // nº de itens liberados

    var qtd = [0, 0, 0, 0], diarias = 0;
    for (var i = 0; i < n; i++) { var pos = i % 4; qtd[pos]++; diarias += ciclo[pos].valor; }
    var itens = [];
    for (var p = 0; p < 4; p++) {
      if (qtd[p] > 0) itens.push({ nome: ciclo[p].nome, qtd: qtd[p], valor: ciclo[p].valor, subtotal: qtd[p] * ciclo[p].valor });
    }

    return {
      km: d,
      ajuda: ajuda,
      diarias: diarias,
      diariasCheias: Math.floor(n / 4),
      itens: itens,
      custoTotal: ajuda + diarias,
      desembolso: diarias
    };
  }

  /* --------------------------------------------------------------------------
   * calcularCapacidadeTransbordo(params)   [IMPLEMENTADA — TASK-014]
   * --------------------------------------------------------------------------
   * Compara, para uma carga grande, COLETA DIRETA (várias viagens do furgão)
   * vs TRANSBORDO (caçamba roll-on: mobilização + locação + hauls do roll-on).
   * Distâncias ida+volta. Sem formatação (UI formata).
   *
   * ENTRADAS — params: {
   *   pesoKg?, volumeM3?, km,
   *   capVeicKg?(1500), capVeicM3?(8), custoVeicKm?(6.46),
   *   incluirMotorista?(bool), cfg?(p/ custo de motorista),
   *   capCacambaKg?, capCacambaM3?, mobilizacao?, locacaoValor?, locacaoQtd?,
   *   custoRollOnKm?(10)
   * }
   * SAÍDA: { temCarga, direta:{viavel,nViagens,custoTransporte,custoMotorista,custoTotal},
   *          transbordo:{viavel,nHauls,mobilizacao,locacao,custoTransporte,custoTotal},
   *          recomendado:'direta'|'transbordo'|null, economia, motivo }
   * ------------------------------------------------------------------------ */
  function calcularCapacidadeTransbordo(params) {
    params = params || {};
    var pesoKg = Number(params.pesoKg) || 0, volumeM3 = Number(params.volumeM3) || 0, km = Number(params.km) || 0;
    var capVeicKg = params.capVeicKg != null ? Number(params.capVeicKg) : DEFAULTS.furgao.capacidadeKg;
    var capVeicM3 = params.capVeicM3 != null ? Number(params.capVeicM3) : DEFAULTS.furgao.capacidadeM3;
    var custoVeicKm = params.custoVeicKm != null ? Number(params.custoVeicKm) : DEFAULTS.furgao.custoCheioKm;
    var capCacKg = Number(params.capCacambaKg) || 0, capCacM3 = Number(params.capCacambaM3) || 0;
    var mobilizacao = Number(params.mobilizacao) || 0;
    var locacao = (Number(params.locacaoValor) || 0) * (Number(params.locacaoQtd) || 0);
    var custoRollOnKm = params.custoRollOnKm != null ? Number(params.custoRollOnKm) : 10;

    function _viagens(capKg, capM3) {
      var byP = (pesoKg > 0 && capKg > 0) ? Math.ceil(pesoKg / capKg) : 0;
      var byV = (volumeM3 > 0 && capM3 > 0) ? Math.ceil(volumeM3 / capM3) : 0;
      return Math.max(byP, byV);
    }
    var temCarga = pesoKg > 0 || volumeM3 > 0;

    var nViagens = _viagens(capVeicKg, capVeicM3);
    var diretaViavel = temCarga && nViagens > 0;
    var motoristaPorViagem = 0;
    if (params.incluirMotorista) { motoristaPorViagem = calcularCustoMotoristaViagem(km, params.cfg || {}).custoTotal; }
    var diretaTransporte = nViagens * km * custoVeicKm;
    var diretaMotorista = nViagens * motoristaPorViagem;
    var diretaTotal = diretaTransporte + diretaMotorista;

    var nHauls = _viagens(capCacKg, capCacM3);
    var transbordoViavel = temCarga && nHauls > 0;
    var transbordoTransporte = nHauls * km * custoRollOnKm;
    var transbordoTotal = mobilizacao + locacao + transbordoTransporte;

    var recomendado = null, economia = null, motivo;
    if (diretaViavel && transbordoViavel) {
      if (transbordoTotal < diretaTotal) { recomendado = 'transbordo'; economia = diretaTotal - transbordoTotal; motivo = 'Transbordo mais barato (evita ' + nViagens + ' viagens diretas).'; }
      else { recomendado = 'direta'; economia = transbordoTotal - diretaTotal; motivo = 'Coleta direta mais barata.'; }
    } else if (diretaViavel) {
      recomendado = 'direta'; motivo = 'Informe a capacidade da caçamba (m³ ou kg) para comparar com transbordo.';
    } else {
      motivo = 'Informe peso e/ou volume da carga.';
    }

    return {
      temCarga: temCarga,
      direta: { viavel: diretaViavel, nViagens: nViagens, custoTransporte: diretaTransporte, custoMotorista: diretaMotorista, custoTotal: diretaTotal },
      transbordo: { viavel: transbordoViavel, nHauls: nHauls, mobilizacao: mobilizacao, locacao: locacao, custoTransporte: transbordoTransporte, custoTotal: transbordoTotal },
      recomendado: recomendado, economia: economia, motivo: motivo
    };
  }

  /* Exposição pública (sem efeito colateral, sem chamadas automáticas). */
  global.DecisionEngine = {
    _version: '0.7.0',
    DEFAULTS: DEFAULTS,
    calcularAnaliseNegociacao: calcularAnaliseNegociacao,
    calcularCustoMotoristaViagem: calcularCustoMotoristaViagem,
    calcularCapacidadeTransbordo: calcularCapacidadeTransbordo,
    calcularPrecoMinimo: calcularPrecoMinimo,
    escolherMelhorParceiro: escolherMelhorParceiro,
    analisarRentabilidadeCliente: analisarRentabilidadeCliente,
    avaliarContrato: avaliarContrato,
    aplicarReajuste: aplicarReajuste
  };

})(typeof window !== 'undefined' ? window : this);
