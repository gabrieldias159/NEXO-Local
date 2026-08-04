/**
 * Detectores do Diário Oficial (DO) — catálogo §11.
 *
 * Dois grupos:
 *  1. Detectores de METADADOS — operam sobre `EdicaoDiarioNorm` (data, volume).
 *  2. Detectores de ATO — operam sobre o TEXTO INTEGRAL (`EdicaoDiarioTexto`),
 *     segmentando a edição em atos e aplicando heurística/regex sobre cada um.
 *
 * Tudo aqui é INDÍCIO a apurar — nunca acusação. CPF de pessoa física é sempre
 * mascarado (LGPD). Ver docs/nexo/02-catalogo-de-monitoramentos.md §11.
 *
 * IMPLEMENTADOS — metadados:
 *  - DO-01 — Ato/edição publicado fora do horário usual (fim de semana ou
 *            feriado nacional fixo).
 *  - DO-03 — Volume anormal de atos numa edição (proxy: tamanho do texto;
 *            corte estatístico média + 2σ).
 *
 * IMPLEMENTADOS — parsing de ato (texto integral):
 *  - DO-02 — Decreto de crédito sem amparo legal citado.
 *  - DO-04 — Republicação/retificação de ato sensível.
 *  - DO-05 — Extrato de contrato sem dados essenciais.
 *  - DO-06 — Composição de comissão de licitação (mapeamento, informativo).
 *  - DO-07 — Fiscal de contrato — mapeamento (informativo).
 *  - DO-08 — Sindicância/PAD aberto.
 *
 * Limitação assumida: o DOM publica os atos como texto corrido, sem marcação
 * estrutural. A segmentação por cabeçalho ("DECRETO Nº", "PORTARIA Nº",
 * "EXTRATO DE CONTRATO" …) é heurística e best-effort — pode partir atos
 * longos ou unir atos curtos. Daí a confiabilidade moderada e a linguagem de
 * indício em todos os detectores de ato.
 */
import type { EdicaoDiarioNorm, EdicaoDiarioTexto } from '../sources/diario';
import type { AlertaDetectado } from './tipos';

/**
 * Feriados nacionais de data FIXA. Feriados móveis (Carnaval, Sexta-Feira
 * Santa, Corpus Christi) e o feriado municipal de Marília não entram — o
 * detector é conservador para não gerar falso indício.
 */
const FERIADOS_FIXOS = new Set([
  '01-01', // Confraternização Universal
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalho
  '09-07', // Independência
  '10-12', // Nossa Senhora Aparecida
  '11-02', // Finados
  '11-15', // Proclamação da República
  '11-20', // Consciência Negra (feriado nacional desde 2024)
  '12-25', // Natal
]);

function chaveMesDia(dataIso: string): string {
  const d = new Date(dataIso);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

const DIA_SEMANA_PT = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
] as const;

function dataPtBR(dataIso: string): string {
  return new Date(dataIso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

/**
 * DO-01 — Edição publicada fora do horário usual.
 *
 * Sinaliza edições do DOM publicadas em sábado, domingo ou feriado nacional
 * fixo. A publicação em dia não-útil não é irregular por si — mas é atípica e
 * pode indicar urgência artificial, tentativa de reduzir visibilidade ou
 * cumprimento de prazo no limite. Indício a apurar.
 */
export function detectarPublicacaoForaDoUsual(
  edicoes: EdicaoDiarioNorm[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const ed of edicoes) {
    const feriado = FERIADOS_FIXOS.has(chaveMesDia(ed.dataIso));
    if (!ed.fimDeSemana && !feriado) continue;

    const motivo = feriado
      ? `feriado nacional (${DIA_SEMANA_PT[ed.diaSemana]})`
      : DIA_SEMANA_PT[ed.diaSemana];
    const data = dataPtBR(ed.dataIso);

    out.push({
      detectorId: 'DO-01',
      detectorNome: 'Ato publicado fora do horário usual',
      categoria: 'Diário Oficial',
      titulo: `Edição ${ed.edicao} do DOM publicada em ${motivo}`,
      descricao:
        `A edição ${ed.edicao} do Diário Oficial foi publicada em ${data} — ` +
        `${motivo}, fora do calendário usual de publicação.` +
        (ed.edicaoExtra ? ' Trata-se de uma edição extra.' : ''),
      sujeitoTipo: 'orgao',
      sujeitoId: ed.id,
      sujeitoRotulo: `DOM edição ${ed.edicao}`,
      classificacao: feriado ? 'atencao' : 'informativo',
      scores: {
        confiabilidade: 88,
        probabilidadeIrregularidade: feriado ? 34 : 22,
      },
      fundamentoLegal: [
        'Princípio da publicidade (CF, art. 37, caput)',
        'Controle interno',
      ],
      evidencias: [
        { resumo: `Data de publicação: ${data} (${motivo})`, data: ed.dataIso },
        { resumo: `Edição ${ed.edicao}${ed.edicaoExtra ? ' (extra)' : ''}` },
        { resumo: `Volume aproximado: ${ed.textChars.toLocaleString('pt-BR')} caracteres` },
      ],
      explicacao:
        'Publicar o Diário Oficial em dia não-útil é incomum e merece verificação: ' +
        'quais atos a edição traz, se havia urgência real e se o prazo de algum ' +
        'procedimento foi cumprido no limite. A atipicidade da data é o indício — ' +
        'não há, por si só, irregularidade.',
      valorEnvolvido: 0,
    });
  }

  return out;
}

/**
 * DO-03 — Volume anormal de atos numa única edição.
 *
 * O catálogo prevê o corte estatístico "nº de atos sensíveis > média + 2σ".
 * Como a fonte de dados-abertos NÃO traz contagem de atos estruturada, este
 * detector usa o tamanho do texto integral (`textChars`) como PROXY de volume
 * — uma edição muito mais densa que a média concentra, em geral, mais atos.
 * O corte é média + 2 desvios-padrão sobre as edições regulares do conjunto.
 *
 * Limitação assumida: o proxy não distingue ato sensível (nomeação, dispensa,
 * aditivo) de ato corriqueiro. A confirmação exige o parsing dos atos — daí a
 * confiabilidade moderada e a linguagem de indício.
 */
export function detectarVolumeAnormal(
  edicoes: EdicaoDiarioNorm[],
): AlertaDetectado[] {
  // Só edições regulares com texto entram na base estatística — edições
  // extras são, por natureza, atípicas e distorceriam a média.
  const base = edicoes.filter((e) => !e.edicaoExtra && e.textChars > 0);
  if (base.length < 8) return []; // amostra pequena demais para média+2σ

  const valores = base.map((e) => e.textChars);
  const n = valores.length;
  const media = valores.reduce((s, v) => s + v, 0) / n;
  const variancia =
    valores.reduce((s, v) => s + (v - media) ** 2, 0) / n;
  const desvio = Math.sqrt(variancia);
  if (desvio === 0) return [];

  const limiar = media + 2 * desvio;
  const out: AlertaDetectado[] = [];

  for (const ed of edicoes) {
    if (ed.textChars <= limiar) continue;
    const sigmas = (ed.textChars - media) / desvio;
    const data = dataPtBR(ed.dataIso);

    out.push({
      detectorId: 'DO-03',
      detectorNome: 'Volume anormal de atos num único DOM',
      categoria: 'Diário Oficial',
      titulo: `Edição ${ed.edicao} do DOM com volume atípico de atos`,
      descricao:
        `A edição ${ed.edicao} (${data}) tem ${ed.textChars.toLocaleString('pt-BR')} ` +
        `caracteres — ${sigmas.toFixed(1)} desvios-padrão acima da média das ` +
        `edições regulares do período (${Math.round(media).toLocaleString('pt-BR')} ` +
        `caracteres). Indício de concentração anormal de atos numa só edição.`,
      sujeitoTipo: 'orgao',
      sujeitoId: ed.id,
      sujeitoRotulo: `DOM edição ${ed.edicao}`,
      classificacao: sigmas >= 3 ? 'suspeita' : 'atencao',
      scores: {
        confiabilidade: 62,
        probabilidadeIrregularidade: Math.min(70, Math.round(36 + sigmas * 8)),
      },
      fundamentoLegal: ['Padrão estatístico (catálogo NEXO §11, DO-03)'],
      evidencias: [
        {
          resumo: `Volume: ${ed.textChars.toLocaleString('pt-BR')} caracteres (proxy de nº de atos)`,
        },
        {
          resumo: `Média das edições regulares: ${Math.round(media).toLocaleString('pt-BR')} caracteres`,
        },
        { resumo: `Desvio: ${sigmas.toFixed(1)}σ acima da média`, data: ed.dataIso },
        { resumo: `Limiar de corte (média + 2σ): ${Math.round(limiar).toLocaleString('pt-BR')}` },
      ],
      explicacao:
        'Edição muito mais densa que o padrão do período pode concentrar um número ' +
        'atípico de atos — nomeações, dispensas, aditivos. O volume é apenas o ' +
        'indício; convém abrir a edição e verificar quais atos a tornam atípica e ' +
        'se há motivo para a concentração. O tamanho do texto é um proxy do número ' +
        'de atos, já que a fonte não fornece contagem estruturada.',
      valorEnvolvido: 0,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSING DE ATOS — base dos detectores DO-02, DO-04..DO-08.
// ─────────────────────────────────────────────────────────────────────────────

/** Um ato segmentado do texto integral de uma edição do DOM. */
export interface AtoDiario {
  /** Cabeçalho que abriu o ato (linha de título, ex.: "DECRETO Nº 12.345"). */
  cabecalho: string;
  /** Texto integral do ato (cabeçalho + corpo até o próximo cabeçalho). */
  texto: string;
}

/**
 * Cabeçalhos de ato reconhecidos. A regex casa o INÍCIO de uma linha; tudo
 * entre um cabeçalho e o próximo vira o corpo do ato. Lista conservadora —
 * abrange os tipos de ato que os detectores DO precisam isolar.
 */
const RE_CABECALHO_ATO =
  /^(?:\s*)((?:DECRETO|PORTARIA|RESOLU[ÇC][ÃA]O|LEI(?:\s+COMPLEMENTAR)?|EDITAL|EXTRATO|AVISO|ATO|ERRATA|RETIFICA[ÇC][ÃA]O|REPUBLICA[ÇC][ÃA]O|TERMO\s+ADITIVO|INSTRU[ÇC][ÃA]O\s+NORMATIVA)\b[^\n]{0,140})$/im;

/**
 * Segmenta o texto integral de uma edição em atos individuais.
 *
 * Heurística: cada linha que parece um cabeçalho de ato (DECRETO Nº, PORTARIA
 * Nº, EXTRATO DE CONTRATO …) abre um novo ato; o corpo vai até o próximo
 * cabeçalho. Texto antes do primeiro cabeçalho é descartado (expediente,
 * sumário). Best-effort — ver a nota de limitação no topo do arquivo.
 */
export function segmentarAtos(textoEdicao: string): AtoDiario[] {
  if (!textoEdicao || !textoEdicao.trim()) return [];
  const linhas = textoEdicao.split(/\r?\n/);
  const atos: AtoDiario[] = [];
  let atual: AtoDiario | null = null;

  for (const linha of linhas) {
    const m = linha.match(RE_CABECALHO_ATO);
    if (m) {
      if (atual) atos.push(atual);
      atual = { cabecalho: m[1].trim(), texto: linha };
    } else if (atual) {
      atual.texto += '\n' + linha;
    }
  }
  if (atual) atos.push(atual);
  return atos;
}

/** Normaliza texto para casamento de regex: maiúsculas, espaços colapsados. */
function up(s: string): string {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Mascara CPF (###.###.###-## ou 11 dígitos) preservando os 3 primeiros e os
 * 2 finais — LGPD. CNPJ (14 dígitos) NÃO é mascarado: é dado de pessoa
 * jurídica, público por natureza nas contratações.
 */
function mascararCpf(s: string): string {
  return s.replace(
    /\b(\d{3})\.?\d{3}\.?(\d{3})[-.]?(\d{2})\b/g,
    (full, a: string, _b: string, d: string) => {
      // Heurística: 14 dígitos seguidos é CNPJ — não mascara.
      const soDigitos = full.replace(/\D/g, '');
      if (soDigitos.length !== 11) return full;
      return `${a}.***.***-${d}`;
    },
  );
}

/** Primeira linha não-vazia de um trecho — usada como rótulo do sujeito. */
function tituloDoAto(ato: AtoDiario): string {
  return mascararCpf(ato.cabecalho).slice(0, 120);
}

/** Identificador estável de um ato dentro da edição (índice + cabeçalho). */
function idAto(ed: EdicaoDiarioTexto, idx: number): string {
  return `${ed.id}_ato${idx}`;
}

// ── DO-02 — Decreto de crédito sem amparo legal citado ───────────────────────

/**
 * DO-02 — Decreto de crédito adicional (suplementar/especial/extraordinário)
 * que não cita a lei autorizativa no corpo do ato.
 *
 * O art. 42 da Lei 4.320/1964 exige que créditos suplementares e especiais
 * sejam autorizados por lei. O decreto que abre o crédito deve referenciar
 * essa lei. A ausência da referência é o indício.
 *
 * Heurística de amparo: procura no corpo menções a "Lei nº", "Lei Municipal",
 * "autorizado pela Lei", "LOA", "Lei Orçamentária". Crédito extraordinário
 * (art. 44) dispensa lei prévia — esses são ignorados.
 */
export function detectarDecretoCreditoSemAmparo(
  edicoes: EdicaoDiarioTexto[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const RE_DECRETO = /^DECRETO\b/;
  const RE_CREDITO = /CR[ÉE]DITO\s+(?:ADICIONAL|SUPLEMENTAR|ESPECIAL)/;
  const RE_EXTRAORDINARIO = /CR[ÉE]DITO\s+(?:ADICIONAL\s+)?EXTRAORDIN[ÁA]RIO/;
  // Referência à lei autorizativa em qualquer forma usual.
  const RE_AMPARO =
    /\bLEI\s*(?:MUNICIPAL\s*)?N[ºO°.\s]|AUTORIZAD[OA]?\s+PELA\s+LEI|LEI\s+OR[ÇC]AMENT|\bLOA\b|LEI\s+COMPLEMENTAR\s+N/;

  for (const ed of edicoes) {
    const atos = segmentarAtos(ed.texto);
    atos.forEach((ato, idx) => {
      const cab = up(ato.cabecalho);
      if (!RE_DECRETO.test(cab)) return;
      const corpo = up(ato.texto);
      if (!RE_CREDITO.test(corpo)) return;
      // Crédito extraordinário é aberto por decreto sem lei prévia (CF art.
      // 167 §3º; Lei 4.320 art. 44) — não é indício.
      if (RE_EXTRAORDINARIO.test(corpo)) return;
      if (RE_AMPARO.test(corpo)) return; // amparo citado — ok

      out.push({
        detectorId: 'DO-02',
        detectorNome: 'Decreto de crédito sem amparo legal citado',
        categoria: 'Diário Oficial',
        titulo: `Decreto de crédito adicional sem lei autorizativa citada — ${tituloDoAto(ato)}`,
        descricao:
          `A edição ${ed.edicao} do DOM (${dataPtBR(ed.dataIso)}) traz um ` +
          'decreto de abertura de crédito adicional cujo texto não cita a lei ' +
          'autorizativa. Crédito suplementar/especial exige autorização legal ' +
          '(Lei 4.320/1964, art. 42).',
        sujeitoTipo: 'orgao',
        sujeitoId: idAto(ed, idx),
        sujeitoRotulo: `DOM ed. ${ed.edicao} — ${tituloDoAto(ato)}`,
        classificacao: 'atencao',
        scores: { confiabilidade: 58, probabilidadeIrregularidade: 44 },
        fundamentoLegal: [
          'Lei 4.320/1964, arts. 42–43',
          'CF, art. 167, V e VI',
        ],
        evidencias: [
          { resumo: `Cabeçalho do ato: ${tituloDoAto(ato)}`, data: ed.dataIso },
          { resumo: `Edição ${ed.edicao} do DOM`, ref: ed.id },
          { resumo: 'Nenhuma referência a "Lei nº" autorizativa localizada no texto' },
        ],
        explicacao:
          'O detector procura, no corpo do decreto de crédito, a citação da lei ' +
          'que autorizou a abertura. A ausência da referência pode ser apenas ' +
          'omissão de redação — ou crédito aberto sem amparo legal. É indício a ' +
          'apurar: convém localizar a lei autorizativa correspondente. Crédito ' +
          'extraordinário, que dispensa lei prévia, é excluído da detecção.',
        valorEnvolvido: 0,
      });
    });
  }
  return out;
}

// ── DO-04 — Republicação/retificação de ato sensível ─────────────────────────

/**
 * DO-04 — Retificação, republicação ou errata de ato sensível (extrato de
 * contrato, dispensa/inexigibilidade, nomeação/exoneração, aditivo).
 *
 * Retificar um ato após a publicação é legítimo, mas atos sensíveis
 * retificados merecem conferência: a retificação pode mudar valor, prazo,
 * fornecedor ou beneficiário. O indício é a retificação de ato sensível.
 */
export function detectarRetificacaoAtoSensivel(
  edicoes: EdicaoDiarioTexto[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const RE_RETIFICA = /RETIFICA|REPUBLICA|ERRATA/;
  const RE_SENSIVEL =
    /CONTRATO|ADITIVO|DISPENSA|INEXIGIBILIDADE|NOMEA[ÇC]|EXONERA[ÇC]|LICITA[ÇC]|EXTRATO|PREG[ÃA]O|CONCORR[ÊE]NCIA|EMPENHO/;

  for (const ed of edicoes) {
    const atos = segmentarAtos(ed.texto);
    atos.forEach((ato, idx) => {
      const cab = up(ato.cabecalho);
      const corpo = up(ato.texto);
      // O cabeçalho indica retificação OU a 1ª linha do corpo a anuncia.
      const ehRetificacao =
        RE_RETIFICA.test(cab) || RE_RETIFICA.test(corpo.slice(0, 200));
      if (!ehRetificacao) return;
      if (!RE_SENSIVEL.test(corpo)) return;

      out.push({
        detectorId: 'DO-04',
        detectorNome: 'Republicação/retificação de ato sensível',
        categoria: 'Diário Oficial',
        titulo: `Retificação de ato sensível no DOM — ${tituloDoAto(ato)}`,
        descricao:
          `A edição ${ed.edicao} do DOM (${dataPtBR(ed.dataIso)}) retifica ou ` +
          'republica um ato sensível (contrato, dispensa, nomeação ou ' +
          'aditivo). Retificações de atos sensíveis devem ser conferidas — ' +
          'podem alterar valor, prazo, fornecedor ou beneficiário.',
        sujeitoTipo: 'orgao',
        sujeitoId: idAto(ed, idx),
        sujeitoRotulo: `DOM ed. ${ed.edicao} — ${tituloDoAto(ato)}`,
        classificacao: 'informativo',
        scores: { confiabilidade: 64, probabilidadeIrregularidade: 28 },
        fundamentoLegal: ['Princípio da publicidade (CF, art. 37, caput)'],
        evidencias: [
          { resumo: `Ato retificado: ${tituloDoAto(ato)}`, data: ed.dataIso },
          { resumo: `Edição ${ed.edicao} do DOM`, ref: ed.id },
        ],
        explicacao:
          'Retificar um ato é legítimo e comum. O detector apenas sinaliza que ' +
          'um ato SENSÍVEL foi retificado, para que se confira o que mudou em ' +
          'relação à publicação original — sobretudo valor, prazo, fornecedor ou ' +
          'beneficiário. Não há, por si, irregularidade; é um ponto de conferência.',
        valorEnvolvido: 0,
      });
    });
  }
  return out;
}

// ── DO-05 — Extrato de contrato sem dados essenciais ─────────────────────────

/**
 * DO-05 — Extrato de contrato/aditivo publicado sem um dado essencial:
 * objeto, valor, prazo/vigência ou contratado.
 *
 * O art. 94 da Lei 14.133/2021 e a LC 131/2009 exigem publicidade dos
 * elementos do contrato. Um extrato que omite objeto, valor, prazo ou
 * fornecedor frustra o controle social. O indício é a omissão.
 */
export function detectarExtratoSemDadosEssenciais(
  edicoes: EdicaoDiarioTexto[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const RE_EXTRATO = /EXTRATO\s+(?:DE\s+)?(?:CONTRATO|ADITIVO|TERMO)/;
  const RE_OBJETO = /\bOBJETO\b/;
  const RE_VALOR = /\bVALOR\b|R\$\s?\d/;
  const RE_PRAZO = /VIG[ÊE]NCIA|PRAZO|VIGENTE|IN[ÍI]CIO/;
  const RE_CONTRATADO =
    /CONTRATAD[OA]|CONTRATADA?:|EMPRESA|RAZ[ÃA]O SOCIAL|CNPJ/;

  for (const ed of edicoes) {
    const atos = segmentarAtos(ed.texto);
    atos.forEach((ato, idx) => {
      const cab = up(ato.cabecalho);
      const corpo = up(ato.texto);
      // É um extrato de contrato/aditivo?
      if (!RE_EXTRATO.test(cab) && !RE_EXTRATO.test(corpo.slice(0, 160))) return;

      // Guarda anti-falso-positivo: corpo curto demais é provável erro de
      // segmentação (ato mal partido), não um extrato real. Só avalia omissão
      // num corpo com substância.
      if (corpo.length < 160) return;

      const faltando: string[] = [];
      if (!RE_OBJETO.test(corpo)) faltando.push('objeto');
      if (!RE_VALOR.test(corpo)) faltando.push('valor');
      if (!RE_PRAZO.test(corpo)) faltando.push('prazo/vigência');
      if (!RE_CONTRATADO.test(corpo)) faltando.push('contratado');
      // Um único campo "ausente" é ruído frequente da heurística — só sinaliza
      // omissão consistente (≥2 campos essenciais ausentes).
      if (faltando.length < 2) return;

      out.push({
        detectorId: 'DO-05',
        detectorNome: 'Extrato de contrato sem dados essenciais',
        categoria: 'Diário Oficial',
        titulo: `Extrato de contrato sem ${faltando.join(', ')} — DOM ed. ${ed.edicao}`,
        descricao:
          `A edição ${ed.edicao} do DOM (${dataPtBR(ed.dataIso)}) publica um ` +
          `extrato de contrato/aditivo sem ${faltando.join(', ')}. O extrato ` +
          'deve trazer objeto, valor, prazo e contratado para cumprir o dever ' +
          'de publicidade.',
        sujeitoTipo: 'contrato',
        sujeitoId: idAto(ed, idx),
        sujeitoRotulo: `DOM ed. ${ed.edicao} — ${tituloDoAto(ato)}`,
        classificacao: faltando.length >= 3 ? 'atencao' : 'informativo',
        scores: {
          confiabilidade: 55,
          probabilidadeIrregularidade: Math.min(55, 22 + faltando.length * 10),
        },
        fundamentoLegal: [
          'Lei 14.133/2021, art. 94',
          'LC 131/2009 (Lei da Transparência)',
        ],
        evidencias: [
          { resumo: `Campos essenciais ausentes: ${faltando.join(', ')}`, data: ed.dataIso },
          { resumo: `Edição ${ed.edicao} do DOM`, ref: ed.id },
        ],
        explicacao:
          'O detector segmenta os extratos de contrato/aditivo e verifica a ' +
          'presença de objeto, valor, prazo/vigência e contratado. A ausência ' +
          'pode ser falha de redação do extrato ou omissão que dificulta o ' +
          'controle. A segmentação é heurística — um campo "ausente" pode estar ' +
          'em ato vizinho mal partido; é indício a conferir na edição.',
        valorEnvolvido: 0,
      });
    });
  }
  return out;
}

// ── DO-06 — Composição de comissão de licitação (mapeamento) ─────────────────

/**
 * DO-06 — MAPEAMENTO. Extrai portarias de nomeação de comissão de licitação,
 * comissão de contratação ou agente de contratação/pregoeiro.
 *
 * Não é detector de irregularidade — é INSUMO para o cruzamento XS-01 (membro
 * de comissão sócio de empresa vencedora). Gera alerta INFORMATIVO de
 * severidade mínima. CPF de pessoa física é mascarado (LGPD).
 */
export function mapearComissaoLicitacao(
  edicoes: EdicaoDiarioTexto[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const RE_PORTARIA = /^(?:PORTARIA|DECRETO|RESOLU[ÇC][ÃA]O)\b/;
  const RE_COMISSAO =
    /COMISS[ÃA]O\s+(?:PERMANENTE\s+|ESPECIAL\s+)?DE\s+LICITA[ÇC][ÃA]O|COMISS[ÃA]O\s+DE\s+CONTRATA[ÇC][ÃA]O|AGENTE\s+DE\s+CONTRATA[ÇC][ÃA]O|PREGOEIR[OA]/;
  const RE_NOMEACAO = /NOMEAR|DESIGNAR|CONSTITUIR|INSTITUIR/;

  for (const ed of edicoes) {
    const atos = segmentarAtos(ed.texto);
    atos.forEach((ato, idx) => {
      const cab = up(ato.cabecalho);
      const corpo = up(ato.texto);
      if (!RE_PORTARIA.test(cab)) return;
      if (!RE_COMISSAO.test(corpo)) return;
      if (!RE_NOMEACAO.test(corpo)) return;

      out.push({
        detectorId: 'DO-06',
        detectorNome: 'Composição de comissão de licitação',
        categoria: 'Diário Oficial',
        titulo: `Nomeação de comissão de licitação/contratação — DOM ed. ${ed.edicao}`,
        descricao:
          `A edição ${ed.edicao} do DOM (${dataPtBR(ed.dataIso)}) traz portaria ` +
          'de nomeação de comissão de licitação, comissão de contratação ou ' +
          'agente de contratação/pregoeiro. Registro de mapeamento — insumo para ' +
          'o cruzamento XS-01.',
        sujeitoTipo: 'servidor',
        sujeitoId: idAto(ed, idx),
        sujeitoRotulo: `DOM ed. ${ed.edicao} — ${tituloDoAto(ato)}`,
        classificacao: 'informativo',
        scores: { confiabilidade: 70, probabilidadeIrregularidade: 5 },
        fundamentoLegal: ['Lei 14.133/2021, arts. 7º–8º'],
        evidencias: [
          { resumo: `Portaria mapeada: ${tituloDoAto(ato)}`, data: ed.dataIso },
          { resumo: `Edição ${ed.edicao} do DOM`, ref: ed.id },
          {
            resumo:
              'Trecho (CPF mascarado): ' +
              mascararCpf(ato.texto).replace(/\s+/g, ' ').trim().slice(0, 240),
          },
        ],
        explicacao:
          'Este registro NÃO é uma acusação — é o mapeamento da composição de ' +
          'comissões de licitação publicada no DOM. Serve de insumo para o ' +
          'cruzamento XS-01, que verifica se algum membro de comissão é sócio de ' +
          'empresa vencedora. Os nomes ficam no texto da portaria; CPF de pessoa ' +
          'física é mascarado conforme a LGPD.',
        valorEnvolvido: 0,
      });
    });
  }
  return out;
}

// ── DO-07 — Fiscal de contrato — mapeamento ──────────────────────────────────

/**
 * DO-07 — MAPEAMENTO. Extrai portarias de designação de fiscal/gestor de
 * contrato. Insumo para SA-12 (mesmo fiscal atestando volume anormal).
 * Alerta INFORMATIVO de severidade mínima. CPF mascarado (LGPD).
 */
export function mapearFiscalContrato(
  edicoes: EdicaoDiarioTexto[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const RE_PORTARIA = /^(?:PORTARIA|DECRETO)\b/;
  const RE_FISCAL =
    /FISCAL\s+(?:DE\s+|DO\s+)?CONTRATO|FISCALIZA[ÇC][ÃA]O\s+(?:DO\s+|DE\s+)?CONTRATO|GESTOR\s+(?:DE\s+|DO\s+)?CONTRATO/;
  const RE_DESIGNACAO = /DESIGNAR|NOMEAR|ATRIBUIR/;

  for (const ed of edicoes) {
    const atos = segmentarAtos(ed.texto);
    atos.forEach((ato, idx) => {
      const cab = up(ato.cabecalho);
      const corpo = up(ato.texto);
      if (!RE_PORTARIA.test(cab)) return;
      if (!RE_FISCAL.test(corpo)) return;
      if (!RE_DESIGNACAO.test(corpo)) return;

      out.push({
        detectorId: 'DO-07',
        detectorNome: 'Fiscal de contrato — mapeamento',
        categoria: 'Diário Oficial',
        titulo: `Designação de fiscal de contrato — DOM ed. ${ed.edicao}`,
        descricao:
          `A edição ${ed.edicao} do DOM (${dataPtBR(ed.dataIso)}) traz portaria ` +
          'de designação de fiscal ou gestor de contrato. Registro de ' +
          'mapeamento — insumo para o detector SA-12.',
        sujeitoTipo: 'servidor',
        sujeitoId: idAto(ed, idx),
        sujeitoRotulo: `DOM ed. ${ed.edicao} — ${tituloDoAto(ato)}`,
        classificacao: 'informativo',
        scores: { confiabilidade: 70, probabilidadeIrregularidade: 5 },
        fundamentoLegal: ['Lei 14.133/2021, art. 117'],
        evidencias: [
          { resumo: `Portaria mapeada: ${tituloDoAto(ato)}`, data: ed.dataIso },
          { resumo: `Edição ${ed.edicao} do DOM`, ref: ed.id },
          {
            resumo:
              'Trecho (CPF mascarado): ' +
              mascararCpf(ato.texto).replace(/\s+/g, ' ').trim().slice(0, 240),
          },
        ],
        explicacao:
          'Este registro NÃO é uma acusação — é o mapeamento das designações de ' +
          'fiscais de contrato publicadas no DOM. Serve de insumo para o SA-12, ' +
          'que monitora se um único fiscal atesta um volume anormal de ' +
          'liquidações. CPF de pessoa física é mascarado conforme a LGPD.',
        valorEnvolvido: 0,
      });
    });
  }
  return out;
}

// ── DO-08 — Sindicância/PAD aberto ───────────────────────────────────────────

/**
 * DO-08 — Detecta a publicação de instauração de sindicância ou processo
 * administrativo disciplinar (PAD).
 *
 * A abertura de sindicância/PAD é um sinal de que a própria administração
 * identificou possível irregularidade. É informação relevante para o NEXO
 * cruzar com seus demais indícios. Apenas a INSTAURAÇÃO é detectada — não
 * julgamentos, penalidades nem nomes de envolvidos (LGPD).
 */
export function detectarSindicanciaPad(
  edicoes: EdicaoDiarioTexto[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const RE_ATO = /^(?:PORTARIA|DECRETO|ATO|RESOLU[ÇC][ÃA]O|EDITAL)\b/;
  const RE_PAD =
    /PROCESSO\s+ADMINISTRATIVO\s+DISCIPLINAR|\bSINDIC[ÂA]NCIA\b|\bP\.?A\.?D\.?\b/;
  const RE_INSTAURACAO =
    /INSTAURAR|INSTAURA[ÇC][ÃA]O|ABERTURA|ABRIR|CONSTITUIR\s+COMISS[ÃA]O\s+(?:PROCESSANTE|DE\s+SINDIC)/;

  for (const ed of edicoes) {
    const atos = segmentarAtos(ed.texto);
    atos.forEach((ato, idx) => {
      const cab = up(ato.cabecalho);
      const corpo = up(ato.texto);
      if (!RE_ATO.test(cab)) return;
      if (!RE_PAD.test(corpo)) return;
      if (!RE_INSTAURACAO.test(corpo)) return;

      const ehPad = /PROCESSO\s+ADMINISTRATIVO\s+DISCIPLINAR|\bP\.?A\.?D\.?\b/.test(
        corpo,
      );
      out.push({
        detectorId: 'DO-08',
        detectorNome: 'Sindicância/PAD aberto',
        categoria: 'Diário Oficial',
        titulo: `Instauração de ${ehPad ? 'PAD' : 'sindicância'} publicada no DOM — ed. ${ed.edicao}`,
        descricao:
          `A edição ${ed.edicao} do DOM (${dataPtBR(ed.dataIso)}) publica a ` +
          `instauração de ${ehPad ? 'processo administrativo disciplinar' : 'sindicância'}. ` +
          'A própria administração identificou possível irregularidade a apurar.',
        sujeitoTipo: 'orgao',
        sujeitoId: idAto(ed, idx),
        sujeitoRotulo: `DOM ed. ${ed.edicao} — ${tituloDoAto(ato)}`,
        classificacao: 'atencao',
        scores: { confiabilidade: 76, probabilidadeIrregularidade: 30 },
        fundamentoLegal: [
          'Estatuto dos servidores públicos do Município',
          'Lei 8.112/1990 (referência geral de PAD)',
        ],
        evidencias: [
          { resumo: `Ato de instauração: ${tituloDoAto(ato)}`, data: ed.dataIso },
          { resumo: `Edição ${ed.edicao} do DOM`, ref: ed.id },
        ],
        explicacao:
          'A instauração de sindicância ou PAD significa que a administração já ' +
          'abriu uma apuração interna — não há conclusão de culpa. O NEXO ' +
          'registra o fato para cruzar com seus demais indícios (mesmo objeto, ' +
          'mesma secretaria, mesmo fornecedor). Nomes de servidores envolvidos ' +
          'não são extraídos, em respeito à LGPD e à presunção de inocência.',
        valorEnvolvido: 0,
      });
    });
  }
  return out;
}

/**
 * Runner — detectores de METADADOS (DO-01, DO-03). Operam sobre todas as
 * edições normalizadas, sem texto integral.
 */
export function analisarDiario(edicoes: EdicaoDiarioNorm[]): AlertaDetectado[] {
  return [
    ...detectarPublicacaoForaDoUsual(edicoes),
    ...detectarVolumeAnormal(edicoes),
  ].sort(
    (a, b) =>
      b.scores.probabilidadeIrregularidade - a.scores.probabilidadeIrregularidade,
  );
}

/**
 * Runner — detectores de ATO (DO-02, DO-04..DO-08). Operam sobre o texto
 * integral das edições do exercício. Ordena por probabilidade desc.
 */
export function analisarAtosDiario(
  edicoes: EdicaoDiarioTexto[],
): AlertaDetectado[] {
  return [
    ...detectarDecretoCreditoSemAmparo(edicoes),
    ...detectarRetificacaoAtoSensivel(edicoes),
    ...detectarExtratoSemDadosEssenciais(edicoes),
    ...mapearComissaoLicitacao(edicoes),
    ...mapearFiscalContrato(edicoes),
    ...detectarSindicanciaPad(edicoes),
  ].sort(
    (a, b) =>
      b.scores.probabilidadeIrregularidade - a.scores.probabilidadeIrregularidade,
  );
}

/** IDs dos detectores DO de ATO implementados — para a rota informar cobertura. */
export const DETECTORES_DO_ATO = [
  { id: 'DO-02', nome: 'Decreto de crédito sem amparo legal citado' },
  { id: 'DO-04', nome: 'Republicação/retificação de ato sensível' },
  { id: 'DO-05', nome: 'Extrato de contrato sem dados essenciais' },
  { id: 'DO-06', nome: 'Composição de comissão de licitação' },
  { id: 'DO-07', nome: 'Fiscal de contrato — mapeamento' },
  { id: 'DO-08', nome: 'Sindicância/PAD aberto' },
] as const;
