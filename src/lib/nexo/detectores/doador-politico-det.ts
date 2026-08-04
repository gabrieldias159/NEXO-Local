/**
 * Detector XS-DOADOR — FORNECEDOR (OU SÓCIO) COMO DOADOR DE CAMPANHA
 * (potencial conflito de interesse A VERIFICAR) — NEXO.
 *
 * Cruza os fornecedores da Prefeitura (CNPJ via `ctx.empenhos`) e o quadro de
 * sócios deles (`ctx.socios`, do XS-SOCIO) contra a base de doações eleitorais
 * do TSE (`ctx.doacoesTse`). Todos campos do contexto são adicionados depois
 * pelo ORQUESTRADOR; aqui só CONSUMIMOS.
 *
 * O doador do TSE já vem com `docHash` (hash determinístico do CPF/CNPJ do
 * doador — a base TSE é pública, mas o documento é anonimizado no nosso lado por
 * LGPD). Para casar o FORNECEDOR (que temos como CNPJ cru nos empenhos) contra
 * esse `docHash`, precisamos do hash do CNPJ do fornecedor. O orquestrador
 * injeta a MESMA função `hashDoc` em `ctx.hashDocFn?`. Decisão de degradação:
 *
 *   - COM `ctx.hashDocFn`: casa por (a) hash do CNPJ do fornecedor e (b) cpfHash
 *     de cada sócio contra `docHash` da doação. Cobertura completa.
 *   - SEM `ctx.hashDocFn`: NÃO conseguimos hashear o CNPJ do fornecedor, então
 *     casamos APENAS pelo `cpfHash` dos sócios (que já vem hasheado em
 *     `ctx.socios`) contra `docHash`. Degradação parcial honesta — perde só o
 *     match "a própria empresa doou", mantém "um sócio doou".
 *
 * Se nem `ctx.doacoesTse` houver, o cruzamento está INATIVO e o detector
 * retorna [] honestamente.
 *
 * ⚠ LINGUAGEM OBRIGATÓRIA: DOAÇÃO DE CAMPANHA É ATO LÍCITO. Este detector NÃO
 * afirma irregularidade. É um POTENCIAL CONFLITO DE INTERESSE A VERIFICAR (um
 * fornecedor — ou seu sócio — que doou a uma campanha e depois contrata com o
 * poder público administrado por aquele grupo político). Requer REVISÃO HUMANA.
 * `classificacao` no MÁXIMO 'atencao'. Ver plano-mestre §6–§7. Dados públicos.
 *
 * LGPD: nenhum CPF/CNPJ cru é persistido. O cruzamento usa hash (docHash/cpfHash
 * e o hash do CNPJ via `hashDocFn`); a exibição usa `docMasc`/`cpfMasc` e nomes.
 */
import { formatBRL } from '../normalizar';
import { ehEntidadePublica, cnpjRaiz, soDigitos } from '../entidades';
import type { SocioCtx, SocioPessoa } from './socio-comum-det';
import type { AlertaDetectado, ContextoAnalise, Detector, Evidencia } from './tipos';

const CATEGORIA = 'Fornecedores';

/**
 * Sócio com a `chaveFraca` PRESERVADA. `SocioPessoa` (de socio-comum-det.ts) só
 * carrega `cpfHash`/`cpfMasc`/`nome` — o `cpfMasc` ESCONDE o miolo do CPF, então
 * o `cpf6` (e portanto o `chaveFraca`) NÃO é recuperável a partir dele. A chave
 * fraca tem que vir CRUA do doc `nexo_socios` (gravada pela ingestão, ver
 * `functions/src/nexo/coleta-socios.ts`). Este widening opcional carrega esse
 * campo sem editar `SocioPessoa` (arquivo de outra frente). Quando ausente, o
 * casamento por chave fraca simplesmente não roda para aquele sócio (degrada).
 */
export type SocioPessoaComChaveFraca = SocioPessoa & { chaveFraca?: string };
/** Quadro societário cujas pessoas podem trazer `chaveFraca` (nome+cpf6). */
export type SocioCtxComChaveFraca = Omit<SocioCtx, 'socios'> & {
  socios: SocioPessoaComChaveFraca[];
};

/**
 * Doação eleitoral do TSE, já anonimizada. O ORQUESTRADOR adiciona
 * `ctx.doacoesTse?: DoacaoCtx[]` a `ContextoAnalise` depois; aqui só CONSUMIMOS.
 * `docHash` = hash determinístico do CPF/CNPJ do DOADOR (mesmo algoritmo do
 * `hashDocFn`/`cpfHash`). `docMasc` = documento mascarado, só para exibição.
 */
export interface DoacaoCtx {
  docHash: string;
  docMasc: string;
  nomeDoador: string;
  candidato: string;
  cargo: string;
  ano: number;
  valor: number;
  /**
   * Chave fraca doador↔sócio = `hashDoc(normNome(nome)+"|"+cpf6)` (de
   * `src/lib/nexo/chaves.ts`, gravada na ingestão do TSE). É a ÚNICA forma viável
   * de ligar um doador PESSOA FÍSICA a um sócio da Receita: o CPF cheio é
   * data-blocked dos dois lados, então casa-se por nome normalizado + 6 dígitos
   * do miolo do CPF. NÃO é identificação forte (daí "fraca") — é PROBABILÍSTICA,
   * indício a apurar, sujeita a homonímia + colisão dos 6 dígitos. "" para doador
   * PJ (sem CPF) ou quando faltou nome/cpf6. Opcional/retrocompatível.
   */
  chaveFraca?: string;
}

/**
 * Converte os docs CRUS de `nexo_doacoes_tse` (gravados pelo coletor do TSE com
 * `docHashDoador` = hashDoc do CPF/CNPJ do doador) em DoacaoCtx[]. Usado pelas
 * rotas p/ popular `ctx.doacoesTse`. Sem doc cru — só hash/máscara.
 */
export function doacoesDeDocs(docs: Record<string, unknown>[]): DoacaoCtx[] {
  const out: DoacaoCtx[] = [];
  for (const d of docs) {
    const docHash = String(d.docHashDoador ?? d.docHash ?? '');
    if (!docHash) continue;
    out.push({
      docHash,
      docMasc: String(d.docMasc ?? ''),
      nomeDoador: String(d.nomeDoador ?? ''),
      candidato: String(d.candidato ?? ''),
      cargo: String(d.cargo ?? ''),
      ano: Number(d.ano) || 0,
      valor: typeof d.valor === 'number' ? d.valor : Number(d.valor) || 0,
      // Chave fraca (nome+cpf6) gravada na ingestão do TSE — habilita o casamento
      // PROBABILÍSTICO doador-PF↔sócio. "" quando ausente (doador PJ / sem cpf6).
      chaveFraca: String(d.chaveFraca ?? '') || undefined,
    });
  }
  return out;
}

/**
 * Converte os docs CRUS de `nexo_socios` PRESERVANDO a `chaveFraca` de cada
 * sócio (que `sociosDeDocs` de socio-comum-det.ts descarta). As rotas que querem
 * habilitar o casamento PROBABILÍSTICO doador↔sócio devem popular `ctx.socios`
 * com ESTE conversor; sem ele, o XS-DOADOR continua casando só pelo `cpfHash`
 * forte (cobertura parcial honesta). Nenhum CPF cru é lido — só hash/máscara e a
 * chave fraca (que já é hash de nome+cpf6).
 */
export function sociosComChaveFracaDeDocs(
  docs: Record<string, unknown>[],
): SocioCtxComChaveFraca[] {
  const out: SocioCtxComChaveFraca[] = [];
  for (const d of docs) {
    const cnpj = soDigitos(String(d._cnpj ?? d.cnpj ?? ''));
    if (cnpj.length !== 14) continue;
    const sociosRaw = Array.isArray(d.socios) ? d.socios : [];
    const socios: SocioPessoaComChaveFraca[] = sociosRaw
      .map((s) => {
        const r = (s ?? {}) as Record<string, unknown>;
        return {
          cpfHash: String(r.cpfHash ?? ''),
          cpfMasc: String(r.cpfMasc ?? ''),
          nome: String(r.nome ?? ''),
          chaveFraca: String(r.chaveFraca ?? '') || undefined,
        };
      })
      .filter((s) => s.cpfHash || s.nome || s.chaveFraca);
    out.push({
      cnpj,
      cnpjRaiz: String(d.cnpjRaiz ?? cnpj.slice(0, 8)),
      razaoSocial: String(d.razaoSocial ?? ''),
      socios,
    });
  }
  return out;
}

/**
 * Shim de FORWARD-COMPATIBILIDADE. O orquestrador ainda vai adicionar a
 * `ContextoAnalise` (tipos.ts) os campos OPCIONAIS que CONSUMIMOS aqui. Até lá,
 * este alias os declara local sem editar tipos.ts e sem quebrar o build. Quando
 * entrarem no tipo oficial, este `&` é inócuo — basta apagar o alias.
 * COMO FIAR: orquestrador adiciona em `ContextoAnalise`:
 *   - `doacoesTse?: DoacaoCtx[]`  (da coleta de doações do TSE, já com docHash)
 *   - `socios?: SocioCtx[]`       (grafo de sócios, já com cpfHash) — ver XS-SOCIO
 *   - `hashDocFn?: (doc: string) => string`  (o MESMO hashDoc usado p/ docHash)
 * e popula tudo. `hashDocFn` é o mesmo `hashDoc` que gerou `docHash`/`cpfHash`.
 */
type ContextoComDoacoes = ContextoAnalise & {
  doacoesTse?: DoacaoCtx[];
  socios?: SocioCtx[];
  /** Mesma fn `hashDoc` que gerou `docHash`/`cpfHash`. Ausente → degrada. */
  hashDocFn?: (doc: string) => string;
};

/** Fundamento legal — doação é lícita; foco em impedimento/conflito. SEM 8.429. */
const FUNDAMENTO_LEGAL = [
  'Lei 14.133/2021 art.14 (impedimentos)',
  'CF art.37',
  'Lei 9.504/1997',
];

interface FornecedorEmp {
  raiz: string;
  cnpj: string;
  nome: string;
  valorEmpenhado: number;
}

/**
 * Agrega empenhos por CNPJ-raiz (colapsa filiais), só de fornecedores PRIVADOS
 * com CNPJ de 14 dígitos. EXCLUI ente público. Guarda um CNPJ cheio
 * representativo da raiz para hashear.
 */
function fornecedoresPorRaiz(
  empenhos: ContextoAnalise['empenhos'],
): Map<string, FornecedorEmp> {
  const por = new Map<string, FornecedorEmp>();
  for (const e of empenhos) {
    const cnpj = soDigitos(e.cpfCnpj);
    if (cnpj.length !== 14) continue;
    if (ehEntidadePublica(cnpj, e.fornecedorNome)) continue;
    const raiz = cnpjRaiz(cnpj);
    const cur = por.get(raiz);
    if (cur) {
      cur.valorEmpenhado += e.valorEmpenhado;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
    } else {
      por.set(raiz, {
        raiz,
        cnpj,
        nome: e.fornecedorNome,
        valorEmpenhado: e.valorEmpenhado,
      });
    }
  }
  return por;
}

interface MatchDoacao {
  /** 'empresa' = o próprio fornecedor doou; 'socio' = um sócio doou. */
  via: 'empresa' | 'socio';
  /** rótulo de quem casou (razão social do fornecedor, ou nome/CPFmasc do sócio). */
  quem: string;
  doacao: DoacaoCtx;
  /**
   * Confiança do CASAMENTO doador↔fornecedor/sócio:
   *  - 'forte'   = bateu por hash de documento (docHash/cpfHash) — o mesmo doc.
   *  - 'fraca'   = bateu por `chaveFraca` (nome normalizado + 6 dígitos do miolo
   *    do CPF). É PROBABILÍSTICO: pode ser homônimo cujos 6 dígitos do miolo
   *    coincidem. Indício a apurar, jamais identificação. Ver `chaves.ts`.
   */
  confianca: 'forte' | 'fraca';
}

/**
 * Núcleo testável do XS-DOADOR. Recebe fornecedores (empenhos), grafo de sócios
 * e doações já como listas, mais a `hashDocFn` opcional. Devolve um alerta por
 * fornecedor cujo CNPJ (se houver hashDocFn) ou cujo sócio casa com algum
 * `docHash` de doação. Ordenado por valor envolvido desc.
 */
export function analisarDoadorPolitico(input: {
  empenhos: ContextoAnalise['empenhos'];
  socios: SocioCtxComChaveFraca[];
  doacoes: DoacaoCtx[];
  hashDocFn?: (doc: string) => string;
}): AlertaDetectado[] {
  const { hashDocFn } = input;
  const fornecedores = fornecedoresPorRaiz(input.empenhos);
  if (fornecedores.size === 0) return [];

  // Index doações por docHash → lista (mesmo doador em vários candidatos).
  const doacoesPorHash = new Map<string, DoacaoCtx[]>();
  // Index doações por `chaveFraca` (nome+cpf6) → lista. É o caminho
  // PROBABILÍSTICO para casar doador-PF↔sócio (CPF cheio data-blocked dos dois
  // lados). Só doações de PESSOA FÍSICA têm chaveFraca não vazia.
  const doacoesPorChaveFraca = new Map<string, DoacaoCtx[]>();
  for (const d of input.doacoes) {
    const h = (d.docHash ?? '').trim();
    if (h) {
      const arr = doacoesPorHash.get(h);
      if (arr) arr.push(d);
      else doacoesPorHash.set(h, [d]);
    }
    const cf = (d.chaveFraca ?? '').trim();
    if (cf) {
      const arr = doacoesPorChaveFraca.get(cf);
      if (arr) arr.push(d);
      else doacoesPorChaveFraca.set(cf, [d]);
    }
  }
  // Sem NENHUM índice de doação, não há cruzamento possível.
  if (doacoesPorHash.size === 0 && doacoesPorChaveFraca.size === 0) return [];

  // Index sócios por CNPJ-raiz do fornecedor (só os com empenho/privados).
  const sociosPorRaiz = new Map<string, SocioPessoaComChaveFraca[]>();
  for (const sc of input.socios) {
    const raiz =
      soDigitos(sc.cnpjRaiz).length === 8
        ? soDigitos(sc.cnpjRaiz)
        : cnpjRaiz(soDigitos(sc.cnpj));
    if (!fornecedores.has(raiz)) continue;
    if (ehEntidadePublica(sc.cnpj, sc.razaoSocial)) continue;
    const cur = sociosPorRaiz.get(raiz);
    if (cur) cur.push(...sc.socios);
    else sociosPorRaiz.set(raiz, [...sc.socios]);
  }

  const out: AlertaDetectado[] = [];
  for (const [raiz, f] of fornecedores) {
    const matches: MatchDoacao[] = [];
    const vistos = new Set<DoacaoCtx>();

    // (1) A própria empresa doou? Só se temos como hashear o CNPJ do fornecedor.
    //     Match por hash de documento → confiança FORTE (é o mesmo CNPJ).
    if (hashDocFn) {
      const hashCnpj = (hashDocFn(f.cnpj) ?? '').trim();
      if (hashCnpj) {
        for (const d of doacoesPorHash.get(hashCnpj) ?? []) {
          if (vistos.has(d)) continue;
          vistos.add(d);
          matches.push({
            via: 'empresa',
            quem: f.nome || f.cnpj,
            doacao: d,
            confianca: 'forte',
          });
        }
      }
    }

    // (2) Algum sócio doou? Dois caminhos, em ordem de confiança:
    //     (2a) cpfHash do sócio == docHash da doação → FORTE (mesmo documento).
    //     (2b) chaveFraca do sócio == chaveFraca da doação → FRACA (nome+cpf6,
    //          probabilístico). Só entra se o par ainda não casou pelo forte.
    for (const p of sociosPorRaiz.get(raiz) ?? []) {
      const hash = (p.cpfHash ?? '').trim();
      if (hash) {
        for (const d of doacoesPorHash.get(hash) ?? []) {
          if (vistos.has(d)) continue;
          vistos.add(d);
          matches.push({
            via: 'socio',
            quem: p.nome || p.cpfMasc || 'sócio',
            doacao: d,
            confianca: 'forte',
          });
        }
      }
      const cf = (p.chaveFraca ?? '').trim();
      if (cf) {
        for (const d of doacoesPorChaveFraca.get(cf) ?? []) {
          if (vistos.has(d)) continue;
          vistos.add(d);
          matches.push({
            via: 'socio',
            quem: p.nome || p.cpfMasc || 'sócio',
            doacao: d,
            confianca: 'fraca',
          });
        }
      }
    }

    if (matches.length === 0) continue;

    const totalDoado = matches.reduce((acc, m) => acc + (m.doacao.valor ?? 0), 0);
    const temViaEmpresa = matches.some((m) => m.via === 'empresa');
    const soFraca = matches.every((m) => m.confianca === 'fraca');
    const temFraca = matches.some((m) => m.confianca === 'fraca');
    const nome = f.nome || f.cnpj;
    const degradado = !hashDocFn; // documenta na evidência que faltou hashDocFn

    const evidencias: Evidencia[] = matches.slice(0, 8).map((m) => ({
      resumo:
        (m.via === 'empresa'
          ? `A EMPRESA fornecedora doou`
          : `O SÓCIO ${m.quem} doou`) +
        ` ${formatBRL(m.doacao.valor ?? 0)} em ${m.doacao.ano} a ` +
        `${m.doacao.candidato || 'candidato'}` +
        (m.doacao.cargo ? ` (${m.doacao.cargo})` : '') +
        (m.doacao.docMasc ? ` · doc ${m.doacao.docMasc}` : '') +
        (m.confianca === 'fraca'
          ? ' · casamento PROBABILÍSTICO (nome+6 dígitos do CPF) — confirmar'
          : ''),
      valor: m.doacao.valor ?? 0,
      data: m.doacao.ano ? `${m.doacao.ano}-01-01` : null,
      ref: 'TSE',
    }));
    evidencias.push({
      resumo: `Empenhado ao fornecedor pela Prefeitura: ${formatBRL(f.valorEmpenhado)}`,
      valor: f.valorEmpenhado,
      data: null,
      ref: 'SMARAPD',
    });
    if (temFraca) {
      evidencias.push({
        resumo:
          'Confiança do vínculo: pelo menos um casamento doador↔sócio é FRACO — ' +
          'feito por chave probabilística (nome normalizado + 6 dígitos do miolo ' +
          'do CPF, único dado que ambas as fontes expõem). Pode haver homônimo ' +
          'cujos 6 dígitos coincidem. Indício a apurar, jamais identificação.',
        data: null,
        ref: 'XS-DOADOR',
      });
    }
    if (degradado) {
      evidencias.push({
        resumo:
          'Cobertura PARCIAL: sem hashDocFn no contexto, o CNPJ da própria ' +
          'empresa não foi confrontado com o TSE — só os sócios. Casos "a ' +
          'empresa doou" podem ter ficado de fora.',
        data: null,
        ref: 'XS-DOADOR',
      });
    }

    const candidatos = Array.from(
      new Set(matches.map((m) => m.doacao.candidato).filter(Boolean)),
    ).join(', ');

    const tituloQuem = temViaEmpresa ? 'fornecedor' : 'sócio do fornecedor';
    out.push({
      detectorId: 'XS-DOADOR',
      detectorNome: 'Fornecedor (ou sócio) doador de campanha — conflito a verificar',
      categoria: CATEGORIA,
      titulo:
        `Potencial conflito de interesse A VERIFICAR: ${tituloQuem} consta como ` +
        `doador de campanha — ${nome}` +
        (soFraca ? ' (vínculo probabilístico)' : ''),
      descricao:
        `O ${tituloQuem} ${nome} contratou com a Prefeitura (empenhado ` +
        `${formatBRL(f.valorEmpenhado)}) e consta na base do TSE como doador de ` +
        `campanha${candidatos ? ` (${candidatos})` : ''}, somando ${formatBRL(totalDoado)} ` +
        'em doações. DOAÇÃO DE CAMPANHA É ATO LÍCITO; este é um POTENCIAL ' +
        'CONFLITO DE INTERESSE A VERIFICAR, NÃO uma afirmação de irregularidade. ' +
        (soFraca
          ? 'O vínculo doador↔sócio aqui é PROBABILÍSTICO (casado por nome + 6 ' +
            'dígitos do miolo do CPF, único dado comum às fontes) — pode ser ' +
            'homônimo. Confirmar antes de qualquer conclusão. '
          : '') +
        'Requer revisão humana.',
      sujeitoTipo: 'fornecedor',
      sujeitoId: raiz,
      sujeitoRotulo: nome,
      // Teto OBRIGATÓRIO: no MÁXIMO 'atencao'. Doação é lícita. Quando o vínculo
      // é SÓ probabilístico (chave fraca), rebaixa para 'informativo' — a chance
      // de homonímia/colisão dos 6 dígitos não sustenta nem 'atencao'.
      classificacao: soFraca ? 'informativo' : 'atencao',
      scores: {
        // Bases oficiais (Receita/empenho + TSE) — confiabilidade do FATO é boa;
        // a probabilidade de IRREGULARIDADE é BAIXA (doação é lícita; o que se
        // verifica é eventual impedimento/conflito, que exige análise humana). Um
        // vínculo só por chave fraca derruba a confiabilidade do CASAMENTO.
        confiabilidade: soFraca ? 45 : temFraca ? 65 : 75,
        probabilidadeIrregularidade: 25,
      },
      // SEM Lei 8.429. Degrada p/ [] se a fonte de fundamento não estiver disponível.
      fundamentoLegal: FUNDAMENTO_LEGAL.length ? [...FUNDAMENTO_LEGAL] : [],
      evidencias,
      explicacao:
        'DOAÇÃO DE CAMPANHA É UM ATO LÍCITO E LEGÍTIMO. Este alerta NÃO afirma ' +
        'irregularidade. Ele apenas sinaliza que um fornecedor que recebe ' +
        'recurso público (ou um de seus sócios) também aparece como doador ' +
        'eleitoral na base do TSE — uma situação que PODE configurar conflito de ' +
        'interesse e que CONVÉM VERIFICAR (ex.: doação a quem hoje administra o ' +
        'contrato, possível favorecimento na contratação). O cruzamento é por ' +
        'hash de documento (nenhum CPF/CNPJ cru é exibido ou persistido) e pode ' +
        'haver homonímia/coincidência de hash a confirmar. ' +
        (temFraca
          ? 'PARTE deste vínculo (sócio↔doador) foi casada por CHAVE FRACA — nome ' +
            'normalizado + 6 dígitos do miolo do CPF, único dado que a Receita e o ' +
            'TSE expõem em comum. É PROBABILÍSTICO (homônimo cujos 6 dígitos ' +
            'coincidem é possível), por isso o alerta é rebaixado e exige ' +
            'confirmação documental. '
          : '') +
        'Não há aqui qualquer ' +
        'juízo de improbidade. REQUER REVISÃO HUMANA antes de qualquer conclusão.',
      valorEnvolvido: f.valorEmpenhado,
      discriminador: `doador:${raiz}`,
    });
  }

  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}

/**
 * Detector XS-DOADOR no formato do pipeline (`rodarDetectores`). Degrada para []
 * honestamente quando o TSE não foi anexado (cruzamento inativo). Quando o TSE
 * está presente mas falta `hashDocFn`, roda em cobertura PARCIAL (só sócios) e
 * registra o limite na evidência — nunca um falso negativo silencioso.
 *
 * O casamento sócio↔doador acontece em duas confianças: FORTE (cpfHash==docHash,
 * mesmo documento) e FRACA (chaveFraca==chaveFraca, nome+cpf6 — probabilístico).
 * Para o caminho FRACO funcionar, `ctx.socios` precisa ter sido populado com a
 * `chaveFraca` preservada — use `sociosComChaveFracaDeDocs` deste módulo (o
 * `sociosDeDocs` de socio-comum-det.ts a descarta). Sem isso, só o caminho forte
 * roda (degradação honesta). Vínculo só-fraco é rebaixado a 'informativo'.
 */
export const detectorDoadorPolitico: Detector = {
  id: 'XS-DOADOR',
  nome: 'Fornecedor (ou sócio) doador de campanha — conflito a verificar',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const c = ctx as ContextoComDoacoes;
    const doacoes = c.doacoesTse ?? [];
    if (doacoes.length === 0) return []; // base do TSE não anexada
    if (ctx.empenhos.length === 0) return [];
    return analisarDoadorPolitico({
      empenhos: ctx.empenhos,
      socios: c.socios ?? [],
      doacoes,
      hashDocFn: c.hashDocFn,
    });
  },
};
