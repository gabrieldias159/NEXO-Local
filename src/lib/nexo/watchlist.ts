'use client';

/**
 * NEXO — VIGILÂNCIA (watchlist): alvos que o usuário escolhe acompanhar.
 *
 * Um doc por usuário em `nexo_watchlist/{uid}` (as `firestore.rules` liberam RW
 * só do próprio doc — dado pessoal de curadoria, não compartilhado). Um MAP em
 * vez de array p/ toggle O(1) e merge atômico:
 *   { itens: { [chave]: { alvoTipo, alvoId, rotulo, criadoEm } }, atualizadoEm }
 * onde `chave = ${alvoTipo}:${alvoId}`.
 *
 * Escrita CLIENT-side (Firestore SDK) — instantânea/otimista e em tempo real
 * (a página lê com `useDoc`). Mesmo padrão de `src/lib/acervo/interacoes.ts`.
 *
 * GUARDRAIL LGPD: a watchlist guarda só INDÍCIOS A APURAR (dados públicos —
 * CNPJ, órgão, nº de processo). Para pessoa física, mantenha o CPF MASCARADO no
 * `rotulo` (nunca o número cru) — quem escreve aqui é responsável por isso.
 *
 * Helpers exportados p/ que outras telas (Empenhos, Fornecedores, Processos…)
 * possam adicionar um botão "Vigiar" sem reimplementar o write.
 */
import { doc, setDoc, deleteField, type Firestore } from 'firebase/firestore';

/** Tipos de alvo que se pode vigiar. */
export type AlvoTipo = 'fornecedor' | 'orgao' | 'processo';

/** Um item da watchlist (forma persistida sob `itens.{chave}`). */
export interface ItemVigiado {
  alvoTipo: AlvoTipo;
  /** Identificador estável do alvo (CNPJ p/ fornecedor, slug/código p/ órgão, nº p/ processo). */
  alvoId: string;
  /** Rótulo legível mostrado na lista (razão social, nome do órgão, nº do processo). */
  rotulo: string;
  /** ISO de quando foi adicionado. */
  criadoEm: string;
}

/** Forma do doc `nexo_watchlist/{uid}` (campos podem faltar em doc novo). */
export interface WatchlistDoc {
  itens?: Record<string, ItemVigiado>;
  atualizadoEm?: string;
}

/** Item da watchlist já com a `chave` resolvida — pronto p/ a UI iterar. */
export interface VigiadoDerivado extends ItemVigiado {
  chave: string;
}

/** Monta a chave estável de um alvo: `${alvoTipo}:${alvoId}`. */
export function chaveDe(alvoTipo: AlvoTipo, alvoId: string): string {
  return `${alvoTipo}:${alvoId}`;
}

/**
 * Deriva um array de itens vigiados (com `chave`) a partir do doc bruto,
 * tolerante a campos ausentes. Ordena por `criadoEm` DESC (mais recente 1º) —
 * cronológico decrescente, padrão das telas do NEXO.
 */
export function derivarVigiados(d: WatchlistDoc | null | undefined): VigiadoDerivado[] {
  if (!d?.itens) return [];
  const arr: VigiadoDerivado[] = [];
  for (const [chave, it] of Object.entries(d.itens)) {
    if (!it) continue;
    arr.push({ chave, ...it });
  }
  arr.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  return arr;
}

function ref(db: Firestore, uid: string) {
  return doc(db, 'nexo_watchlist', uid);
}

/**
 * Liga/desliga a vigilância de um alvo em UM único write. `setDoc(merge)` cria o
 * doc se não existir e só toca `itens.{chave}` (deleteField p/ remover) — um
 * write só (não dois) → sem flicker/round-trip duplo. Mesmo padrão de
 * `definirSelecionada` do acervo.
 *
 * @param item alvo a vigiar; `criadoEm` é opcional (preenchido se faltar).
 * @param on   true = vigiar; false = remover da watchlist.
 */
export async function definirVigiado(
  db: Firestore,
  uid: string,
  item: Pick<ItemVigiado, 'alvoTipo' | 'alvoId' | 'rotulo'> & { criadoEm?: string },
  on: boolean,
): Promise<void> {
  const chave = chaveDe(item.alvoTipo, item.alvoId);
  const valor: ItemVigiado = {
    alvoTipo: item.alvoTipo,
    alvoId: item.alvoId,
    rotulo: item.rotulo,
    criadoEm: item.criadoEm ?? new Date().toISOString(),
  };
  await setDoc(
    ref(db, uid),
    {
      itens: { [chave]: on ? valor : deleteField() },
      atualizadoEm: new Date().toISOString(),
    },
    { merge: true },
  );
}
