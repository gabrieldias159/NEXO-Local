/**
 * CRUZAMENTO DE PESSOAS — item 5 do plano de perfilamento
 * (docs/nexo-perfilamento-auditoria.md).
 *
 * Substitui o `cruzamento_nexo.json` congelado (one-off de 149 pessoas, script
 * não versionado) por um CRON que materializa, para TODA pessoa política
 * conhecida (`nexo_candidatos_tse`, todos os anos), o retrato consolidado do
 * que as coleções do NEXO sabem sobre ela — com CONFIANÇA por perna:
 *
 *   forte  → join por chaveFraca (nome normalizado + miolo do CPF): é o join
 *            mais forte possível dado que nenhuma fonte expõe CPF completo
 *            publicamente dos dois lados.
 *   fraca  → join por nome normalizado apenas (homônimos possíveis — a UI
 *            SEMPRE rotula). Indício a apurar, nunca identificação.
 *
 * Saída: `nexo_pessoas_cruzamento`, 1 doc por pessoa, docId = hashDoc(personId)
 * onde personId = 'n:'+nomeNorm (a MESMA chave das fichas do app — a rota
 * `/api/nexo/pessoa-conexoes` serve este doc como fast-path materializado).
 * NENHUM CPF/CNPJ cru é persistido: só hash/mascarado (invariante do módulo).
 *
 * Arquitetura de 1 passada: cada coleção-fonte é lida UMA vez (capada) e vira
 * índice em memória por chaveFraca/nomeNorm; cada pessoa é O(1) de lookups.
 * Depende do backfill de `nexo_candidatos_tse` (item 3) — com a coleção vazia
 * o cron loga e sai sem erro (idempotente, pode rodar antes do backfill).
 */
import { createHash } from "node:crypto";

import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { normNome } from "./chaves";

/**
 * docId determinístico do doc de pessoa: sha256 PURO do personId ('n:'+nome
 * normalizado). NÃO usa hashDoc/salt de pii.ts de propósito: hashDoc só
 * hasheia DÍGITOS (é para CPF/CNPJ — com personId textual viraria hash de "")
 * e o personId não é dado sensível (nome público das fontes oficiais) — o
 * hash aqui é só para docId estável/limpo, e o app recomputa o mesmo sha256.
 */
function docIdDePessoa(personId: string): string {
  return createHash("sha256").update(personId).digest("hex");
}

const COL_SAIDA = "nexo_pessoas_cruzamento";
const VERSAO_ESQUEMA = 1;
/** Teto de docs lidos por coleção — proteção de memória/tempo (espelha cruzamentos.ts). */
const MAX_DOCS = 30_000;
/** Teto de itens guardados por perna (a ficha mostra resumo; detalhe é drill-down). */
const MAX_ITENS = 12;

// ── util (espelho dos normalizadores do módulo) ──────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}
function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const s = v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v;
    const n = Number(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

interface DocLido {
  id: string;
  data: Record<string, unknown>;
}
async function lerColecao(colecao: string, max = MAX_DOCS): Promise<DocLido[]> {
  const snap = await db.collection(colecao).limit(max).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/** push num Map<string, T[]> */
function empurra<T>(m: Map<string, T[]>, k: string, v: T): void {
  if (!k) return;
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

// ── o cron ────────────────────────────────────────────────────────────────────

export const onNexoCruzamentoPessoas = onSchedule(
  {
    // Depois do cruzamentos (08h45) e das coletas da madrugada — lê o que eles
    // acabaram de materializar.
    schedule: "15 9 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const t0 = Date.now();

    // 1) universo: pessoas políticas (candidatos TSE, todos os anos)
    const candidatos = await lerColecao("nexo_candidatos_tse");
    if (candidatos.length === 0) {
      logger.warn(
        "[cruzamento-pessoas] nexo_candidatos_tse vazia — rode o backfill do item 3; saindo sem materializar",
      );
      return;
    }

    // 2) fontes, uma leitura cada
    const [doacoes, socios, entidades, diarias, passagens, nomeacoes, contas] =
      await Promise.all([
        lerColecao("nexo_doacoes_tse"),
        lerColecao("nexo_socios"),
        lerColecao("nexo_entidades"),
        lerColecao("nexo_diarias"),
        lerColecao("nexo_passagens"),
        lerColecao("nexo_nomeacoes", 5_000),
        lerColecao("nexo_contas_irregulares", 5_000),
      ]);

    // 3) índices em memória
    // doações por chaveFraca (forte) e por nomeNorm do doador (fraca)
    const doacaoPorCf = new Map<string, DocLido[]>();
    const doacaoPorNome = new Map<string, DocLido[]>();
    for (const d of doacoes) {
      empurra(doacaoPorCf, str(d.data.chaveFraca), d);
      empurra(doacaoPorNome, normNome(d.data.nomeDoador), d);
    }
    // sócios: por chaveFraca do sócio (forte) e por nomeNorm (fraca)
    interface EmpresaDoSocio {
      cnpj: string;
      razaoSocial: string;
      qualificacao: string;
      confianca: "forte" | "fraca";
    }
    const socioPorCf = new Map<string, EmpresaDoSocio[]>();
    const socioPorNome = new Map<string, EmpresaDoSocio[]>();
    for (const s of socios) {
      const cnpj = str(s.data._cnpj);
      const razao = str(s.data.razaoSocial);
      const lista = Array.isArray(s.data.socios)
        ? (s.data.socios as Record<string, unknown>[])
        : [];
      for (const p of lista) {
        const base = { cnpj, razaoSocial: razao, qualificacao: str(p.qualificacao) };
        empurra(socioPorCf, str(p.chaveFraca), { ...base, confianca: "forte" });
        empurra(socioPorNome, normNome(p.nome), { ...base, confianca: "fraca" });
      }
    }
    // fornecedor PF por nomeNorm
    const fornPfPorNome = new Map<string, Record<string, unknown>>();
    for (const e of entidades) {
      if (e.data.tipo !== "pessoa") continue;
      const k = normNome(e.data.nome);
      if (k && !fornPfPorNome.has(k)) fornPfPorNome.set(k, e.data);
    }
    // diárias/passagens por nomeNorm do beneficiário
    const movPorNome = new Map<string, { valor: number; data: string }[]>();
    const varreMov = (docs: DocLido[]) => {
      for (const d of docs) {
        const nome = normNome(
          str(d.data.NomeFornecedor) || str(d.data.Beneficiario) || str(d.data.NomeServidor),
        );
        empurra(movPorNome, nome, {
          valor: toNum(d.data.ValorEmpenhado ?? d.data.ValorEmpenho),
          data: str(d.data.DataEmp ?? d.data.DataEmpenho ?? d.data.Data),
        });
      }
    };
    varreMov(diarias);
    varreMov(passagens);
    // atos DOM e contas irregulares por nomeNorm
    const atoPorNome = new Map<string, DocLido[]>();
    for (const a of nomeacoes) empurra(atoPorNome, normNome(a.data.nome ?? a.data.nomeNorm), a);
    const contaPorNome = new Map<string, DocLido[]>();
    for (const c of contas) empurra(contaPorNome, normNome(c.data.nome ?? c.data.nomeNorm), c);

    // 4) uma pessoa por nomeNorm (candidato mais recente vence nos metadados)
    const pessoas = new Map<
      string,
      { nome: string; cpfMasc: string; chaveFraca: string; anos: number[] }
    >();
    for (const c of candidatos) {
      const nomeNorm = normNome(c.data.nomeNorm ?? c.data.nome);
      if (!nomeNorm) continue;
      const ano = Number(c.data.ano ?? c.data._exercicio) || 0;
      const atual = pessoas.get(nomeNorm);
      if (!atual) {
        pessoas.set(nomeNorm, {
          nome: nomeNorm,
          cpfMasc: str(c.data.cpfMasc),
          chaveFraca: str(c.data.chaveFraca),
          anos: [ano],
        });
      } else {
        if (!atual.anos.includes(ano)) atual.anos.push(ano);
        // chaveFraca/cpfMasc do registro mais recente prevalece
        if (ano >= Math.max(...atual.anos)) {
          if (str(c.data.chaveFraca)) atual.chaveFraca = str(c.data.chaveFraca);
          if (str(c.data.cpfMasc)) atual.cpfMasc = str(c.data.cpfMasc);
        }
      }
    }

    // 5) materializa
    const now = admin.firestore.FieldValue.serverTimestamp();
    let batch = db.batch();
    let nBatch = 0;
    let gravados = 0;
    for (const [nomeNorm, p] of pessoas) {
      // doações: prefere o join forte; se vazio, cai no nome
      const dFortes = p.chaveFraca ? (doacaoPorCf.get(p.chaveFraca) ?? []) : [];
      const dNome = doacaoPorNome.get(nomeNorm) ?? [];
      const dUsadas = dFortes.length ? dFortes : dNome;
      const doou = dUsadas.length
        ? {
            total: Math.round(dUsadas.reduce((s, d) => s + toNum(d.data.valor), 0) * 100) / 100,
            n: dUsadas.length,
            confianca: dFortes.length ? "forte" : "fraca",
            para: dUsadas
              .slice(0, MAX_ITENS)
              .map((d) => ({ candidato: str(d.data.candidato), ano: Number(d.data.ano) || null, valor: toNum(d.data.valor) })),
          }
        : null;

      // sócio: união forte+fraca, dedupe por CNPJ com a MAIOR confiança
      const eFortes = p.chaveFraca ? (socioPorCf.get(p.chaveFraca) ?? []) : [];
      const eNome = socioPorNome.get(nomeNorm) ?? [];
      const porCnpj = new Map<string, EmpresaDoSocio>();
      for (const e of [...eNome, ...eFortes]) porCnpj.set(e.cnpj, e); // forte sobrescreve
      const socio = porCnpj.size
        ? { empresas: [...porCnpj.values()].slice(0, MAX_ITENS * 2) }
        : null;

      const fpf = fornPfPorNome.get(nomeNorm);
      const fornecedorPF = fpf
        ? {
            totalEmpenhado: toNum(fpf.totalEmpenhado),
            nEmpenhos: toNum(fpf.nEmpenhos),
            nContratos: toNum(fpf.nContratos),
            sancionado: fpf.sancionado === true,
            confianca: "fraca" as const,
          }
        : null;

      const movs = movPorNome.get(nomeNorm) ?? [];
      const diariasResumo = movs.length
        ? { n: movs.length, total: Math.round(movs.reduce((s, m) => s + m.valor, 0) * 100) / 100 }
        : null;

      const atos = atoPorNome.get(nomeNorm) ?? [];
      const nomeacoesResumo = atos.length
        ? {
            n: atos.length,
            ultimos: atos.slice(0, 3).map((a) => ({ tipo: str(a.data.tipo), cargo: str(a.data.cargo), data: str(a.data.data) })),
          }
        : null;

      const irregs = contaPorNome.get(nomeNorm) ?? [];
      const contasResumo = irregs.length
        ? {
            n: irregs.length,
            registros: irregs.slice(0, 3).map((c) => ({ processoTC: str(c.data.processoTC), exercicio: str(c.data.exercicio), cpfParcial: str(c.data.cpfParcial) })),
          }
        : null;

      // pessoa sem NENHUMA perna além da candidatura não gera doc (economiza
      // escrita; a ficha mostra a trajetória pelos estáticos do TSE de qualquer jeito)
      if (!doou && !socio && !fornecedorPF && !diariasResumo && !nomeacoesResumo && !contasResumo) continue;

      const personId = `n:${nomeNorm}`;
      const ref = db.collection(COL_SAIDA).doc(docIdDePessoa(personId));
      batch.set(
        ref,
        {
          personId,
          nome: nomeNorm,
          cpfMasc: p.cpfMasc || null,
          anosCandidatura: p.anos.sort((a, b) => b - a),
          doou,
          socio,
          fornecedorPF,
          diarias: diariasResumo,
          nomeacoes: nomeacoesResumo,
          contasIrregulares: contasResumo,
          _v: VERSAO_ESQUEMA,
          _fonte: "cruzamento-pessoas",
          _atualizadoEm: now,
        },
        { merge: false },
      );
      gravados++;
      if (++nBatch >= 400) {
        await batch.commit();
        batch = db.batch();
        nBatch = 0;
      }
    }
    if (nBatch > 0) await batch.commit();

    await gravarSyncState({
      syncId: "cruzamento-pessoas",
      fonte: "cruzamento-pessoas",
      colecao: COL_SAIDA,
      cadencia: "diario",
      sucesso: true,
      erro: null,
      duracaoMs: Date.now() - t0,
      extra: { pessoas: pessoas.size, gravados },
    });
    logger.info(
      `[cruzamento-pessoas] ${gravados}/${pessoas.size} pessoas materializadas em ${Date.now() - t0}ms`,
    );
  },
);
