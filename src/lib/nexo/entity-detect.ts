/**
 * NEXO — Detecção de documentos (CNPJ/CPF/RG) em texto livre.
 *
 * Função PURA (sem React, sem rede, sem DOM) que varre uma string e devolve os
 * SEGMENTOS detectados: trechos crus de texto intercalados com os documentos
 * reconhecidos. É a base do entity-chip universal — o componente client
 * (`entity-text.tsx`) consome estes segmentos e renderiza chip/HoverCard só nos
 * que forem `tipo !== 'texto'`.
 *
 * ── O QUE DETECTA ─────────────────────────────────────────────────────────────
 *   • CNPJ — 14 dígitos (formatado `00.000.000/0000-00` ou contínuo). VALIDADO
 *     por Módulo 11 via `docValido` de `entidades.ts` (NÃO re-implementamos a
 *     validação — fonte única da verdade). Só CNPJ válido vira chip investigável.
 *   • CPF  — 11 dígitos. VALIDADO por Módulo 11. Mascarado por design (LGPD).
 *   • RG   — APENAS destaca a presença, NUNCA resolve a dado pessoal nem oferece
 *     link/busca. Guardrail LGPD: RG não é público por LAI (ver §5.1 do design,
 *     "RG: NÃO detectar, NÃO destacar, NÃO oferecer busca"). Aqui o tratamos como
 *     `tipo:'rg'` com `valido:false` e SEM `doc` — o componente o renderiza
 *     mascarado/neutro, jamais como entidade clicável. É a salvaguarda explícita.
 *
 * ── POR QUE VALIDAR (anti-lixo) ──────────────────────────────────────────────
 * Texto de empenho/DOM/contrato está cheio de número que PARECE doc e não é:
 * código interno do TCE (6 dígitos), nº de processo, protocolo. A regex pesca o
 * candidato; o Módulo 11 (`docValido`) descarta o lixo numérico — só sobe a chip
 * o que tem dígito verificador correto. Sem isso, o chip viraria ruído.
 *
 * ── DESEMPENHO ───────────────────────────────────────────────────────────────
 * Uma única passada por `regex.exec` (regex global, índice preservado), O(n) no
 * tamanho do texto. Sem alocação por caractere. Memoização por string fica a
 * cargo do consumidor (o componente memoiza por nó de texto).
 */
import { docValido, soDigitos } from './entidades';

/** Tipo do segmento detectado. `texto` é o trecho cru entre documentos. */
export type TipoSegmento = 'texto' | 'cnpj' | 'cpf' | 'rg';

/**
 * Um pedaço do texto original. Concatenar `texto` de todos os segmentos, na
 * ordem, reconstrói a string de entrada VERBATIM (nenhum caractere é perdido) —
 * por isso o componente pode renderizar sem alterar o conteúdo exibido.
 */
export interface SegmentoEntidade {
  /** Trecho EXATO do texto original que este segmento representa. */
  texto: string;
  /** Classe do segmento. `texto` = trecho comum; o resto = documento detectado. */
  tipo: TipoSegmento;
  /**
   * Só os dígitos do documento (CNPJ/CPF). VAZIO para `tipo:'texto'` e para
   * `tipo:'rg'` — RG nunca expõe os dígitos (guardrail LGPD). Para CPF, contém
   * os 11 dígitos crus (uso server-side de cruzamento via hash); o componente
   * NUNCA renderiza isto direto — sempre mascara.
   */
  doc: string;
  /** true só quando o doc passou no Módulo 11 (`docValido`). RG é sempre false. */
  valido: boolean;
}

/**
 * Regex de CANDIDATOS a documento. Pesca, na ordem de prioridade:
 *   1. CNPJ formatado: `00.000.000/0000-00`
 *   2. CPF formatado:  `000.000.000-00`
 *   3. CNPJ contínuo:  14 dígitos
 *   4. CPF contínuo:   11 dígitos
 *   5. RG paulista:    `00.000.000-X` (8 díg + dígito/‘X’) — só p/ DESTAQUE.
 *
 * `\b`/lookarounds evitam casar no meio de um número maior (ex.: não pesca 11
 * dígitos dentro de um protocolo de 15). A ordem importa: alternativas mais
 * específicas/longas vêm primeiro para o motor preferir o casamento maior.
 * Flag `g` para varrer todas as ocorrências preservando `lastIndex`.
 */
const RE_DOC =
  /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|(?<!\d)\d{14}(?!\d)|\b\d{2}\.\d{3}\.\d{3}-[\dxX]\b|(?<!\d)\d{11}(?!\d)/g;

/** true se o trecho casado tem cara de RG paulista (8 díg + verificador). */
function pareceRg(trecho: string): boolean {
  // `00.000.000-0` / `00.000.000-X`: 9 caracteres significativos, dígito final
  // pode ser X. Distinto de CPF (que sempre tem 11 díg) e de CNPJ.
  return /^\d{2}\.\d{3}\.\d{3}-[\dxX]$/.test(trecho);
}

/**
 * Classifica um trecho candidato em segmento tipado. Resolve a ambiguidade
 * dígitos-puros (11 = CPF, 14 = CNPJ) pelo tamanho e valida por Módulo 11.
 * Candidato que NÃO valida vira `texto` (volta a ser trecho cru — não polui a
 * UI com chip de lixo numérico).
 */
function classificar(trecho: string): SegmentoEntidade {
  // RG: APENAS destaca; nunca resolve, nunca valida, nunca expõe dígitos.
  if (pareceRg(trecho)) {
    return { texto: trecho, tipo: 'rg', doc: '', valido: false };
  }

  const dig = soDigitos(trecho);
  const valido = docValido(dig);
  if (dig.length === 14 && valido) {
    return { texto: trecho, tipo: 'cnpj', doc: dig, valido: true };
  }
  if (dig.length === 11 && valido) {
    return { texto: trecho, tipo: 'cpf', doc: dig, valido: true };
  }
  // Candidato com dígito verificador errado (lixo do TCE/protocolo) → texto cru.
  return { texto: trecho, tipo: 'texto', doc: '', valido: false };
}

/**
 * Varre `texto` e devolve os segmentos na ordem original. Concatenar os campos
 * `texto` reconstrói a entrada exata. Texto vazio/nulo → um único segmento
 * `texto` vazio (o consumidor renderiza nada). NÃO altera o conteúdo: só fatia.
 */
export function detectarEntidades(texto: string | null | undefined): SegmentoEntidade[] {
  const s = texto ?? '';
  if (!s) return [{ texto: '', tipo: 'texto', doc: '', valido: false }];

  const segmentos: SegmentoEntidade[] = [];
  let ultimoFim = 0;
  // Regex com flag `g` é stateful (lastIndex). Recriamos a cada chamada para a
  // função ser PURA/reentrante (sem estado compartilhado entre invocações).
  const re = new RegExp(RE_DOC.source, 'g');

  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const trecho = m[0];
    const inicio = m.index;
    const seg = classificar(trecho);

    // Candidato que não virou documento (lixo): deixa fluir como texto — não
    // corta o segmento, o trecho continua dentro do bloco de texto corrente.
    if (seg.tipo === 'texto') continue;

    // Texto cru ANTES do documento.
    if (inicio > ultimoFim) {
      segmentos.push({
        texto: s.slice(ultimoFim, inicio),
        tipo: 'texto',
        doc: '',
        valido: false,
      });
    }
    segmentos.push(seg);
    ultimoFim = inicio + trecho.length;
  }

  // Cauda de texto cru depois do último documento (ou o texto inteiro, se nada
  // foi detectado).
  if (ultimoFim < s.length) {
    segmentos.push({
      texto: s.slice(ultimoFim),
      tipo: 'texto',
      doc: '',
      valido: false,
    });
  }

  // Texto sem nenhum documento: garante ao menos um segmento (o texto inteiro).
  if (segmentos.length === 0) {
    return [{ texto: s, tipo: 'texto', doc: '', valido: false }];
  }
  return segmentos;
}

/** true se o texto contém ao menos um CNPJ/CPF válido (atalho p/ o consumidor). */
export function temEntidade(texto: string | null | undefined): boolean {
  return detectarEntidades(texto).some(
    (seg) => (seg.tipo === 'cnpj' || seg.tipo === 'cpf') && seg.valido,
  );
}
